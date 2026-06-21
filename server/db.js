import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const dbPath = path.join(dataDir, 'store.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS queries (
    query        TEXT PRIMARY KEY,
    count        INTEGER NOT NULL DEFAULT 0,
    recent_score REAL    NOT NULL DEFAULT 0,
    last_seen    INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_count  ON queries(count DESC);
  CREATE INDEX IF NOT EXISTS idx_recent ON queries(recent_score DESC);
`);

export const stmts = {
  upsert: db.prepare(`
    INSERT INTO queries (query, count, recent_score, last_seen)
    VALUES (@query, @count, @recent_score, @last_seen)
    ON CONFLICT(query) DO UPDATE SET
      count        = count + excluded.count,
      recent_score = recent_score + excluded.recent_score,
      last_seen    = excluded.last_seen
  `),
  iterateAll: db.prepare(`SELECT query, count, recent_score FROM queries`),
  topRecent:  db.prepare(`SELECT query, count, recent_score FROM queries WHERE recent_score > 0 ORDER BY recent_score DESC LIMIT ?`),
  total:      db.prepare(`SELECT COUNT(*) AS n FROM queries`),
  decayAll:   db.prepare(`UPDATE queries SET recent_score = recent_score * ? WHERE recent_score > 0`),
};
