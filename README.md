# Search Typeahead

A low-latency search-suggestion service: prefix lookup over ~100k queries,
distributed in-memory cache fronting a SQLite primary store, consistent
hashing for cache routing, recency-aware ranking, and batched writes so the
DB is hit ~10× less than naïve.

```
                ┌────────────────────────────────┐
   browser ──►  │  Express                       │
   (debounce)   │   GET  /suggest?q=<prefix>     │
                │   POST /search                 │
                │   GET  /trending               │
                │   GET  /cache/debug            │
                │   GET  /stats                  │
                └────────────────────────────────┘
                          │            ▲
                  miss    │            │ hit
                          ▼            │
                ┌───────────────────────────────┐
                │  DistributedCache (in-proc)   │
                │  consistent-hash ring → N LRU │
                │  prefix → top-10 suggestions  │
                └───────────────────────────────┘
                          │
                          ▼
                ┌──────────────────────────────┐
                │  Prefix Trie (in memory)     │
                │  each node caches top-K      │
                │  built from DB snapshot      │
                └──────────────────────────────┘
                          ▲
                          │ rebuild on each batch flush
                ┌──────────────────────────────┐
                │  SQLite (data/store.db)      │
                │  (query, count, recent, ts)  │
                └──────────────────────────────┘
                          ▲
                          │ one transaction per flush
                ┌──────────────────────────────┐
                │  BatchWriter                 │
                │  in-memory aggregation       │
                │  flush every 2s or 500 rows  │
                └──────────────────────────────┘
```

## Quickstart

```bash
npm install
npm run seed       # generates ~100k queries → data/store.db + data/queries.csv
npm start          # http://localhost:3000
npm run bench      # in another shell: latency + cache + batcher report
```

Open `http://localhost:3000`, start typing. The dropdown updates as you type
(debounced 140 ms); each result row shows the latency, which cache node
served the request, and whether it was a hit or miss.

## Dataset

Synthetic 100,500-query dataset with **Zipfian counts** (`c_i = K / i^s`,
`s = 1.05`) — that's what real search distributions look like and what
actually stresses a cache (a heavy head plus a long tail).

Stems are realistic (tech products, programming topics, infra, news, sports,
food, finance, ML) combined with common suffix words. The format matches the
spec exactly:

```
query,count
iphone,508914
react,394521
…
```

To use your own dataset:

```bash
node scripts/generate-data.js --csv path/to/your.csv
```

CSV needs a header row `query,count` (extra columns ignored).

## API

| API                              | Returns                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `GET  /suggest?q=<prefix>`       | up to 10 suggestions sorted by score, + `nodeId`, `hit`, `latencyMs` |
| `POST /search` body `{"q":"…"}`  | `{ "message": "Searched", "q": "…" }` and queues a count update |
| `GET  /trending?limit=10`        | top queries by decayed recent score                            |
| `GET  /cache/debug?prefix=<p>`   | which cache node owns the prefix, current hit/miss, full report |
| `GET  /cache/debug`              | sample routing across 27 prefixes (shows ring balance)         |
| `GET  /stats`                    | latency percentiles, cache report, batcher report, trie size   |
| `POST /admin/flush`              | force-flush the batcher (useful for demos)                     |

Suggestions are sorted by `score = log(1 + count) + γ · recent_score`
(`γ = 2.5`, see below).

## Design

### Trie + per-node top-K (the suggestion path)

A standard prefix trie, but every internal node also caches the top-10
queries that pass through it (by score). `suggest(prefix)` is therefore just
walk-the-prefix + read the array — there is no subtree scan at request time.
That's what gives the sub-100 µs latency in the benchmark even on cache miss.

Building the trie from 100k queries takes well under a second, so on every
batch flush we just rebuild it from a DB snapshot rather than mutate it in
place. Mutations would require updating top-K at every prefix node of the
mutated query, which is fiddly and a likely source of bugs for very little
upside on this dataset size.

### Distributed cache + consistent hashing

`server/cache.js` simulates N logical cache nodes in-process. Each node is
an LRU `Map`; insertion-order iteration on `Map` gives FIFO eviction for
free, and `get` re-inserts so it becomes true LRU. Each prefix is stored
along with a TTL.

