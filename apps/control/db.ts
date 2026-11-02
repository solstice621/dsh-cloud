import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  CloudError,
  digest,
  id,
  requireValue,
  secret,
  terminalStates,
  TemplateSchema,
  type Task,
  type Run,
  type Template,
  type TaskInput,
} from "../../packages/contracts/index.ts";

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials(hash TEXT PRIMARY KEY,kind TEXT NOT NULL,subject TEXT NOT NULL,scope TEXT,expiresAt INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS pairings(hash TEXT PRIMARY KEY,ownerId TEXT NOT NULL,expiresAt INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS runners(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL,name TEXT NOT NULL,platform TEXT NOT NULL,capacity INTEGER NOT NULL DEFAULT 1,lastSeenAt INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,inventory TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS templates(id TEXT NOT NULL,version TEXT NOT NULL,body TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(id,version));
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,ownerId TEXT NOT NULL,title TEXT NOT NULL,runnerId TEXT NOT NULL REFERENCES runners(id),sessionId TEXT NOT NULL UNIQUE,environmentId TEXT NOT NULL UNIQUE,templateId TEXT NOT NULL,templateVersion TEXT NOT NULL,repo TEXT NOT NULL,ref TEXT NOT NULL,baseBranch TEXT NOT NULL,baseCommit TEXT,branch TEXT NOT NULL,deliveryPolicy TEXT NOT NULL,lifecycle TEXT NOT NULL DEFAULT 'open',environmentState TEXT NOT NULL DEFAULT 'provisioning',epoch INTEGER NOT NULL DEFAULT 0,incarnation TEXT,currentRunId TEXT,paused INTEGER NOT NULL DEFAULT 0,durableSeq INTEGER NOT NULL DEFAULT -1,workspaceRevision TEXT,version INTEGER NOT NULL DEFAULT 1,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),ordinal INTEGER NOT NULL,input TEXT NOT NULL,kind TEXT NOT NULL,previousRunId TEXT,state TEXT NOT NULL,commandId TEXT NOT NULL UNIQUE,attemptId TEXT,messageId TEXT,result TEXT,createdAt INTEGER NOT NULL,startedAt INTEGER,endedAt INTEGER,UNIQUE(taskId,ordinal));
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs(taskId) WHERE state IN ('preparing','running','waiting_input','finalizing','cancelling');
      CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,runId TEXT NOT NULL REFERENCES runs(id),epoch INTEGER NOT NULL,incarnation TEXT NOT NULL,startedAt INTEGER NOT NULL,endedAt INTEGER,outcome TEXT);
      CREATE TABLE IF NOT EXISTS events(taskId TEXT NOT NULL REFERENCES tasks(id),taskSeq INTEGER NOT NULL,kind TEXT NOT NULL,runId TEXT,payload TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(taskId,taskSeq));
      CREATE TABLE IF NOT EXISTS native_events(taskId TEXT NOT NULL REFERENCES tasks(id),nativeSeq INTEGER NOT NULL,hash TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(taskId,nativeSeq));
      CREATE TABLE IF NOT EXISTS idempotency(scope TEXT NOT NULL,key TEXT NOT NULL,hash TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(scope,key));
      CREATE TABLE IF NOT EXISTS interactions(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),runId TEXT NOT NULL,incarnation TEXT NOT NULL,nativeId TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',answer TEXT,version INTEGER NOT NULL DEFAULT 1,expiresAt INTEGER NOT NULL,UNIQUE(taskId,incarnation,nativeId));
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),kind TEXT NOT NULL,request TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',result TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,taskId TEXT NOT NULL REFERENCES tasks(id),runId TEXT,revision TEXT,kind TEXT NOT NULL,hash TEXT NOT NULL,size INTEGER NOT NULL,body TEXT NOT NULL,createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS publications(taskId TEXT PRIMARY KEY REFERENCES tasks(id),branch TEXT NOT NULL,commitId TEXT,prId TEXT,url TEXT,state TEXT NOT NULL,operationId TEXT);
      CREATE TABLE IF NOT EXISTS model_usage(runId TEXT PRIMARY KEY,calls INTEGER NOT NULL DEFAULT 0,inputTokens INTEGER,outputTokens INTEGER);
      CREATE TABLE IF NOT EXISTS task_models(taskId TEXT PRIMARY KEY REFERENCES tasks(id),name TEXT NOT NULL,routeHash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS native_headers(taskId TEXT PRIMARY KEY REFERENCES tasks(id),body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_requests(runId TEXT PRIMARY KEY REFERENCES runs(id),requestId TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS auth_flows(id TEXT PRIMARY KEY,body TEXT NOT NULL,expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices(id TEXT PRIMARY KEY,codeHash TEXT NOT NULL UNIQUE,pollHash TEXT NOT NULL,ownerId TEXT,state TEXT NOT NULL,expiresAt INTEGER NOT NULL);
      INSERT OR IGNORE INTO meta(key,value) VALUES ('schemaVersion','1');
    `);
    requireValue(
      this.one<any>("SELECT value FROM meta WHERE key=?", "schemaVersion")
        ?.value === "1",
      "SCHEMA_VERSION",
      "Unsupported database schema",
    );
  }
  one<T>(sql: string, ...params: any[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  all<T = any>(sql: string, ...params: any[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  exec(sql: string, ...params: any[]) {
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
  close() {
    this.db.close();
  }
  event(
    taskId: string,
    kind: string,
    payload: unknown,
    runId: string | null = null,
  ) {
    const seq = this.one<any>(
      "SELECT COALESCE(MAX(taskSeq),0)+1 AS n FROM events WHERE taskId=?",
      taskId,
    )!.n;
    this.exec(
      "INSERT INTO events VALUES (?,?,?,?,?,?)",
      taskId,
      seq,
      kind,
      runId,
      JSON.stringify(payload),
      Date.now(),
    );
    this.exec(
      "UPDATE tasks SET version=version+1,updatedAt=? WHERE id=?",
      Date.now(),
      taskId,
    );
    return seq as number;
  }
  idempotent<T>(scope: string, key: string, payload: unknown, fn: () => T): T {
    requireValue(
      key && key.length <= 200,
      "IDEMPOTENCY_REQUIRED",
      "A stable Idempotency-Key is required",
      400,
    );
    return this.tx(() => {
      const hash = digest(payload);
      const prior = this.one<any>(
        "SELECT * FROM idempotency WHERE scope=? AND key=?",
        scope,
        key,
      );
      if (prior) {
        requireValue(
          prior.hash === hash,
          "IDEMPOTENCY_CONFLICT",
          "The key was already used for a different request",
        );
        return JSON.parse(prior.result);
      }
      const result = fn();
      this.exec(
        "INSERT INTO idempotency VALUES (?,?,?,?)",
        scope,
        key,
        hash,
        JSON.stringify(result),
      );
      return result;
    });
  }
  template(id: string, version: string): Template {
    const r = this.one<any>(
      "SELECT body FROM templates WHERE id=? AND version=?",
      id,
      version,
    );
    requireValue(
      r,
      "TEMPLATE_NOT_FOUND",
      "Environment template not found",
      404,
    );
    return TemplateSchema.parse(JSON.parse(r.body));
  }
  addTemplate(t: Template) {
    const hash = digest(t);
    const old = this.one<any>(
      "SELECT hash FROM templates WHERE id=? AND version=?",
      t.id,
      t.version,
    );
    requireValue(
      !old || old.hash === hash,
      "IMMUTABLE_TEMPLATE",
      "Change the template version before changing its configuration",
    );
    this.exec(
      "INSERT OR IGNORE INTO templates VALUES (?,?,?,?)",
      t.id,
      t.version,
      JSON.stringify(t),
      hash,
    );
  }
  task(taskId: string, ownerId?: string): Task {
    const t = this.one<Task>("SELECT * FROM tasks WHERE id=?", taskId);
    requireValue(
      t && (!ownerId || t.ownerId === ownerId),
      "TASK_NOT_FOUND",
      "Task not found",
      404,
    );
    return t;
  }
  mint(kind: string, subject: string, scope: unknown = null, ttl = 86400000) {
    const token = secret();
    this.exec(
      "INSERT INTO credentials VALUES (?,?,?,?,?,0)",
      digest(token),
      kind,
      subject,
      JSON.stringify(scope),
      Date.now() + ttl,
    );
    return token;
  }
  auth(token: string) {
    const c = this.one<any>(
      "SELECT * FROM credentials WHERE hash=? AND revoked=0 AND expiresAt>?",
      digest(token),
      Date.now(),
    );
    requireValue(c, "UNAUTHORIZED", "Sign in again", 401);
    return { ...c, scope: JSON.parse(c.scope) };
  }
  assertModelRoute(taskId: string, model: { name: string; baseUrl: string }) {
    const saved = this.one<any>(
      "SELECT * FROM task_models WHERE taskId=?",
      taskId,
    );
    const routeHash = digest({
      name: model.name,
      baseUrl: model.baseUrl.replace(/\/+$/, ""),
    });
    requireValue(
      saved?.routeHash === routeHash,
      "MODEL_ROUTE_CHANGED",
      "Restore the model route recorded for this task before continuing",
      409,
    );
  }
  createTask(
    ownerId: string,
    input: TaskInput,
    key: string,
    model: { name: string; baseUrl: string },
  ) {
    return this.idempotent(`${ownerId}:task`, key, input, () => {
      const r = this.one<any>(
        "SELECT * FROM runners WHERE id=? AND ownerId=? AND revoked=0",
        input.runnerId,
        ownerId,
      );
      requireValue(r, "RUNNER_NOT_FOUND", "Runner not found", 404);
      const template = this.template(input.templateId, input.templateVersion);
      requireValue(
        template.platforms.includes(r.platform),
        "PLATFORM_MISMATCH",
        "Runner cannot execute this template",
      );
      const taskId = id(),
        now = Date.now();
      requireValue(!input.sessionId || !this.one("SELECT id FROM tasks WHERE sessionId=?", input.sessionId), "SESSION_EXISTS", "This session already belongs to a task");
      this.exec(
        "INSERT INTO tasks(id,ownerId,title,runnerId,sessionId,environmentId,templateId,templateVersion,repo,ref,baseBranch,branch,deliveryPolicy,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        taskId,
        ownerId,
        input.title,
        input.runnerId,
        input.sessionId ?? id(),
        id(),
        input.templateId,
        input.templateVersion,
        input.repo,
        input.ref,
        input.baseBranch,
        `dsh/task/${taskId}`,
        input.deliveryPolicy,
        now,
        now,
      );
      this.exec(
        "INSERT INTO task_models VALUES (?,?,?)",
        taskId,
        model.name,
        digest({
          name: model.name,
          baseUrl: model.baseUrl.replace(/\/+$/, ""),
        }),
      );
      this.event(taskId, "task.created", {
        title: input.title,
        model: model.name,
      });
      const run = this.enqueue(taskId, input.input, "normal", null);
      if (input.requestId) this.exec("INSERT INTO run_requests VALUES (?,?)", run.id, input.requestId);
      return { taskId, runId: run.id };
    });
  }
  enqueue(
    taskId: string,
    input: string,
    kind: string,
    previousRunId: string | null,
  ) {
    const task = this.task(taskId);
    requireValue(
      task.lifecycle === "open",
      "TASK_CLOSED",
      "Reopen the task before submitting input",
    );
    const n = this.one<any>(
      "SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM runs WHERE taskId=?",
      taskId,
    )!.n;
    const runId = id();
    this.exec(
      "INSERT INTO runs(id,taskId,ordinal,input,kind,previousRunId,state,commandId,createdAt) VALUES (?,?,?,?,?,?,?,?,?)",
      runId,
      taskId,
      n,
      input,
      kind,
      previousRunId,
      "queued",
      id(),
      Date.now(),
    );
    this.event(
      taskId,
      "input.saved",
      { runId, input, ordinal: n, kind },
      runId,
    );
    return this.one<Run>("SELECT * FROM runs WHERE id=?", runId)!;
  }
  snapshot(taskId: string, ownerId: string) {
    return this.tx(() => {
      const task = this.task(taskId, ownerId);
      const runner = this.one<any>(
        "SELECT id,name,lastSeenAt,revoked FROM runners WHERE id=?",
        task.runnerId,
      );
      return {
        task,
        runner,
        modelRoute: this.one(
          "SELECT name,routeHash FROM task_models WHERE taskId=?",
          taskId,
        ),
        runs: this.all(
          "SELECT r.*,q.requestId FROM runs r LEFT JOIN run_requests q ON q.runId=r.id WHERE r.taskId=? ORDER BY r.ordinal",
          taskId,
        ).map((r) => ({
          ...r,
          result: r.result ? JSON.parse(r.result) : null,
        })),
        interactions: this.all(
          "SELECT * FROM interactions WHERE taskId=? ORDER BY rowid",
          taskId,
        ).map((r) => ({
          ...r,
          body: JSON.parse(r.body),
          answer: r.answer ? JSON.parse(r.answer) : null,
        })),
        publication:
          this.one("SELECT * FROM publications WHERE taskId=?", taskId) ?? null,
        operations: this.all(
          "SELECT * FROM operations WHERE taskId=? ORDER BY createdAt DESC LIMIT 100",
          taskId,
        ).map((o) => ({
          ...o,
          request: JSON.parse(o.request),
          result: o.result ? JSON.parse(o.result) : null,
        })),
        usage: this.all(
          "SELECT u.* FROM model_usage u JOIN runs r ON r.id=u.runId WHERE r.taskId=?",
          taskId,
        ),
        artifacts: this.all(
          "SELECT id,runId,revision,kind,hash,size,createdAt FROM artifacts WHERE taskId=? ORDER BY createdAt",
          taskId,
        ),
        snapshotSeq: this.one<any>(
          "SELECT COALESCE(MAX(taskSeq),0) AS n FROM events WHERE taskId=?",
          taskId,
        )!.n,
      };
    });
  }
  fence(taskId: string, epoch: number, incarnation?: string) {
    const task = this.task(taskId);
    requireValue(
      task.epoch === epoch &&
        (!incarnation || task.incarnation === incarnation),
      "STALE_EXECUTOR",
      "The runtime no longer holds execution rights",
    );
    const runner = this.one<any>(
      "SELECT revoked FROM runners WHERE id=?",
      task.runnerId,
    );
    requireValue(
      runner && !runner.revoked,
      "RUNNER_REVOKED",
      "Runner is revoked",
      403,
    );
    return task;
  }
  nextRun(taskId: string, epoch: number, incarnation: string) {
    return this.tx(() => {
      const t = this.fence(taskId, epoch, incarnation);
      if (this.one("SELECT key FROM meta WHERE key='reconciliation'"))
        return null;
      if (t.currentRunId) {
        const run = this.one<Run>(
          "SELECT * FROM runs WHERE id=?",
          t.currentRunId,
        )!;
        return { run, cancelled: run.state === "cancelling" };
      }
      if (
        t.paused ||
        t.lifecycle !== "open" ||
        this.one(
          "SELECT id FROM operations WHERE taskId=? AND kind IN (?,?) AND state IN (?,?)",
          taskId,
          "publish",
          "stop",
          "pending",
          "running",
        )
      )
        return null;
      const run = this.one<Run>(
        "SELECT * FROM runs WHERE taskId=? AND state=? ORDER BY ordinal LIMIT 1",
        taskId,
        "queued",
      );
      if (!run) return null;
      const attemptId = id(),
        now = Date.now();
      this.exec(
        "UPDATE runs SET state=?,attemptId=?,startedAt=? WHERE id=?",
        "preparing",
        attemptId,
        now,
        run.id,
      );
      this.exec(
        "INSERT INTO attempts VALUES (?,?,?,?,?,NULL,NULL)",
        attemptId,
        run.id,
        epoch,
        incarnation,
        now,
      );
      this.exec(
        "UPDATE tasks SET currentRunId=?,environmentState=? WHERE id=?",
        run.id,
        "busy",
        taskId,
      );
      this.event(taskId, "run.preparing", { runId: run.id, attemptId }, run.id);
      return {
        run: { ...run, attemptId, startedAt: now, state: "preparing" as const },
        cancelled: false,
      };
    });
  }
  ingest(
    taskId: string,
    epoch: number,
    incarnation: string,
    events: any[],
    runId: string | null,
  ) {
    return this.tx(() => {
      const task = this.fence(taskId, epoch, incarnation);
      let next = task.durableSeq + 1;
      for (const event of events) {
        requireValue(
          Number.isSafeInteger(event.seq) && event.seq >= 0,
          "INVALID_SEQ",
          "Invalid native event sequence",
          400,
        );
        const hash = digest(event),
          old = this.one<any>(
            "SELECT hash FROM native_events WHERE taskId=? AND nativeSeq=?",
            taskId,
            event.seq,
          );
        if (old) {
          requireValue(
            old.hash === hash,
            "EVENT_CONFLICT",
            "Native history differs from its saved prefix",
          );
          continue;
        }
        requireValue(
          event.seq === next,
          "EVENT_GAP",
          `Expected native sequence ${next}`,
        );
        this.exec(
          "INSERT INTO native_events VALUES (?,?,?,?)",
          taskId,
          event.seq,
          hash,
          JSON.stringify(event),
        );
        this.event(taskId, "session.event", event, runId);
        next++;
      }
      this.exec("UPDATE tasks SET durableSeq=? WHERE id=?", next - 1, taskId);
      return { durableSeq: next - 1 };
    });
  }
  complete(
    taskId: string,
    epoch: number,
    incarnation: string,
    runId: string,
    state: string,
    result: any,
  ) {
    return this.tx(() => {
      const t = this.fence(taskId, epoch, incarnation),
        r = this.one<Run>(
          "SELECT * FROM runs WHERE id=? AND taskId=?",
          runId,
          taskId,
        );
      requireValue(r, "RUN_NOT_FOUND", "Run not found", 404);
      if (terminalStates.includes(r.state as any)) {
        requireValue(
          r.state === state &&
            digest(JSON.parse(r.result ?? "null")) === digest(result),
          "RESULT_CONFLICT",
          "Run already has a different result",
        );
        return { ok: true };
      }
      requireValue(
        t.currentRunId === runId,
        "RUN_NOT_CURRENT",
        "Run is no longer current",
      );
      requireValue(
        terminalStates.includes(state as any),
        "INVALID_STATE",
        "Invalid terminal state",
        400,
      );
      requireValue(
        state !== "succeeded" ||
          (Number.isInteger(result.durableSeq) &&
            result.durableSeq <= t.durableSeq &&
            typeof result.workspaceRevision === "string"),
        "CHECKPOINT_REQUIRED",
        "Result requires a confirmed checkpoint and workspace revision",
      );
      requireValue(
        r.state !== "cancelling" ||
          state === "cancelled" ||
          state === "interrupted",
        "CANCEL_PENDING",
        "Cancellation must be confirmed by the Runner",
      );
      const paused = ["interrupted", "uncertain", "cancelled"].includes(state)
        ? 1
        : t.paused;
      this.exec(
        "UPDATE runs SET state=?,result=?,endedAt=? WHERE id=?",
        state,
        JSON.stringify(result),
        Date.now(),
        runId,
      );
      this.exec(
        "UPDATE attempts SET endedAt=?,outcome=? WHERE id=?",
        Date.now(),
        state,
        r.attemptId,
      );
      this.exec(
        "UPDATE tasks SET currentRunId=NULL,paused=?,environmentState=?,workspaceRevision=COALESCE(?,workspaceRevision) WHERE id=?",
        paused,
        ["uncertain", "interrupted"].includes(state) ? "needs_stop" : "ready",
        result.workspaceRevision ?? null,
        taskId,
      );
      this.exec(
        "UPDATE interactions SET state='expired',version=version+1 WHERE taskId=? AND state IN ('pending','submitted')",
        taskId,
      );
      this.event(taskId, `run.${state}`, result, runId);
      return { ok: true };
    });
  }
}
