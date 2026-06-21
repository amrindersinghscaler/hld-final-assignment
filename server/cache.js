// Distributed suggestion cache.
//
// N logical cache nodes, each an LRU (Map preserves insertion order, so the
// oldest key is .keys().next().value). Prefix -> {value, expiresAt}.
//
// Routing uses consistent hashing with virtual nodes on a sorted ring. The
// owner of a key is the first ring entry whose hash >= hash(key), wrapping
// around. Removing or adding a physical node only shifts the keys that fall
// between adjacent ring positions of that node.

import crypto from 'node:crypto';

const VNODES = 64;
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_LRU_MAX = 5_000;

function h32(s) {
  const d = crypto.createHash('md5').update(s).digest();
  return d.readUInt32BE(0);
}

class LRU {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) {
    const v = this.m.get(k);
    if (v === undefined) return undefined;
    this.m.delete(k); this.m.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.m.has(k)) this.m.delete(k);
    this.m.set(k, v);
    if (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
  }
  delete(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
  get size() { return this.m.size; }
}

export class DistributedCache {
  constructor(nodeIds, { lruMax = DEFAULT_LRU_MAX, ttlMs = DEFAULT_TTL_MS } = {}) {
    this.ttl = ttlMs;
    this.nodes = new Map(nodeIds.map(id => [id, new LRU(lruMax)]));
    this.ring = [];
    for (const id of nodeIds) this._addRing(id);
    this.ring.sort((a, b) => a.hash - b.hash);

    this.stats = {
      hits: 0, misses: 0, evictionsByTtl: 0,
      perNode: new Map(nodeIds.map(id => [id, { hits: 0, misses: 0 }])),
    };
  }

  _addRing(id) {
    for (let i = 0; i < VNODES; i++) this.ring.push({ hash: h32(`${id}#${i}`), nodeId: id });
  }

  ownerOf(key) {
    const target = h32(key);
    let lo = 0, hi = this.ring.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.ring[m].hash < target) lo = m + 1; else hi = m;
    }
    return this.ring[lo % this.ring.length].nodeId;
  }

  get(key) {
    const nodeId = this.ownerOf(key);
    const node = this.nodes.get(nodeId);
    const e = node.get(key);
    const ns = this.stats.perNode.get(nodeId);
    if (e && e.expiresAt > Date.now()) {
      this.stats.hits++; ns.hits++;
      return { value: e.value, nodeId, hit: true };
    }
    if (e) { node.delete(key); this.stats.evictionsByTtl++; }
    this.stats.misses++; ns.misses++;
    return { value: null, nodeId, hit: false };
  }

  set(key, value, ttl = this.ttl) {
    const nodeId = this.ownerOf(key);
    this.nodes.get(nodeId).set(key, { value, expiresAt: Date.now() + ttl });
    return nodeId;
  }

  invalidateAll() {
    for (const n of this.nodes.values()) n.clear();
  }

  // Useful for the consistent-hashing demo: which physical nodes do a set of
  // prefixes route to, and how balanced is the distribution.
  routingMap(keys) {
    const counts = Object.fromEntries([...this.nodes.keys()].map(id => [id, 0]));
    const assignments = keys.map(k => {
      const owner = this.ownerOf(k);
      counts[owner]++;
      return { key: k, owner };
    });
    return { assignments, counts };
  }

  report() {
    const total = this.stats.hits + this.stats.misses;
    const hitRate = total ? this.stats.hits / total : 0;
    const perNode = {};
    for (const [id, s] of this.stats.perNode) {
      const t = s.hits + s.misses;
      perNode[id] = { ...s, size: this.nodes.get(id).size, hitRate: t ? s.hits / t : 0 };
    }
    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: +hitRate.toFixed(4),
      evictionsByTtl: this.stats.evictionsByTtl,
      perNode,
    };
  }
}