The ring uses **64 virtual nodes per physical node** with MD5-derived
32-bit hashes. `ownerOf(key)` is a binary search for the first ring entry
with hash ≥ hash(key), wrapping at the end. Adding or removing a physical
node only shifts the keys whose hashes fall between adjacent ring positions
of that node — that's the property that makes consistent hashing useful for
cache fleets (you don't blow away the whole cache on a topology change).

`GET /cache/debug` returns a routing map across a sample prefix set so you
can eyeball balance. With 64 vnodes × 4 physical nodes the load is even to
within a few percent (visible in the per-node `hits` in the benchmark).

### Recency-aware ranking (the +20%)

```
score = log(1 + count) + GAMMA · recent_score
```

- **`count`** is the all-time popularity (the column the basic version sorts
  by alone). `log()` flattens the head so a moderately popular query that's
  spiking right now can overtake a very popular one that's gone cold.
- **`recent_score`** is a decaying counter. Each `/search` adds 1.0; every
  60 s a global decay multiplies it by `0.5^(elapsed / HALF_LIFE_MS)` with
  `HALF_LIFE_MS = 30 min`. The decay runs as a single SQL `UPDATE`.
- **`GAMMA = 2.5`** tunes how aggressively recency wins over all-time
  popularity.

The same `/suggest` API serves both rankings — the basic version is just
`GAMMA = 0`. The five questions the spec asks (`server/ranker.js` and
`server/index.js`):

1. *How recent searches are tracked.* Per-query decaying counter persisted
   alongside the count.
2. *How recent activity affects ranking.* It contributes the `γ · recent`
   term to the score.
3. *How the system avoids permanently over-ranking short-burst queries.*
   The exponential decay (half-life 30 min) collapses an unmaintained
   `recent_score` back toward 0; once it's low, the `log(count)` term again
   dominates.
4. *How the cache is updated/invalidated when rankings change.* On every
   batch flush we rebuild the trie and call `cache.invalidateAll()`. Within
   a flush window stale results are bounded by `TTL = 30 s`.
5. *Trade-offs (freshness vs latency vs complexity).* This is the
   simplest design that satisfies the spec — see "Trade-offs" below.

### Batch writes

`server/batcher.js`. The buffer is `Map<query, {count, recent_score,
last_seen}>` so repeated submissions of the same query collapse into one
row *before* hitting the DB. Flush triggers are size (≥ 500 entries) or
time (every 2 s). A flush runs one SQLite transaction with all rows.

The benchmark shows ~90% fewer DB writes than a naïve write-per-request
implementation (802 submissions → 78 rows committed in 2 flushes), because
biased prefix traffic ⇒ lots of repeated queries inside a 2-s window.

**Failure modes.** If the process crashes before a flush, the in-buffer
deltas are lost. For a typeahead this is acceptable — counts are
statistical, not financial, and the next bump-from-zero on the same query
gets it back in the rankings. For real durability you'd:

- replace the buffer with an append-only file or
- write to Kafka/Redis Streams first and let a consumer do the aggregation
  off the hot path.

We also `flush()` on `SIGINT` / `SIGTERM` so a graceful shutdown commits
everything pending.

## Trade-offs

| Decision | Why | Cost |
| --- | --- | --- |
| Trie rebuilt on flush, not mutated in place | Simpler, no top-K bookkeeping bugs; <1 s for 100k queries | Brief CPU spike every 2 s; reads keep serving from the previous trie until the swap |
| Cache nodes are in-process LRUs | Honest demo of routing + invalidation logic without ops overhead | A real fleet would be N Redis processes; the consistent-hash code is identical |
| In-memory batch buffer | One dep, easy to reason about | Crash-loss window of up to `flushMs` (2 s) |
| SQLite primary store | Zero config, ACID, fits the assignment | Single-writer; for write throughput beyond ~10k qps you'd swap in Postgres or a KV store |
| MD5 for the ring | Cheap, well-distributed for this purpose | Not crypto-grade; doesn't matter for routing |

## Performance report

Hardware: MacBook (M-series), Node 24. From `npm run bench` on a fresh
seed:

```
latency:
cold       n=600    p50=  0.10  p95=  0.16  p99=  0.32 ms
warm       n=4000   p50=  0.06  p95=  0.08  p99=  0.10 ms

cache:     hit rate ≈ 0.857 across 4 nodes (within-cluster spread ~5%)
batcher:   submissions=802  rowsWritten=78  flushes=2  writeReduction=0.903
trieSize:  100,575
```

- Trie + cache wins keep p99 latency under 350 µs even on the cold path.
- The warm path is essentially the cost of a `Map.get` + JSON serialization.
- Batching cut DB writes by ~10× on this workload.

The `/stats` endpoint reports the same numbers live; the UI panel at the
bottom of the page refreshes it every 3 s.

## Project layout

```
hld/
├── server/
│   ├── index.js         # Express app + glue
│   ├── db.js            # SQLite + prepared statements
│   ├── trie.js          # prefix trie with cached top-K per node
│   ├── cache.js         # DistributedCache + consistent-hash ring
│   ├── ranker.js        # score = log(1+count) + γ · recent
│   └── batcher.js       # in-memory aggregator + flush
├── scripts/
│   ├── generate-data.js # synth Zipfian dataset OR import CSV
│   └── benchmark.js     # latency + hit rate + batch report
├── public/
│   ├── index.html
│   ├── style.css
│   └── app.js           # debounce, keyboard nav, live stats
├── data/
│   ├── store.db
│   └── queries.csv
├── package.json
└── README.md
```

## Demoing each requirement

| Spec item | How to see it |
| --- | --- |
| Prefix suggestions, top-10 by count | Type any prefix in the UI; or `curl 'http://localhost:3000/suggest?q=ipho'` |
| Empty / missing / mixed-case / no-match | Try `q=`, `q=zzzzzz`, `q=IphOnE` — all handled gracefully |
| Search submission + dummy response | Hit ⏎ in the UI, or `POST /search` |
| Query-count update | Submit same query twice, watch `/trending` move it up |
| Distributed cache + consistent hashing | `GET /cache/debug` shows the routing map and per-node hit rates |
| Cache expiry / invalidation | TTL = 30 s; full invalidate on each batch flush |
| Trending searches | Bottom of the UI, or `GET /trending` |
| Batch writes + write reduction | Run `npm run bench`, look at `batcher.writeReduction` |
| Recency-aware ranking | `recent_score` updated on `/search`, decayed every minute, contributes via γ |
| Latency, p95, cache hit rate | `npm run bench` and `GET /stats` |
| Consistent-hashing behavior logged | `GET /cache/debug` returns `sampleRouting.counts` showing per-node load |
