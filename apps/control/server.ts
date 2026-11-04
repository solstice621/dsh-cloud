import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  CloudError,
  DSH_VERSION,
  PROTOCOL,
  TaskInputSchema,
  digest,
  id,
  secret,
  requireValue,
  redact,
  terminalStates,
  type Task,
  type Run,
} from "../../packages/contracts/index.ts";
import { Store } from "./db.ts";
import { Auth } from "./auth.ts";
import { body, json, idempotency, textInput } from "./http.ts";
import { validateRepo, type ControlConfig } from "./config.ts";
import { recoveryState, finishRecovery } from "./recovery.ts";
import { outboxFailure } from "../../packages/contracts/outbox.ts";
import { RESULT_BODY_LIMIT } from "../../packages/contracts/results.ts";
import { UsageMeter } from "./usage.ts";
import { durableWrite } from "../../packages/contracts/storage.ts";

const uuid = z.string().uuid();
const statusBody = z
  .object({
    runId: uuid,
    state: z.enum([
      "accepted",
      "running",
      "waiting_input",
      "finalizing",
      "succeeded",
      "failed",
      "interrupted",
      "uncertain",
    ]),
    messageId: z.string().optional(),
    result: z.any().optional(),
  })
  .strict();
export class ControlService {
  readonly store: Store;
  readonly auth: Auth;
  readonly server;
  private streams = new Set<ServerResponse>();
  private modelInflight = new Set<string>();
  private activeModels = new Set<AbortController>();
  private activeRequests = new Set<Promise<void>>();
  private artifactRoot: string;
  constructor(readonly config: ControlConfig) {
    this.store = new Store(config.database);
    config.templates.forEach((t) => this.store.addTemplate(t));
    this.auth = new Auth(this.store, config);
    this.artifactRoot = resolve(
      config.artifactRoot ?? resolve(dirname(config.database), "artifacts"),
    );
    this.server = createServer((req, res) => {
      const request = this.handle(req, res)
        .catch((error) => {
          if (res.headersSent) {
            res.destroy();
            return;
          }
          const status =
            error instanceof CloudError
              ? error.status
              : error instanceof z.ZodError
                ? 400
                : 500;
          json(
            res,
            {
              error: {
                code:
                  error instanceof CloudError
                    ? error.code
                    : error instanceof z.ZodError
                      ? "VALIDATION"
                      : "INTERNAL",
                message:
                  status === 500 ? "Internal service error" : redact(error),
              },
            },
            status,
          );
          if (status === 500)
            console.error(
              JSON.stringify({
                level: "error",
                path: req.url?.split("?")[0],
                error: redact(error),
              }),
            );
        })
        .finally(() => this.activeRequests.delete(request));
      this.activeRequests.add(request);
    });
    this.server.requestTimeout = 30000;
    this.server.headersTimeout = 15000;
    this.server.maxHeadersCount = 50;
  }
  async listen() {
    await new Promise<void>((done, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off("error", reject);
        done();
      });
    });
    return this.server.address();
  }
  async close() {
    for (const model of this.activeModels) model.abort();
    for (const stream of this.streams) stream.end();
    this.server.closeIdleConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
    await Promise.allSettled(this.activeRequests);
    this.store.close();
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-frame-options", "DENY");
    const url = new URL(req.url ?? "/", this.config.publicUrl),
      path = url.pathname,
      method = req.method ?? "GET";
    if (path === "/healthz") {
      json(res, { ok: true, protocol: PROTOCOL, dshVersion: DSH_VERSION });
      return;
    }
    if (path === "/v1/info" && method === "GET") {
      json(res, {
        login: this.config.development ? "development" : "oidc",
        protocol: PROTOCOL,
        publicUrl: this.config.publicUrl,
        model: this.config.model.name,
      });
      return;
    }
    if (await this.auth.routes(req, res, url)) return;
    if (path === "/model/v1/messages" && method === "POST") {
      await this.model(req, res);
      return;
    }
    if (path === "/v1/runner-pairings/complete" && method === "POST") {
      this.auth.limits.check("pair:" + req.socket.remoteAddress, 10);
      const d = z
        .object({
          code: z.string().min(20).max(100),
          name: z.string().trim().min(1).max(80),
          platform: z.enum(["linux/amd64", "linux/arm64"]),
          protocol: z.literal(PROTOCOL),
          dshVersion: z.literal(DSH_VERSION),
        })
        .strict()
        .parse(await body(req));
      requireValue(
        this.store.one(
          "SELECT hash FROM pairings WHERE hash=? AND expiresAt>?",
          digest(d.code),
          Date.now(),
        ),
        "PAIRING_EXPIRED",
        "Pairing retry window expired",
        400,
      );
      const result = this.store.idempotent(
        "runner-pair",
        digest(d.code),
        d,
        () => {
          const pairing = this.store.one<any>(
            "SELECT * FROM pairings WHERE hash=? AND used=0 AND expiresAt>?",
            digest(d.code),
            Date.now(),
          );
          requireValue(
            pairing,
            "PAIRING_EXPIRED",
            "Pairing code expired or already used",
            400,
          );
          const runnerId = id();
          this.store.exec(
            "UPDATE pairings SET used=1 WHERE hash=?",
            digest(d.code),
          );
          this.store.exec(
            "INSERT INTO runners(id,ownerId,name,platform,lastSeenAt) VALUES (?,?,?,?,?)",
            runnerId,
            pairing.ownerId,
            d.name,
            d.platform,
            Date.now(),
          );
          return {
            runnerId,
            token: this.store.mint("runner", runnerId, null, 365 * 86400000),
          };
        },
      );
      json(res, result, 201);
      return;
    }
    if (path.startsWith("/v1/runner/")) {
      await this.runner(req, res, url);
      return;
    }
    if (path.startsWith("/v1/executor/")) {
      await this.executor(req, res, url);
      return;
    }
    if (path.startsWith("/v1/")) {
      await this.owner(req, res, url);
      return;
    }
    if (
      method === "GET" &&
      (path === "/" ||
        path.startsWith("/tasks/") ||
        ["/app.js", "/style.css"].includes(path))
    ) {
      const file =
        path === "/app.js"
          ? "app.js"
          : path === "/style.css"
            ? "style.css"
            : "index.html";
      res.setHeader(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      res.setHeader(
        "content-type",
        file.endsWith(".js")
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : "text/html; charset=utf-8",
      );
      res.setHeader("cache-control", "no-cache");
      res.end(await readFile(resolve(this.config.webRoot, file)));
      return;
    }
    throw new CloudError(404, "NOT_FOUND", "Not found");
  }
  private async owner(req: IncomingMessage, res: ServerResponse, url: URL) {
    const user = this.auth.authenticate(req),
      s = this.store,
      path = url.pathname,
      method = req.method;
    this.auth.limits.check("owner:" + user.subject, 600);
    if (path === "/v1/recovery" && method === "GET") {
      json(res, {
        mode: recoveryState(s),
        lastRecovery: JSON.parse(
          s.one<any>("SELECT value FROM meta WHERE key='lastRecovery'")
            ?.value ?? "null",
        ),
        runners: s.all(
          "SELECT id,name,lastSeenAt,inventory FROM runners WHERE revoked=0",
        ),
      });
      return;
    }
    if (path === "/v1/recovery/complete" && method === "POST") {
      const d = await body(req);
      requireValue(
        d.acknowledgeUncertain === true,
        "ACK_REQUIRED",
        "Acknowledge that external results and queued inputs require manual review",
      );
      json(res, finishRecovery(s));
      return;
    }
    if (path === "/v1/me" && method === "GET") {
      json(res, { ownerId: user.subject, recovery: recoveryState(s) });
      return;
    }
    if (path === "/v1/templates" && method === "GET") {
      json(
        res,
        s.all<any>("SELECT body FROM templates").map((r) => JSON.parse(r.body)),
      );
      return;
    }
    if (path === "/v1/runners" && method === "GET") {
      json(
        res,
        s.all(
          "SELECT id,name,platform,capacity,lastSeenAt,revoked FROM runners WHERE ownerId=?",
          user.subject,
        ),
      );
      return;
    }
    if (path === "/v1/runner-pairings" && method === "POST") {
      const code = secret();
      s.exec(
        "INSERT INTO pairings VALUES (?,?,?,0)",
        digest(code),
        user.subject,
        Date.now() + 600000,
      );
      json(
        res,
        { code, expiresIn: 600, controlUrl: this.config.publicUrl },
        201,
      );
      return;
    }
    const revoke = path.match(/^\/v1\/runners\/([^/]+)\/revoke$/);
    if (revoke && method === "POST") {
      s.tx(() => {
        const r = s.one<any>(
          "SELECT id FROM runners WHERE id=? AND ownerId=?",
          revoke[1],
          user.subject,
        );
        requireValue(r, "NOT_FOUND", "Runner not found", 404);
        s.exec("UPDATE runners SET revoked=1 WHERE id=?", r.id);
        s.exec(
          "UPDATE credentials SET revoked=1 WHERE kind='runner' AND subject=?",
          r.id,
        );
        for (const t of s.all<Task>(
          "SELECT * FROM tasks WHERE runnerId=?",
          r.id,
        )) {
          s.exec(
            "UPDATE tasks SET paused=1,environmentState='needs_stop' WHERE id=?",
            t.id,
          );
          s.event(t.id, "runner.revoked", {});
        }
      });
      json(res, { ok: true });
      return;
    }
    if (path === "/v1/tasks" && method === "GET") {
      json(
        res,
        s.all(
          "SELECT t.*,r.name AS runnerName,r.lastSeenAt FROM tasks t JOIN runners r ON r.id=t.runnerId WHERE t.ownerId=? AND t.lifecycle!=? ORDER BY t.updatedAt DESC LIMIT 500",
          user.subject,
          "deleted",
        ),
      );
      return;
    }
    if (path === "/v1/tasks" && method === "POST") {
      const input = TaskInputSchema.parse(await body(req));
      validateRepo(input.repo, this.config);
      json(
        res,
        s.createTask(user.subject, input, idempotency(req), this.config.model),
        202,
      );
      return;
    }
    const runMatch = path.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
    if (runMatch && method === "POST") {
      const r = s.one<Run>("SELECT * FROM runs WHERE id=?", runMatch[1]);
      requireValue(r, "NOT_FOUND", "Run not found", 404);
      s.task(r.taskId, user.subject);
      const result = s.idempotent(
        `${user.subject}:cancel:${r.id}`,
        idempotency(req),
        {},
        () => {
          const current = s.one<Run>("SELECT * FROM runs WHERE id=?", r.id)!;
          if (terminalStates.includes(current.state as any))
            return { state: current.state };
          const state = current.state === "queued" ? "cancelled" : "cancelling";
          s.exec(
            "UPDATE runs SET state=?,endedAt=? WHERE id=?",
            state,
            state === "cancelled" ? Date.now() : null,
            r.id,
          );
          s.exec("UPDATE tasks SET paused=1 WHERE id=?", r.taskId);
          s.event(r.taskId, "run." + state, { runId: r.id }, r.id);
          return { state };
        },
      );
      json(res, result, 202);
      return;
    }
    const answerMatch = path.match(/^\/v1\/interactions\/([^/]+)\/answers$/);
    if (answerMatch && method === "POST") {
      const d = z
        .object({ version: z.number().int(), answer: z.any() })
        .strict()
        .parse(await body(req));
      const result = s.tx(() => {
        const i = s.one<any>(
          "SELECT * FROM interactions WHERE id=?",
          answerMatch[1],
        );
        requireValue(i, "NOT_FOUND", "Interaction not found", 404);
        const t = s.task(i.taskId, user.subject);
        requireValue(
          i.state === "pending" &&
            i.version === d.version &&
            i.expiresAt > Date.now() &&
            i.incarnation === t.incarnation &&
            t.currentRunId === i.runId,
          "INTERACTION_STALE",
          "This question has already been answered or expired",
        );
        if (i.kind === "approval")
          z.object({
            outcome: z.enum(["allowed-once", "rejected", "cancelled"]),
          })
            .strict()
            .parse(d.answer);
        else {
          const a = z
            .union([
              z.object({ cancelled: z.literal(true) }).strict(),
              z
                .object({
                  answers: z.array(
                    z
                      .object({
                        id: z.string(),
                        selected: z.array(z.string()),
                        custom: z.string().optional(),
                      })
                      .strict(),
                  ),
                })
                .strict(),
            ])
            .parse(d.answer);
          if ("answers" in a) {
            const questions = JSON.parse(i.body).questions ?? [];
            requireValue(
              a.answers.length === questions.length &&
                new Set(a.answers.map((x) => x.id)).size === questions.length &&
                a.answers.every((x) =>
                  questions.some((q: any) => q.id === x.id),
                ),
              "INVALID_ANSWER",
              "Answer every question exactly once",
              400,
            );
          }
        }
        s.exec(
          "UPDATE interactions SET state='submitted',answer=?,version=version+1 WHERE id=?",
          JSON.stringify(d.answer),
          i.id,
        );
        s.event(t.id, "interaction.answered", { id: i.id }, i.runId);
        return { state: "submitted" };
      });
      json(res, result);
      return;
    }
    const retryMatch = path.match(/^\/v1\/operations\/([^/]+)\/retry$/);
    if (retryMatch && method === "POST") {
      const op = s.one<any>(
        "SELECT * FROM operations WHERE id=?",
        retryMatch[1],
      );
      requireValue(op, "NOT_FOUND", "Operation not found", 404);
      const t = s.task(op.taskId, user.subject);
      requireValue(
        ["failed", "unknown"].includes(op.state),
        "OPERATION_ACTIVE",
        "Only unsuccessful operations can be retried",
      );
      requireValue(!t.currentRunId, "RUN_ACTIVE", "Wait for the active run");
      json(
        res,
        s.idempotent(
          `${user.subject}:retry:${op.id}`,
          idempotency(req),
          {},
          () => this.operation(op.taskId, op.kind, JSON.parse(op.request)),
        ),
        202,
      );
      return;
    }
    const opMatch = path.match(/^\/v1\/operations\/([^/]+)$/);
    if (opMatch && method === "GET") {
      const op = s.one<any>("SELECT * FROM operations WHERE id=?", opMatch[1]);
      requireValue(op, "NOT_FOUND", "Operation not found", 404);
      s.task(op.taskId, user.subject);
      json(res, {
        ...op,
        request: JSON.parse(op.request),
        result: op.result ? JSON.parse(op.result) : null,
      });
      return;
    }
    const artifactMatch = path.match(/^\/v1\/artifacts\/([^/]+)$/);
    if (artifactMatch && method === "GET") {
      const a = s.one<any>(
        "SELECT * FROM artifacts WHERE id=?",
        artifactMatch[1],
      );
      requireValue(a, "NOT_FOUND", "Artifact not found", 404);
      s.task(a.taskId, user.subject);
      const raw =
        a.body === "@file"
          ? await readFile(
              resolve(this.artifactRoot, uuid.parse(a.id) + ".json"),
              "utf8",
            )
          : a.body;
      requireValue(
        digest(raw) === a.hash,
        "ARTIFACT_CORRUPT",
        "Saved artifact checksum does not match",
        500,
      );
      json(res, { ...a, body: JSON.parse(raw) });
      return;
    }
    const match = path.match(/^\/v1\/tasks\/([^/]+)(?:\/(.*))?$/);
    requireValue(match, "NOT_FOUND", "Not found", 404);
    const taskId = uuid.parse(match[1]),
      action = match[2] ?? "",
      task = s.task(taskId, user.subject);
    if (!action && method === "GET") {
      json(res, s.snapshot(taskId, user.subject));
      return;
    }
    if (action === "events" && method === "GET") {
      this.events(req, res, url, taskId, user.token);
      return;
    }
    if (action === "events/poll" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? 0),
        max = s.one<any>(
          "SELECT COALESCE(MAX(taskSeq),0) AS n FROM events WHERE taskId=?",
          taskId,
        )!.n;
      requireValue(
        Number.isSafeInteger(after) && after >= 0 && after <= max,
        "INVALID_CURSOR",
        "Reload the task: event cursor is invalid",
        409,
      );
      json(res, {
        events: s
          .all<any>(
            "SELECT * FROM events WHERE taskId=? AND taskSeq>? ORDER BY taskSeq LIMIT 200",
            taskId,
            after,
          )
          .map((e) => ({ ...e, payload: JSON.parse(e.payload) })),
      });
      return;
    }
    if (action === "history" && method === "GET") {
      const after = Number(url.searchParams.get("after") ?? -1);
      requireValue(
        Number.isSafeInteger(after) && after >= -1,
        "INVALID_CURSOR",
        "Invalid history cursor",
        400,
      );
      json(res, {
        header: (() => { const h = s.one<any>("SELECT body FROM native_headers WHERE taskId=?", taskId); return h ? JSON.parse(h.body) : null; })(),
        events: s
          .all<any>(
            "SELECT payload FROM native_events WHERE taskId=? AND nativeSeq>? ORDER BY nativeSeq LIMIT 300",
            taskId,
            after,
          )
          .map((r) => JSON.parse(r.payload)),
        durableSeq: task.durableSeq,
      });
      return;
    }
    if (action === "title" && method === "POST") {
      const d = z.object({ title: z.string().trim().min(1).max(120) }).strict().parse(await body(req));
      s.tx(() => { s.exec("UPDATE tasks SET title=? WHERE id=?", d.title, taskId); s.event(taskId, "task.renamed", d); });
      json(res, d); return;
    }
    if (action === "inputs" && method === "POST") {
      const d = z
        .object({
          input: textInput,
          requestId: uuid.optional(),
          kind: z.enum(["normal", "recovery"]).default("normal"),
          previousRunId: uuid.optional(),
          acknowledgeUncertain: z.boolean().optional(),
        })
        .strict()
        .parse(await body(req));
      const result = s.idempotent(
        `${user.subject}:input:${taskId}`,
        idempotency(req),
        d,
        () => {
          s.assertModelRoute(taskId, this.config.model);
          const t = s.task(taskId);
          if (d.kind === "recovery") {
            requireValue(
              t.environmentState !== "needs_stop",
              "STOP_UNCONFIRMED",
              "Wait for the Runner to confirm the original runtime stopped",
            );
            requireValue(
              !t.currentRunId,
              "RUN_ACTIVE",
              "Wait until the original execution has stopped",
            );
            const prior = s.one<Run>(
              "SELECT * FROM runs WHERE id=? AND taskId=?",
              d.previousRunId ?? "",
              taskId,
            );
            requireValue(
              prior &&
                (t.recoveryRequired ? prior.id === t.recoveryRunId && (terminalStates.includes(prior.state as any) || prior.state === "queued") :
                  ["interrupted", "uncertain", "cancelled", "failed"].includes(prior.state)),
              "INVALID_RECOVERY",
              "Select a failed or interrupted Run",
            );
            requireValue(
              (prior.state !== "uncertain" && t.recoveryReason !== "database_restore") || d.acknowledgeUncertain,
              "UNCERTAIN_ACK_REQUIRED",
              "Acknowledge the uncertain external result before continuing",
            );
            for (const queued of s.all<any>(
              "SELECT id FROM runs WHERE taskId=? AND state='queued'",
              taskId,
            )) {
              s.exec(
                "UPDATE runs SET state='cancelled',endedAt=? WHERE id=?",
                Date.now(),
                queued.id,
              );
              s.event(
                taskId,
                "run.cancelled",
                { runId: queued.id, reason: "superseded_by_recovery" },
                queued.id,
              );
            }
            s.exec("UPDATE tasks SET paused=0,recoveryRequired=0,recoveryRunId=NULL,recoveryReason=NULL WHERE id=?", taskId);
          } else {
            s.assertRecovered(taskId);
            requireValue(
              !t.paused,
              "QUEUE_PAUSED",
              "Resume the task or submit a recovery input",
            );
          }
          const run = s.enqueue(
            taskId,
            d.input,
            d.kind,
            d.previousRunId ?? null,
          );
          if (d.requestId) s.exec("INSERT INTO run_requests VALUES (?,?)", run.id, d.requestId);
          return { taskId, runId: run.id };
        },
      );
      json(res, result, 202);
      return;
    }
    if (action === "queue/resume" && method === "POST") {
      s.tx(() => {
        requireValue(
          !task.currentRunId && task.environmentState !== "needs_stop",
          "RUN_ACTIVE",
          "Wait for the original execution to stop",
        );
        s.assertRecovered(taskId);
        s.exec("UPDATE tasks SET paused=0 WHERE id=?", taskId);
        s.event(taskId, "queue.resumed", {});
      });
      json(res, { ok: true });
      return;
    }
    if (action === "lifecycle" && method === "POST") {
      const d = z
        .object({ action: z.enum(["archive", "reopen", "delete"]) })
        .strict()
        .parse(await body(req));
      const result = s.idempotent(
        `${user.subject}:lifecycle:${taskId}`,
        idempotency(req),
        d,
        () => {
          const t = s.task(taskId);
          requireValue(
            !t.currentRunId,
            "RUN_ACTIVE",
            "Cancel the active Run first",
          );
          requireValue(
            t.lifecycle !== "deleted",
            "TASK_DELETED",
            "Deleted tasks cannot be reopened",
            410,
          );
          const lifecycle =
            d.action === "archive"
              ? "archived"
              : d.action === "reopen"
                ? "open"
                : "delete_pending";
          s.exec(
            "UPDATE tasks SET lifecycle=? WHERE id=?",
            lifecycle,
            taskId,
          );
          s.event(taskId, "task." + lifecycle, {});
          if (d.action === "delete")
            return this.operation(taskId, "delete", {});
          return { lifecycle };
        },
      );
      json(res, result, 202);
      return;
    }
    if (action === "environment/retry-setup" && method === "POST") {
      requireValue(
        ["stopped", "error"].includes(task.environmentState) &&
          !task.currentRunId,
        "STOP_UNCONFIRMED",
        "Stop the environment before retrying setup",
      );
      json(
        res,
        s.idempotent(
          `${user.subject}:setup:${taskId}`,
          idempotency(req),
          {},
          () => this.operation(taskId, "retry-setup", {}),
        ),
        202,
      );
      return;
    }
    if (action === "environment/stop" && method === "POST") {
      requireValue(
        !task.currentRunId,
        "RUN_ACTIVE",
        "Cancel the active Run before stopping the environment",
      );
      json(
        res,
        s.idempotent(
          `${user.subject}:stop:${taskId}`,
          idempotency(req),
          {},
          () => this.operation(taskId, "stop", {}),
        ),
        202,
      );
      return;
    }
    if ((action === "files" || action === "diff") && method === "GET") {
      const runner = s.one<any>(
        "SELECT lastSeenAt,revoked FROM runners WHERE id=?",
        task.runnerId,
      );
      if (runner.revoked || Date.now() - runner.lastSeenAt > 30000) {
        json(res, {
          offline: true,
          lastSeenAt: runner.lastSeenAt,
          artifacts: s.all(
            "SELECT id,kind,revision,createdAt FROM artifacts WHERE taskId=? ORDER BY createdAt DESC LIMIT 20",
            taskId,
          ),
        });
        return;
      }
      const request = {
        kind:
          action === "diff"
            ? "diff"
            : url.searchParams.has("path")
              ? "file"
              : "files",
        path: url.searchParams.get("path") ?? "",
      };
      json(
        res,
        s.tx(() => this.operation(taskId, "inspect", request)),
        202,
      );
      return;
    }
    if (action === "publications" && method === "POST") {
      const d = z
        .object({
          runId: uuid,
          workspaceRevision: z.string().min(1),
          allowFailedChecks: z.boolean().default(false),
        })
        .strict()
        .parse(await body(req));
      const result = s.idempotent(
        `${user.subject}:publish:${taskId}`,
        idempotency(req),
        d,
        () => {
          const t = s.task(taskId);
          requireValue(
            !t.currentRunId,
            "RUN_ACTIVE",
            "Wait for the current Run",
          );
          requireValue(
            t.workspaceRevision === d.workspaceRevision,
            "STALE_WORKSPACE",
            "Refresh the workspace before publishing",
          );
          const r = s.one<Run>(
            "SELECT * FROM runs WHERE id=? AND taskId=?",
            d.runId,
            taskId,
          );
          requireValue(r?.result, "RESULT_REQUIRED", "Run has no saved result");
          const result = JSON.parse(r.result);
          requireValue(
            result.workspaceRevision === d.workspaceRevision,
            "STALE_RESULT",
            "Checks belong to a different workspace revision",
          );
          requireValue(
            d.allowFailedChecks ||
              !(result.checks ?? []).some(
                (c: any) => c.required && c.state !== "passed",
              ),
            "CHECKS_FAILED",
            "Required checks did not pass",
          );
          requireValue(
            !s.one(
              "SELECT id FROM operations WHERE taskId=? AND kind='publish' AND state IN ('pending','running')",
              taskId,
            ),
            "PUBLICATION_ACTIVE",
            "A publication is already pending",
          );
          return this.operation(taskId, "publish", d);
        },
      );
      json(res, result, 202);
      return;
    }
    throw new CloudError(404, "NOT_FOUND", "Not found");
  }
  private operation(taskId: string, kind: string, request: unknown) {
    const operationId = id(),
      now = Date.now();
    this.store.exec(
      "INSERT INTO operations VALUES (?,?,?,?,?,NULL,?,?)",
      operationId,
      taskId,
      kind,
      JSON.stringify(request),
      "pending",
      now,
      now,
    );
    this.store.event(taskId, "operation.queued", { operationId, kind });
    return { operationId };
  }
  private events(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    taskId: string,
    token: string,
  ) {
    let after = Number(
      req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0,
    );
    requireValue(
      Number.isSafeInteger(after) && after >= 0,
      "INVALID_CURSOR",
      "Invalid event cursor",
      400,
    );
    const max = this.store.one<any>(
      "SELECT COALESCE(MAX(taskSeq),0) AS n FROM events WHERE taskId=?",
      taskId,
    )!.n;
    requireValue(
      after <= max,
      "CURSOR_AHEAD",
      "Reload the task snapshot: cursor is ahead of saved history",
    );
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    this.streams.add(res);
    let blocked = false;
    const send = () => {
      if (blocked || res.writableEnded) return;
      try {
        if (!(this.config.development && this.config.devToken === token))
          this.store.auth(token);
        const rows = this.store.all<any>(
          "SELECT * FROM events WHERE taskId=? AND taskSeq>? ORDER BY taskSeq LIMIT 200",
          taskId,
          after,
        );
        for (const row of rows) {
          requireValue(
            row.taskSeq === after + 1,
            "EVENT_GAP",
            "Event history gap",
          );
          after = row.taskSeq;
          const ok = res.write(
            `id: ${row.taskSeq}\nevent: task\ndata: ${JSON.stringify({ ...row, payload: JSON.parse(row.payload) })}\n\n`,
          );
          if (!ok) {
            blocked = true;
            res.once("drain", () => {
              blocked = false;
              send();
            });
            break;
          }
        }
      } catch {
        res.end();
      }
    };
    send();
    const timer = setInterval(send, 300),
      heartbeat = setInterval(() => {
        if (!blocked) res.write(": heartbeat\n\n");
      }, 15000);
    res.on("close", () => {
      clearInterval(timer);
      clearInterval(heartbeat);
      this.streams.delete(res);
    });
  }
  private async runner(req: IncomingMessage, res: ServerResponse, url: URL) {
    if (
      url.pathname === "/v1/runner/revoked-stopped" &&
      req.method === "POST"
    ) {
      const token = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : "";
      const credential = this.store.one<any>(
        "SELECT c.subject FROM credentials c JOIN runners r ON r.id=c.subject WHERE c.hash=? AND c.kind='runner' AND r.revoked=1",
        digest(token),
      );
      requireValue(
        credential,
        "UNAUTHORIZED",
        "Revoked Runner credential required",
        401,
      );
      const data = z
        .object({ allContainersStopped: z.literal(true) })
        .strict()
        .parse(await body(req));
      this.store.tx(() => {
        for (const t of this.store.all<Task>(
          "SELECT * FROM tasks WHERE runnerId=?",
          credential.subject,
        )) {
          if (t.currentRunId) {
            this.store.requireRecovery(t.id, t.currentRunId, "interrupted");
            const result = JSON.stringify({
              error:
                "Runner revoked; supervisor confirmed all containers stopped",
            });
            this.store.exec(
              "UPDATE runs SET state='interrupted',result=?,endedAt=? WHERE id=?",
              result,
              Date.now(),
              t.currentRunId,
            );
            this.store.exec(
              "UPDATE attempts SET endedAt=?,outcome='interrupted' WHERE runId=?",
              Date.now(),
              t.currentRunId,
            );
          }
          this.store.exec(
            "UPDATE tasks SET currentRunId=NULL,paused=1,environmentState='stopped' WHERE id=?",
            t.id,
          );
          this.store.exec(
            "UPDATE interactions SET state='expired' WHERE taskId=?",
            t.id,
          );
          this.store.event(t.id, "runner.revocation_stopped", {});
        }
      });
      json(res, { ok: true });
      return;
    }
    const c = this.auth.authenticate(req, "runner"),
      s = this.store,
      path = url.pathname,
      method = req.method,
      runnerId = c.subject;
    if (path === "/v1/runner/heartbeat" && method === "POST") {
      const d = z
        .object({
          protocol: z.literal(PROTOCOL),
          dshVersion: z.literal(DSH_VERSION),
          capacity: z.number().int().min(1).max(64),
          inventory: z
            .array(
              z
                .object({
                  taskId: uuid,
                  epoch: z.number().int(),
                  incarnation: z.string(),
                  running: z.boolean(),
                })
                .strict(),
            )
            .max(1000),
        })
        .strict()
        .parse(await body(req));
      s.tx(() => {
        s.exec(
          "UPDATE runners SET lastSeenAt=?,capacity=?,inventory=? WHERE id=?",
          Date.now(),
          d.capacity,
          JSON.stringify(d.inventory),
          runnerId,
        );
        for (const item of d.inventory) {
          const t = s.one<Task>(
            "SELECT * FROM tasks WHERE id=? AND runnerId=?",
            item.taskId,
            runnerId,
          );
          if (
            !t ||
            t.epoch !== item.epoch ||
            t.incarnation !== item.incarnation
          ) {
            if (t) {
              s.exec("UPDATE tasks SET paused=1 WHERE id=?", t.id);
              s.event(t.id, "environment.reconcile_required", {
                observed: item,
              });
            }
          } else {
            s.exec(
              "UPDATE credentials SET expiresAt=? WHERE kind='executor' AND subject=? AND scope=? AND revoked=0",
              Date.now() + 3600000,
              t.id,
              JSON.stringify({ epoch: t.epoch, incarnation: t.incarnation }),
            );
          }
        }
      });
      json(res, { ok: true });
      return;
    }
    if (path === "/v1/runner/reconciled" && method === "POST") {
      const d = await body(req),
        mode = recoveryState(s),
        r = s.one<any>("SELECT * FROM runners WHERE id=?", runnerId);
      requireValue(
        mode?.id === d.restoreId,
        "RESTORE_CHANGED",
        "Recovery identifier changed",
      );
      requireValue(
        Date.now() - r.lastSeenAt < 30000 &&
          !JSON.parse(r.inventory).some((c: any) => c.running),
        "STOP_UNCONFIRMED",
        "Confirm a fresh stopped inventory",
      );
      s.exec(
        "INSERT OR REPLACE INTO meta VALUES (?,?)",
        "reconciled:" + runnerId,
        mode.id,
      );
      json(res, { ok: true });
      return;
    }
    if (path === "/v1/runner/work" && method === "GET") {
      const recovery = recoveryState(s);
      if (recovery) {
        json(res, { tasks: [], operations: [], recovery });
        return;
      }
      const tasks = s.all<Task>(
        "SELECT * FROM tasks WHERE runnerId=? AND lifecycle!=?",
        runnerId,
        "deleted",
      );
      json(res, {
        tasks: tasks.map((t) => ({
          ...t,
          template: s.template(t.templateId, t.templateVersion),
          publication:
            s.one("SELECT * FROM publications WHERE taskId=?", t.id) ?? null,
          queued: s.one<any>(
            "SELECT COUNT(*) AS n FROM runs WHERE taskId=? AND state='queued'",
            t.id,
          )!.n,
          cancelRequested: !!s.one(
            "SELECT id FROM runs WHERE taskId=? AND state='cancelling'",
            t.id,
          ),
        })),
        operations: s
          .all<any>(
            "SELECT o.* FROM operations o JOIN tasks t ON t.id=o.taskId WHERE t.runnerId=? AND o.state IN ('pending','running') ORDER BY o.createdAt",
            runnerId,
          )
          .map((o) => ({ ...o, request: JSON.parse(o.request) })),
      });
      return;
    }
    const env = path.match(
      /^\/v1\/runner\/environments\/([^/]+)\/(start|stopped|provisioned|error)$/,
    );
    if (env && method === "POST") {
      const task = s.task(env[1]);
      requireValue(
        task.runnerId === runnerId,
        "FORBIDDEN",
        "Wrong Runner",
        403,
      );
      if (env[2] === "start") {
        s.assertModelRoute(task.id, this.config.model);
        requireValue(
          !recoveryState(s),
          "RECONCILIATION_REQUIRED",
          "Database recovery blocks new environments",
        );
        const d = z
          .object({
            operationId: uuid,
            previousEpoch: z.number().int(),
            previousContainerStopped: z.literal(true),
          })
          .strict()
          .parse(await body(req));
        const result = s.idempotent(
          `runner:${runnerId}:start:${task.id}`,
          d.operationId,
          d,
          () => {
            const t = s.task(task.id);
            requireValue(
              t.epoch === d.previousEpoch && !t.currentRunId,
              "ENVIRONMENT_ACTIVE",
              "Original environment must be reconciled and stopped before replacement",
            );
            requireValue(
              ["provisioning", "stopped", "error"].includes(t.environmentState),
              "ENVIRONMENT_ACTIVE",
              "Environment is still active",
            );
            const epoch = t.epoch + 1,
              incarnation = id();
            s.exec(
              "UPDATE tasks SET epoch=?,incarnation=?,environmentState=? WHERE id=?",
              epoch,
              incarnation,
              "provisioning",
              t.id,
            );
            s.exec(
              "UPDATE interactions SET state='expired',version=version+1 WHERE taskId=? AND state IN ('pending','submitted')",
              t.id,
            );
            s.event(t.id, "environment.starting", { epoch, incarnation });
            return {
              task: s.task(t.id),
              template: s.template(t.templateId, t.templateVersion),
              epoch,
              incarnation,
              token: s.mint("executor", t.id, { epoch, incarnation }, 3600000),
              model: this.config.model.name,
            };
          },
        );
        json(res, result);
        return;
      }
      const d = z
        .object({
          epoch: z.number().int(),
          incarnation: z.string(),
          baseCommit: z.string().optional(),
          reason: z.string().max(4000).optional(),
          confirmedStopped: z.boolean().optional(),
          result: z.any().optional(),
        })
        .strict()
        .parse(await body(req));
      s.fence(task.id, d.epoch, d.incarnation);
      if (env[2] === "provisioned") {
        requireValue(
          d.baseCommit && /^[0-9a-f]{40,64}$/.test(d.baseCommit),
          "INVALID_COMMIT",
          "Expected resolved commit",
          400,
        );
        requireValue(
          !task.baseCommit || task.baseCommit === d.baseCommit,
          "BASE_COMMIT_CHANGED",
          "Task base commit cannot change",
        );
        s.exec(
          "UPDATE tasks SET baseCommit=? WHERE id=?",
          d.baseCommit,
          task.id,
        );
        json(res, { ok: true });
        return;
      }
      requireValue(
        d.confirmedStopped,
        "STOP_UNCONFIRMED",
        "Runner must confirm the container process tree has exited",
      );
      const current = s.task(task.id);
      if (current.currentRunId) {
        const r = s.one<Run>(
          "SELECT * FROM runs WHERE id=?",
          current.currentRunId,
        )!;
        s.complete(
          task.id,
          d.epoch,
          d.incarnation,
          r.id,
          r.state === "cancelling" ? "cancelled" : "interrupted",
          d.result ?? {
            error: d.reason ?? "Runtime stopped",
            durableSeq: current.durableSeq,
          },
        );
      }
      s.tx(() => {
        s.exec(
          "UPDATE tasks SET environmentState=?,paused=? WHERE id=?",
          env[2] === "error" ? "error" : "stopped",
          env[2] === "error" ? 1 : s.task(task.id).paused,
          task.id,
        );
        s.exec(
          "UPDATE interactions SET state='expired',version=version+1 WHERE taskId=? AND state IN ('pending','submitted')",
          task.id,
        );
        s.event(
          task.id,
          "environment." + (env[2] === "error" ? "error" : "stopped"),
          { reason: d.reason ?? null },
        );
      });
      json(res, { ok: true });
      return;
    }
    const op = path.match(
      /^\/v1\/runner\/operations\/([^/]+)\/(claim|result)$/,
    );
    if (op && method === "POST") {
      const row = s.one<any>(
        "SELECT o.* FROM operations o JOIN tasks t ON t.id=o.taskId WHERE o.id=? AND t.runnerId=?",
        op[1],
        runnerId,
      );
      requireValue(row, "NOT_FOUND", "Operation not found", 404);
      if (op[2] === "claim") {
        requireValue(
          ["pending", "running"].includes(row.state),
          "OPERATION_FINISHED",
          "Operation already finished",
        );
        if (["publish", "stop", "delete"].includes(row.kind))
          requireValue(
            !s.task(row.taskId).currentRunId,
            "RUN_ACTIVE",
            "Wait for execution to finish",
          );
        s.exec(
          "UPDATE operations SET state='running',updatedAt=? WHERE id=?",
          Date.now(),
          row.id,
        );
        json(res, { ...row, request: JSON.parse(row.request) });
        return;
      }
      const d = z
        .object({
          state: z.enum(["succeeded", "failed", "unknown"]),
          result: z.any(),
        })
        .strict()
        .parse(await body(req, 12 * 1024 * 1024));
      const deletedArtifacts =
        row.kind === "delete" && d.state === "succeeded"
          ? s.all<any>("SELECT id FROM artifacts WHERE taskId=?", row.taskId)
          : [];
      s.tx(() => {
        if (!["pending", "running"].includes(row.state)) {
          requireValue(
            row.state === d.state &&
              digest(JSON.parse(row.result)) === digest(d.result),
            "RESULT_CONFLICT",
            "Operation has a different result",
          );
          return;
        }
        s.exec(
          "UPDATE operations SET state=?,result=?,updatedAt=? WHERE id=?",
          d.state,
          JSON.stringify(d.result),
          Date.now(),
          row.id,
        );
        if (row.kind === "publish" && d.state === "succeeded")
          s.exec(
            "INSERT INTO publications VALUES (?,?,?,?,?,?,?) ON CONFLICT(taskId) DO UPDATE SET commitId=excluded.commitId,prId=excluded.prId,url=excluded.url,state=excluded.state,operationId=excluded.operationId",
            row.taskId,
            s.task(row.taskId).branch,
            d.result.commit ?? null,
            d.result.prId ? String(d.result.prId) : null,
            d.result.url ?? null,
            d.state,
            row.id,
          );
        if (row.kind === "retry-setup" && d.state === "succeeded")
          s.exec("UPDATE tasks SET paused=0 WHERE id=? AND recoveryRequired=0", row.taskId);
        if (row.kind === "delete" && d.state === "succeeded") {
          s.exec(
            "UPDATE tasks SET lifecycle='deleted',environmentState='deleted' WHERE id=?",
            row.taskId,
          );
          s.exec("DELETE FROM artifacts WHERE taskId=?", row.taskId);
          s.exec("DELETE FROM native_events WHERE taskId=?", row.taskId);
          s.exec("DELETE FROM native_headers WHERE taskId=?", row.taskId);
          s.exec("DELETE FROM run_requests WHERE runId IN (SELECT id FROM runs WHERE taskId=?)", row.taskId);
          s.exec("DELETE FROM events WHERE taskId=?", row.taskId);
          s.exec(
            "UPDATE runs SET input='',result=NULL WHERE taskId=?",
            row.taskId,
          );
          s.exec("DELETE FROM interactions WHERE taskId=?", row.taskId);
          s.exec(
            "UPDATE operations SET request='{}',result=NULL WHERE taskId=? AND id!=?",
            row.taskId,
            row.id,
          );
          s.exec(
            "DELETE FROM credentials WHERE kind='executor' AND subject=?",
            row.taskId,
          );
          s.exec(
            "DELETE FROM idempotency WHERE scope LIKE 'runner:%' AND scope LIKE ?",
            "%" + row.taskId + "%",
          );
        }
        s.event(row.taskId, "operation." + d.state, {
          operationId: row.id,
          kind: row.kind,
          result: d.result,
        });
      });
      for (const a of deletedArtifacts)
        await rm(resolve(this.artifactRoot, a.id + ".json"), { force: true });
      json(res, { ok: true });
      return;
    }
    throw new CloudError(404, "NOT_FOUND", "Not found");
  }
  private async executor(req: IncomingMessage, res: ServerResponse, url: URL) {
    const c = this.auth.authenticate(req, "executor"),
      s = this.store,
      t = s.fence(c.subject, c.scope.epoch, c.scope.incarnation),
      path = url.pathname,
      method = req.method;
    const epoch = c.scope.epoch,
      incarnation = c.scope.incarnation;
    if (path === "/v1/executor/hello" && method === "POST") {
      const d = z
        .object({
          protocol: z.literal(PROTOCOL),
          dshVersion: z.literal(DSH_VERSION),
          journalRunId: uuid.nullable(),
          phase: z.string(),
          restoreId: uuid.nullable().optional(),
        })
        .strict()
        .parse(await body(req));
      const restoredJournal = !!t.restoreId && t.restoreId !== (d.restoreId ?? null);
      const uncertain = !restoredJournal && !!(
        d.journalRunId &&
        d.journalRunId !== t.currentRunId &&
        !s.one(
          "SELECT id FROM runs WHERE id=? AND taskId=? AND state IN ('succeeded','failed','interrupted','uncertain','cancelled')",
          d.journalRunId,
          t.id,
        )
      );
      if (uncertain) {
        s.exec("UPDATE tasks SET paused=1 WHERE id=?", t.id);
        s.event(t.id, "environment.reconcile_required", {
          journalRunId: d.journalRunId,
        });
      } else
        s.exec(
          "UPDATE tasks SET environmentState=CASE WHEN environmentState='needs_stop' THEN environmentState WHEN currentRunId IS NULL THEN 'ready' ELSE 'busy' END WHERE id=?",
          t.id,
        );
      json(res, {
        task: s.task(t.id),
        reconcileRequired: uncertain,
        durableSeq: t.durableSeq,
      });
      return;
    }
    if (path === "/v1/executor/renew" && method === "POST") {
      s.exec(
        "UPDATE credentials SET expiresAt=? WHERE hash=?",
        Date.now() + 3600000,
        digest(c.token),
      );
      json(res, { token: c.token, expiresIn: 3600 });
      return;
    }
    if (path === "/v1/executor/reconciliation" && method === "POST") {
      const d = z.object({
        id: z.string().regex(/^[a-f0-9]{64}$/), path: z.string().max(300),
        code: z.string().max(100), status: z.number().int().min(400).max(499),
        runId: uuid.nullable(), restoreId: uuid.nullable(),
        bodyHash: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(),
      }).strict().parse(await body(req));
      const failure = outboxFailure(new CloudError(d.status, d.code, d.code), d, t.restoreId);
      requireValue(failure, "RETRY_REQUIRED", "This delivery error is retryable");
      const result = s.idempotent(`outbox:${t.id}`, d.id, d, () => {
        if (failure.blocking) {
          const prior = t.currentRunId ?? s.one<any>("SELECT id FROM runs WHERE taskId=? ORDER BY ordinal DESC LIMIT 1", t.id)?.id ?? null;
          s.requireRecovery(t.id, prior, "delivery_rejected");
          s.exec("UPDATE tasks SET environmentState='needs_stop' WHERE id=?", t.id);
        }
        s.event(t.id, "outbox.reconciliation", { ...d, ...failure, evidence: "executor/journal.sqlite:rejected_outbox" });
        return { ok: true, ...failure };
      });
      json(res, result);
      return;
    }
    if (path === "/v1/executor/commands" && method === "GET") {
      const runner = s.one<any>(
        "SELECT lastSeenAt FROM runners WHERE id=?",
        t.runnerId,
      );
      const active = Date.now() - runner.lastSeenAt < 30000;
      if (active && !t.currentRunId && !recoveryState(s))
        s.assertModelRoute(t.id, this.config.model);
      const current = recoveryState(s)
        ? null
        : active
          ? s.nextRun(t.id, epoch, incarnation)
          : t.currentRunId
            ? {
                run: s.one<Run>(
                  "SELECT * FROM runs WHERE id=?",
                  t.currentRunId,
                ),
                cancelled:
                  s.one<Run>("SELECT * FROM runs WHERE id=?", t.currentRunId)!
                    .state === "cancelling",
              }
            : null;
      json(res, {
        current,
        paused: t.paused,
        answers: s
          .all<any>(
            "SELECT id,runId,answer,incarnation FROM interactions WHERE taskId=? AND incarnation=? AND state IN ('submitted','delivered')",
            t.id,
            incarnation,
          )
          .map((a) => ({ ...a, answer: JSON.parse(a.answer) })),
      });
      return;
    }
    if (path === "/v1/executor/events" && method === "POST") {
      const d = z
        .object({ events: z.array(z.any()).max(1000), runId: uuid.nullable(), header: z.object({ id: uuid, version: z.number().int(), createdAt: z.number(), cwd: z.string().optional(), isSeeded: z.boolean(), delegationDepth: z.number().optional() }).passthrough().optional() })
        .strict()
        .parse(await body(req, 20 * 1024 * 1024));
      if (d.header) {
        requireValue(d.header.id === t.sessionId, "SESSION_MISMATCH", "Native header belongs to another Session");
        const prior = s.one<any>("SELECT body FROM native_headers WHERE taskId=?", t.id);
        requireValue(!prior || digest(JSON.parse(prior.body)) === digest(d.header), "HEADER_CONFLICT", "Native Session header changed");
        s.exec("INSERT OR IGNORE INTO native_headers VALUES (?,?)", t.id, JSON.stringify(d.header));
      }
      json(res, s.ingest(t.id, epoch, incarnation, d.events, d.runId));
      return;
    }
    if (path === "/v1/executor/status" && method === "POST") {
      const d = statusBody.parse(await body(req, RESULT_BODY_LIMIT));
      if (terminalStates.includes(d.state as any)) {
        const result = s.complete(
          t.id,
          epoch,
          incarnation,
          d.runId,
          d.state,
          d.result ?? {},
        );
        if (
          d.state === "succeeded" &&
          t.deliveryPolicy === "draft-pr" &&
          !(d.result?.checks ?? []).some(
            (check: any) => check.required && check.state !== "passed",
          )
        ) {
          const key = `auto-publish:${d.runId}`;
          s.idempotent("system:publish", key, { runId: d.runId }, () =>
            this.operation(t.id, "publish", {
              runId: d.runId,
              workspaceRevision: d.result.workspaceRevision,
              allowFailedChecks: false,
            }),
          );
        }
        json(res, result);
        return;
      }
      s.tx(() => {
        const r = s.one<Run>(
          "SELECT * FROM runs WHERE id=? AND taskId=?",
          d.runId,
          t.id,
        );
        requireValue(r, "RUN_NOT_FOUND", "Run not found");
        if (terminalStates.includes(r.state as any) || r.state === "cancelling")
          return;
        requireValue(
          t.currentRunId === r.id,
          "RUN_NOT_CURRENT",
          "Run is not current",
        );
        if (d.state === "accepted") {
          requireValue(
            d.messageId,
            "MESSAGE_ID_REQUIRED",
            "Acceptance needs a native message ID",
            400,
          );
          requireValue(
            !r.messageId || r.messageId === d.messageId,
            "MESSAGE_CONFLICT",
            "Run already accepted a different message",
          );
          s.exec(
            "UPDATE runs SET messageId=?,state=CASE WHEN state='preparing' THEN 'running' ELSE state END WHERE id=?",
            d.messageId,
            r.id,
          );
        } else {
          const transitions: Record<string, string[]> = {
            preparing: ["running", "waiting_input", "finalizing"],
            running: ["running", "waiting_input", "finalizing"],
            waiting_input: ["running", "waiting_input", "finalizing"],
            finalizing: ["finalizing"],
          };
          requireValue(
            transitions[r.state]?.includes(d.state),
            "INVALID_TRANSITION",
            `Cannot move ${r.state} to ${d.state}`,
          );
          s.exec("UPDATE runs SET state=? WHERE id=?", d.state, r.id);
        }
        s.event(
          t.id,
          "run." + d.state,
          { runId: r.id, messageId: d.messageId ?? null },
          r.id,
        );
      });
      json(res, { ok: true });
      return;
    }
    if (path === "/v1/executor/interactions" && method === "POST") {
      const d = z
        .object({
          nativeId: z.string().max(200),
          runId: uuid,
          kind: z.enum(["question", "approval"]),
          body: z.any(),
        })
        .strict()
        .parse(await body(req));
      requireValue(
        t.currentRunId === d.runId,
        "RUN_NOT_CURRENT",
        "Run is not current",
      );
      const result = s.tx(() => {
        const old = s.one<any>(
          "SELECT * FROM interactions WHERE taskId=? AND incarnation=? AND nativeId=?",
          t.id,
          incarnation,
          d.nativeId,
        );
        if (old) {
          requireValue(
            old.runId === d.runId && old.kind === d.kind &&
              digest(JSON.parse(old.body)) === digest(d.body),
            "INTERACTION_CONFLICT",
            "Interaction changed",
          );
          return { id: old.id };
        }
        const interactionId = id();
        s.exec(
          "INSERT INTO interactions(id,taskId,runId,incarnation,nativeId,kind,body,expiresAt) VALUES (?,?,?,?,?,?,?,?)",
          interactionId,
          t.id,
          d.runId,
          incarnation,
          d.nativeId,
          d.kind,
          JSON.stringify(d.body),
          Date.now() + 86400000,
        );
        s.event(
          t.id,
          "interaction.created",
          { id: interactionId, kind: d.kind, body: d.body },
          d.runId,
        );
        return { id: interactionId };
      });
      json(res, result);
      return;
    }
    const im = path.match(
      /^\/v1\/executor\/interactions\/([^/]+)\/(delivered|resolved|expired)$/,
    );
    if (im && method === "POST") {
      const i = s.one<any>(
        "SELECT * FROM interactions WHERE id=? AND taskId=? AND incarnation=?",
        im[1],
        t.id,
        incarnation,
      );
      requireValue(i, "INTERACTION_STALE", "Interaction expired");
      requireValue(
        im[2] === "expired" ||
          i.state === im[2] ||
          (im[2] === "delivered" && i.state === "submitted") ||
          (im[2] === "resolved" && i.state === "delivered"),
        "INTERACTION_STATE",
        "Answer has not been delivered",
      );
      if (i.state === im[2]) { json(res, { ok: true }); return; }
      s.exec(
        "UPDATE interactions SET state=?,version=version+1 WHERE id=?",
        im[2],
        i.id,
      );
      s.event(t.id, "interaction." + im[2], { id: i.id }, i.runId);
      json(res, { ok: true });
      return;
    }
    if (path === "/v1/executor/artifacts" && method === "POST") {
      const d = z
        .object({
          id: uuid,
          runId: uuid,
          revision: z.string(),
          kind: z.string().max(40),
          body: z.any(),
        })
        .strict()
        .parse(await body(req, RESULT_BODY_LIMIT));
      const raw = JSON.stringify(d.body),
        hash = digest(raw);
      requireValue(
        s.one("SELECT id FROM runs WHERE id=? AND taskId=?", d.runId, t.id),
        "RUN_NOT_FOUND",
        "Run not found",
        404,
      );
      const old = s.one<any>(
        "SELECT hash,taskId FROM artifacts WHERE id=?",
        d.id,
      );
      requireValue(
        !old || (old.hash === hash && old.taskId === t.id),
        "ARTIFACT_CONFLICT",
        "Artifact ID already contains different data",
      );
      await durableWrite(resolve(this.artifactRoot, d.id + ".json"), raw, true);
      s.exec(
        "INSERT OR IGNORE INTO artifacts VALUES (?,?,?,?,?,?,?,?,?)",
        d.id,
        t.id,
        d.runId,
        d.revision,
        d.kind,
        hash,
        Buffer.byteLength(raw),
        "@file",
        Date.now(),
      );
      json(res, { id: d.id, hash });
      return;
    }
    throw new CloudError(404, "NOT_FOUND", "Not found");
  }
  private async model(req: IncomingMessage, res: ServerResponse) {
    const c = this.auth.authenticate(req, "model"),
      s = this.store,
      t = s.task(c.subject);
    s.assertModelRoute(t.id, this.config.model);
    requireValue(
      t.currentRunId,
      "NO_ACTIVE_RUN",
      "Model calls require an active Run",
      403,
    );
    requireValue(
      !recoveryState(s),
      "RECONCILIATION_REQUIRED",
      "Database recovery blocks model calls",
      503,
    );
    const run = s.one<Run>("SELECT * FROM runs WHERE id=?", t.currentRunId)!;
    requireValue(
      ["preparing", "running", "waiting_input"].includes(run.state),
      "RUN_NOT_ACTIVE",
      "Run is no longer accepting model calls",
      403,
    );
    requireValue(
      !this.modelInflight.has(t.id),
      "MODEL_BUSY",
      "One model request is permitted per task",
      429,
    );
    const requestBody = await body(req, 16 * 1024 * 1024);
    requireValue(
      requestBody.model === this.config.model.name,
      "MODEL_DENIED",
      "Model is not configured for this task",
      403,
    );
    const template = s.template(t.templateId, t.templateVersion);
    requireValue(
      Number.isInteger(requestBody.max_tokens) &&
        requestBody.max_tokens > 0 &&
        requestBody.max_tokens <= template.maxOutputTokens,
      "TOKEN_LIMIT",
      "Output cap exceeds the task limit",
      400,
    );
    requireValue(
      this.config.model.apiKey,
      "MODEL_NOT_CONFIGURED",
      "Configure the model credential on the control service",
      503,
    );
    requireValue(
      !this.modelInflight.has(t.id),
      "MODEL_BUSY",
      "One model request is permitted per task",
      429,
    );
    s.tx(() => {
      s.exec(
        "INSERT OR IGNORE INTO model_usage(runId,calls) VALUES (?,0)",
        run.id,
      );
      const usage = s.one<any>(
        "SELECT calls FROM model_usage WHERE runId=?",
        run.id,
      );
      requireValue(
        usage.calls < template.maxModelCalls,
        "MODEL_BUDGET",
        "Task model call budget exhausted",
        429,
      );
      s.exec("UPDATE model_usage SET calls=calls+1 WHERE runId=?", run.id);
    });
    const abort = new AbortController(),
      timeout = setTimeout(
        () => abort.abort(),
        Math.min(template.timeoutSeconds * 1000, 600000),
      );
    this.modelInflight.add(t.id);
    this.activeModels.add(abort);
    let accounted = false;
    const clientClosed = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on("close", clientClosed);
    try {
      const base = this.config.model.baseUrl.replace(/\/+$/, "");
      const target = new URL(
        base + (base.endsWith("/v1") ? "" : "/v1") + "/messages",
      );
      const upstream = await fetch(target, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.model.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(requestBody),
        signal: abort.signal,
        redirect: "error",
      });
      // Do not expose upstream headers or detailed credential errors to the task.
      if (!upstream.ok) {
        await upstream.body?.cancel();
        throw new CloudError(
          upstream.status === 429 ? 429 : 502,
          "MODEL_UPSTREAM",
          "Model provider rejected the request",
        );
      }
      res.writeHead(200, {
        "content-type":
          upstream.headers.get("content-type") ?? "application/json",
        "cache-control": "no-store",
      });
      requireValue(
        upstream.body,
        "MODEL_EMPTY",
        "Model provider returned no body",
        502,
      );
      const meter = new UsageMeter(
        (upstream.headers.get("content-type") ?? "").includes(
          "text/event-stream",
        ),
      );
      try {
        await new Promise<void>((done, reject) => {
          const stream = Readable.fromWeb(upstream.body as any);
          stream.on("error", reject);
          meter.on("error", reject);
          res.once("error", reject);
          res.once("finish", done);
          res.once("close", () => {
            stream.destroy();
            meter.destroy();
            done();
          });
          stream.pipe(meter).pipe(res);
        });
      } finally {
        const usage = s.one<any>(
          "SELECT * FROM model_usage WHERE runId=?",
          run.id,
        )!;
        const add = (a: number | null, b: number | null) =>
          usage.calls === 1 ? b : a === null || b === null ? null : a + b;
        s.exec(
          "UPDATE model_usage SET inputTokens=?,outputTokens=? WHERE runId=?",
          add(usage.inputTokens, meter.complete ? meter.input : null),
          add(usage.outputTokens, meter.complete ? meter.output : null),
          run.id,
        );
        accounted = true;
      }
    } finally {
      clearTimeout(timeout);
      if (!accounted)
        s.exec(
          "UPDATE model_usage SET inputTokens=NULL,outputTokens=NULL WHERE runId=?",
          run.id,
        );
      this.activeModels.delete(abort);
      this.modelInflight.delete(t.id);
      res.off("close", clientClosed);
    }
  }
}
