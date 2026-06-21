// Aggregates /search submissions in memory and flushes them to SQLite in a
// single transaction. Flushes when buffer hits maxBatch OR after flushMs.
//
// Trade-off: if the process crashes before a flush, the pending counts in the
// buffer are lost. We accept that for the suggestion use case (counts are
// statistical, not financial). For durability we'd swap the in-memory buffer
// for an append-only log (e.g. a Kafka topic) before aggregation.

import { stmts, db } from './db.js';

export class BatchWriter {
  constructor({ maxBatch = 500, flushMs = 2000, onFlush } = {}) {
    this.maxBatch = maxBatch;
    this.flushMs = flushMs;
    this.onFlush = onFlush;
    this.buf = new Map();
    this.flushes = 0;
    this.rowsWritten = 0;
    this.submissions = 0;
    this.timer = setInterval(() => this.flush(), flushMs);
    this.timer.unref?.();
  }

  submit(query, recentDelta = 1) {
    this.submissions++;
    const now = Date.now();
    const e = this.buf.get(query);
    if (e) { e.count++; e.recent_score += recentDelta; e.last_seen = now; }
    else   { this.buf.set(query, { count: 1, recent_score: recentDelta, last_seen: now }); }
    if (this.buf.size >= this.maxBatch) this.flush();
  }

  flush() {
    if (this.buf.size === 0) return;
    const entries = [...this.buf.entries()];
    this.buf.clear();
    const tx = db.transaction(rows => {
      for (const [query, v] of rows) {
        stmts.upsert.run({ query, count: v.count, recent_score: v.recent_score, last_seen: v.last_seen });
      }
    });
    tx(entries);
    this.flushes++;
    this.rowsWritten += entries.length;
    if (this.onFlush) this.onFlush(entries);
  }

  stop() {
    clearInterval(this.timer);
    this.flush();
  }

  report() {
    const writeReduction = this.submissions ? 1 - this.rowsWritten / this.submissions : 0;
    return {
      submissions: this.submissions,
      rowsWritten: this.rowsWritten,
      flushes: this.flushes,
      pending: this.buf.size,
      writeReduction: +writeReduction.toFixed(4),
    };
  }
}
