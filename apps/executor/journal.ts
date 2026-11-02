import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { digest, requireValue } from "../../packages/contracts/index.ts";
export class Journal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    // The Executor owns this file while its container is alive; only after a
    // confirmed stop may the host Runner open it to replay the outbox. A rollback
    // journal avoids WAL/SHM files crossing macOS and Linux via a bind mount.
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,runId TEXT NOT NULL,phase TEXT NOT NULL,messageId TEXT,result TEXT);
    CREATE TABLE IF NOT EXISTS native(seq INTEGER PRIMARY KEY,hash TEXT NOT NULL,event TEXT NOT NULL,runId TEXT);
    CREATE TABLE IF NOT EXISTS rejected_outbox(id INTEGER PRIMARY KEY,path TEXT NOT NULL,body TEXT NOT NULL,reason TEXT NOT NULL,rejectedAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,path TEXT NOT NULL,body TEXT NOT NULL,key TEXT UNIQUE);
  `);
  }
  get<T = any>(sql: string, ...params: any[]) {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T = any>(sql: string, ...params: any[]) {
    return this.db.prepare(sql).all(...params) as T[];
  }
  run(sql: string, ...params: any[]) {
    return this.db.prepare(sql).run(...params);
  }
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = fn();
      this.db.exec("COMMIT");
      return r;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw e;
    }
  }
  value<T>(key: string, fallback: T): T {
    const r = this.get("SELECT value FROM meta WHERE key=?", key);
    return r ? JSON.parse(r.value) : fallback;
  }
  set(key: string, value: unknown) {
    this.run(
      "INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  queue(path: string, body: unknown, key?: string) {
    this.run(
      "INSERT OR IGNORE INTO outbox(path,body,key) VALUES (?,?,?)",
      path,
      JSON.stringify(body),
      key ?? null,
    );
  }
  rejectOutbox(row: any, reason: string) {
    this.tx(() => {
      this.run(
        "INSERT OR IGNORE INTO rejected_outbox VALUES (?,?,?,?,?)",
        row.id,
        row.path,
        row.body,
        reason,
        Date.now(),
      );
      this.run("DELETE FROM outbox WHERE id=?", row.id);
    });
  }
  saveEvents(events: any[], runId: string | null) {
    this.tx(() => {
      for (const event of events) {
        const old = this.get("SELECT hash FROM native WHERE seq=?", event.seq);
        const hash = digest(event);
        requireValue(
          !old || old.hash === hash,
          "LOCAL_HISTORY_CONFLICT",
          "Persisted DSH history changed",
        );
        this.run(
          "INSERT OR IGNORE INTO native VALUES (?,?,?,?)",
          event.seq,
          hash,
          JSON.stringify(event),
          runId,
        );
      }
    });
  }
  close() {
    this.db.close();
  }
}
