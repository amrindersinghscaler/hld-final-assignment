import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, stmts } from './db.js';
import { Trie } from './trie.js';
import { DistributedCache } from './cache.js';
import { score, decayFactor, RECENT_INCREMENT } from './ranker.js';
import { BatchWriter } from './batcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const CACHE_NODES = (process.env.CACHE_NODES || 'cache-A,cache-B,cache-C,cache-D').split(',');

const cache = new DistributedCache(CACHE_NODES);

let trie = buildTrie();
let lastDecayAt = Date.now();

function buildTrie() {
  const t = new Trie(score);
  let n = 0;
  for (const r of stmts.iterateAll.iterate()) {
    t.insert(r.query, r.count, r.recent_score);
    n++;
  }
  console.log(`trie built: ${n} queries`);
  return t;
}

const batcher = new BatchWriter({
  maxBatch: 500,
  flushMs: 2000,
  onFlush: () => {
    // Rebuild the trie so recent score changes are reflected in suggestions,
    // and invalidate the cache so the next /suggest returns fresh data.
    trie = buildTrie();
    cache.invalidateAll();
  },
});

// Periodic recency decay: keeps recent_score from growing unboundedly and
// prevents queries that were popular for a short period from dominating
// forever. Runs in-place on the DB so a server restart preserves decay state.
const DECAY_TICK_MS = 60_000;
const decayTimer = setInterval(() => {
  const now = Date.now();
  const f = decayFactor(now - lastDecayAt);
  lastDecayAt = now;
  if (f < 0.999) stmts.decayAll.run(f);
}, DECAY_TICK_MS);
decayTimer.unref();

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const latencies = [];
function record(ms) {
  latencies.push(ms);
  if (latencies.length > 2000) latencies.shift();
}

app.get('/suggest', (req, res) => {
  const t0 = process.hrtime.bigint();
  const raw = (req.query.q ?? '').toString();
  const q = raw.trim().toLowerCase();
  if (!q) return res.json({ q: '', suggestions: [], nodeId: null, hit: false, latencyMs: 0 });

  const key = `pfx:${q}`;
  const { value, nodeId, hit } = cache.get(key);
  let suggestions;
  if (hit) {
    suggestions = value;
  } else {
    suggestions = trie.suggest(q);
    cache.set(key, suggestions);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  record(ms);
  res.json({ q, suggestions, nodeId, hit, latencyMs: +ms.toFixed(3) });
});

app.post('/search', (req, res) => {
  const raw = (req.body?.q ?? '').toString();
  const q = raw.trim().toLowerCase();
  if (!q) return res.status(400).json({ error: 'q required' });
  batcher.submit(q, RECENT_INCREMENT);
  res.json({ message: 'Searched', q });
});

app.get('/cache/debug', (req, res) => {
  const prefix = (req.query.prefix ?? '').toString().trim().toLowerCase();
  if (!prefix) {
    const sample = ['a', 'app', 'apple', 'b', 'be', 'best', 'c', 'cs', 'do', 'do', 'go', 'i', 'iph', 'java', 'k', 'm', 'n', 'p', 'react', 's', 'sys', 'tu', 'u', 'w', 'x', 'y', 'z'];
    return res.json({
      nodes: CACHE_NODES,
      sampleRouting: cache.routingMap(sample.map(p => `pfx:${p}`)),
      report: cache.report(),
    });
  }
  const key = `pfx:${prefix}`;
  const owner = cache.ownerOf(key);
  // Peek without mutating stats: do a real get and report whether it hit.
  const r = cache.get(key);
  res.json({ prefix, key, owner, hit: r.hit, value: r.value, report: cache.report() });
});

app.get('/trending', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 10, 50);
  const rows = stmts.topRecent.all(limit);
  res.json({ trending: rows.map(r => ({ query: r.query, count: r.count, recent: +r.recent_score.toFixed(3) })) });
});

app.get('/stats', (_req, res) => {
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = q => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0;
  res.json({
    queries: stmts.total.get().n,
    suggestRequests: latencies.length,
    latencyMs: { p50: +pct(0.5).toFixed(3), p95: +pct(0.95).toFixed(3), p99: +pct(0.99).toFixed(3) },
    cache: cache.report(),
    batcher: batcher.report(),
    trieSize: trie.size,
    cacheNodes: CACHE_NODES,
  });
});

app.post('/admin/flush', (_req, res) => { batcher.flush(); res.json({ ok: true }); });

const server = app.listen(PORT, () => {
  console.log(`typeahead listening on http://localhost:${PORT}`);
  console.log(`cache nodes: ${CACHE_NODES.join(', ')}`);
});

function shutdown() {
  console.log('shutting down…');
  batcher.stop();
  server.close(() => { db.close(); process.exit(0); });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
