// Generates a realistic-looking search-query dataset and writes it to both
// the SQLite store and data/queries.csv.
//
//   node scripts/generate-data.js                # synth: ~100k Zipfian queries
//   node scripts/generate-data.js --csv path.csv # import from a CSV
//
// CSV format expected: header row `query,count` (extra columns ignored).
//
// The synthesizer combines tech/product/news/cooking/sports stems with common
// suffixes and qualifier words. Counts follow Zipf's law (c_i = K / i^s) which
// is what real query distributions actually look like — a small set of
// extremely popular queries and a long tail of rare ones. That's also what
// stresses the cache.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'store.db');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS queries (
    query        TEXT PRIMARY KEY,
    count        INTEGER NOT NULL DEFAULT 0,
    recent_score REAL    NOT NULL DEFAULT 0,
    last_seen    INTEGER NOT NULL DEFAULT 0
  );
  DELETE FROM queries;
`);

const STEMS = [
  // electronics
  'iphone','iphone 15','iphone 16','samsung galaxy','samsung galaxy s24','google pixel','google pixel 9',
  'macbook pro','macbook air','airpods','airpods pro','ipad','ipad pro','dell xps','dell xps 15','thinkpad x1',
  'thinkpad t14','surface laptop','surface pro','asus rog','lenovo yoga','hp spectre','razer blade','framework laptop',
  // dev
  'react','react hooks','vue','vue 3','svelte','svelte kit','angular','next.js','next js app router','nuxt',
  'typescript tutorial','typescript generics','javascript guide','javascript closures','python tutorial','python decorators',
  'go programming','go channels','rust language','rust ownership','c++ tutorial','c++ templates','java spring',
  'spring boot','flask tutorial','django tutorial','fastapi','express tutorial','nestjs','deno','bun runtime',
  // infra
  'docker','docker compose','kubernetes','kubernetes operator','terraform','ansible','pulumi','helm chart',
  'aws lambda','aws s3','aws ecs','aws ec2','azure functions','azure devops','gcp compute','gcp run','cloudflare workers',
  'redis tutorial','redis pubsub','postgres','postgres index','mysql','mysql replication','mongodb','mongodb atlas',
  'sqlite','cassandra','elasticsearch','opensearch','clickhouse','snowflake','bigquery','dbt',
  // system design
  'system design','distributed systems','consistent hashing','load balancer','message queue','kafka','kafka partitions',
  'rabbitmq','grpc','rest api','graphql','websocket','sse','event sourcing','cqrs','rate limiter',
  'leaky bucket','token bucket','bloom filter','merkle tree','raft consensus','paxos','crdts','vector clock',
  // products & sports
  'nike air max','adidas ultraboost','adidas samba','new balance 990','sony wh-1000xm5','bose quietcomfort',
  'kindle paperwhite','steam deck','nintendo switch','playstation 5','xbox series x','dyson v15','roomba',
  // lifestyle
  'best coffee maker','best laptop 2026','best phone 2026','cheap flights','hotel deals','recipe pasta',
  'recipe biryani','recipe pizza','recipe sourdough','marathon training','yoga for beginners','meditation app',
  'home workout','intermittent fasting','keto diet','mediterranean diet',
  // news
  'world cup','olympics','nba scores','f1 standings','ipl scores','stock price','bitcoin price','ethereum price',
  'solana price','weather forecast','news today','election results',
  // sites
  'wikipedia','github','stack overflow','reddit','youtube','twitter','linkedin','netflix shows','prime video','disney plus',
  // dsa
  'data structures','algorithms','binary tree','graph traversal','dynamic programming','sorting algorithm',
  'hashmap','linked list','heap','trie','red black tree','b tree','segment tree','fenwick tree','union find',
  // ml
  'machine learning','deep learning','transformer model','attention mechanism','llm fine tuning','pytorch',
  'tensorflow','huggingface','openai api','claude api','rag pipeline','vector database','embedding model',
  // finance
  'mortgage calculator','tax filing','retirement planning','credit score','car loan','student loan',
  'health insurance','life insurance','income tax','salary calculator','roth ira','401k',
];

const SUFFIXES = ['','review','price','specs','reddit','near me','tutorial','for beginners','2026','course',
  'example','best','cheap','tips','online','meaning','download','setup','guide','documentation','cheatsheet',
  'interview questions','vs alternatives','release date','specs comparison'];

const AUX = ['help','definition','book','app','features','update','launch','new','latest','pro','max',
  'mini','ultra','plus','lite','basic','advanced','expert','free','paid','open source','enterprise'];

const ZIPF_S = 1.05;
const ZIPF_K = 600_000;
const TARGET = 100_500;

const queries = new Map();
let rank = 1;

function addQ(q) {
  q = q.toLowerCase().replace(/\s+/g, ' ').trim();
  if (queries.has(q)) return;
  const count = Math.max(1, Math.floor(ZIPF_K / Math.pow(rank, ZIPF_S)));
  queries.set(q, count);
  rank++;
}

for (const stem of STEMS) for (const suf of SUFFIXES) addQ(suf ? `${stem} ${suf}` : stem);
outer: while (queries.size < TARGET) {
  for (const s of STEMS) for (const a of AUX) for (const a2 of AUX) {
    if (queries.size >= TARGET) break outer;
    addQ(`${s} ${a} ${a2}`);
  }
}

async function importCsv(file) {
  const stream = fs.createReadStream(file);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let header = true;
  const map = new Map();
  for await (const raw of rl) {
    if (header) { header = false; continue; }
    const line = raw.trim();
    if (!line) continue;
    const i = line.lastIndexOf(',');
    if (i === -1) continue;
    const q = line.slice(0, i).trim().toLowerCase();
    const c = parseInt(line.slice(i + 1), 10);
    if (!q || !Number.isFinite(c)) continue;
    map.set(q, (map.get(q) || 0) + c);
  }
  return map;
}

const csvArgIdx = process.argv.indexOf('--csv');
const source = csvArgIdx !== -1 ? await importCsv(process.argv[csvArgIdx + 1]) : queries;

const insert = db.prepare('INSERT INTO queries (query, count, recent_score, last_seen) VALUES (?, ?, 0, 0)');
const tx = db.transaction(rows => { for (const [q, c] of rows) insert.run(q, c); });
tx([...source.entries()]);

// Also dump a CSV mirror for grading / inspection.
const csvOut = path.join(dataDir, 'queries.csv');
const ws = fs.createWriteStream(csvOut);
ws.write('query,count\n');
for (const [q, c] of source) ws.write(`${q.replace(/,/g, ' ')},${c}\n`);
ws.end();

console.log(`seeded ${source.size} queries → ${dbPath}`);
console.log(`csv mirror → ${csvOut}`);
db.close();
