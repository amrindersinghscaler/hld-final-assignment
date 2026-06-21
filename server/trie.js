// Prefix trie. Each node keeps the top-K queries (by score) whose path passes
// through it, so /suggest is just walk-prefix + read the cached top-K — no
// subtree scan at query time.
//
// Built from a DB snapshot. Cheap to rebuild for ~100k queries (<1s), so we
// rebuild on every batch flush rather than mutating in place.

const K = 10;

class Node {
  constructor() {
    this.kids = new Map();
    this.top = []; // [{q, s}] sorted by s desc, length <= K
  }
}

function bump(node, q, s) {
  const i = node.top.findIndex(e => e.q === q);
  if (i !== -1) node.top.splice(i, 1);
  let lo = 0, hi = node.top.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (node.top[m].s >= s) lo = m + 1; else hi = m;
  }
  node.top.splice(lo, 0, { q, s });
  if (node.top.length > K) node.top.length = K;
}

export class Trie {
  constructor(scoreFn) {
    this.root = new Node();
    this.score = scoreFn;
    this.size = 0;
  }

  insert(query, count, recent) {
    const s = this.score(count, recent);
    const norm = query.toLowerCase();
    let node = this.root;
    bump(node, query, s);
    for (let i = 0; i < norm.length; i++) {
      const ch = norm[i];
      let next = node.kids.get(ch);
      if (!next) { next = new Node(); node.kids.set(ch, next); }
      node = next;
      bump(node, query, s);
    }
    this.size++;
  }

  suggest(prefix) {
    let node = this.root;
    for (let i = 0; i < prefix.length; i++) {
      node = node.kids.get(prefix[i]);
      if (!node) return [];
    }
    return node.top.map(e => e.q);
  }
}
