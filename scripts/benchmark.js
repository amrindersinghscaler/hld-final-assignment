// Hits /suggest with a realistic prefix mix, then prints latency percentiles
// and the server's own cache + batcher report. Two phases:
//   1) cold: hit each unique prefix once → measures trie + cache-miss cost
//   2) warm: random mix biased to common prefixes → measures cached path
// Also fires /search submissions in between so the batcher gets exercised.

import http from 'node:http';

const HOST = process.env.HOST || 'localhost';
const PORT = Number(process.env.PORT) || 3000;
const COLD = Number(process.env.COLD) || 600;
const WARM = Number(process.env.WARM) || 4000;
const SEARCHES = Number(process.env.SEARCHES) || 800;

const PREFIXES = [
  'a','ap','app','b','be','bes','best','c','co','cr','d','de','do','doc','e','f','g','go','goo',
  'h','i','ip','iph','ipho','iphone','j','ja','jav','java','k','kub','l','m','ma','mac','n',
  'ne','net','nin','nint','o','p','pa','po','py','python','q','r','re','rea','reac','react',
  's','sa','sam','sams','samsung','sp','sy','sys','syst','syste','system','t','te','ty','typ',
  'u','v','vu','w','x','xb','y','yo','you','z',
];

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const opts = { host: HOST, port: PORT, method, path, headers: {} };
    if (body) { opts.headers['content-type'] = 'application/json'; opts.headers['content-length'] = Buffer.byteLength(body); }
    const r = http.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        try { resolve({ ms, body: JSON.parse(Buffer.concat(chunks).toString() || '{}') }); }
        catch (e) { resolve({ ms, body: null }); }
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const get  = p => req('GET',  p);
const post = (p, b) => req('POST', p, JSON.stringify(b));

function pct(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function pickBiased() {
  // Power-law over the prefix list: short prefixes (more popular) get hit more.
  const r = Math.pow(Math.random(), 1.4);
  return PREFIXES[Math.floor(r * PREFIXES.length)];
}

(async () => {
  console.log(`benchmarking http://${HOST}:${PORT}`);
  // small warm-up so jit / connect cost doesn't pollute first reading
  for (let i = 0; i < 30; i++) await get(`/suggest?q=${PREFIXES[i % PREFIXES.length]}`);

  const cold = [];
  for (let i = 0; i < COLD; i++) {
    const p = PREFIXES[i % PREFIXES.length] + (i > PREFIXES.length ? String.fromCharCode(97 + (i % 26)) : '');
    const { ms } = await get(`/suggest?q=${encodeURIComponent(p)}`);
    cold.push(ms);
  }

  for (let i = 0; i < SEARCHES; i++) await post('/search', { q: pickBiased() });

  const warm = [];
  for (let i = 0; i < WARM; i++) {
    const { ms } = await get(`/suggest?q=${encodeURIComponent(pickBiased())}`);
    warm.push(ms);
  }

  const stats = (await get('/stats')).body;

  const row = (label, arr) =>
    `${label.padEnd(10)} n=${String(arr.length).padEnd(6)} p50=${pct(arr,0.5).toFixed(2).padStart(6)}  p95=${pct(arr,0.95).toFixed(2).padStart(6)}  p99=${pct(arr,0.99).toFixed(2).padStart(6)} ms`;
  console.log('\nlatency:');
  console.log(row('cold', cold));
  console.log(row('warm', warm));

  console.log('\nserver /stats:');
  console.log(JSON.stringify(stats, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
