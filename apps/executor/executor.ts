import { mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import {
  CloudError,
  DSH_VERSION,
  PROTOCOL,
  id,
  redact,
  requireValue,
  type ExecutorConfig,
  type Run,
} from "../../packages/contracts/index.ts";
import { api, delay } from "../../packages/contracts/http.ts";
import { replayOutbox } from "../../packages/contracts/outbox.ts";
import { boundResultPayload } from "../../packages/contracts/results.ts";
import { durableWrite } from "../../packages/contracts/storage.ts";
import { processRun } from "../../packages/contracts/process.ts";
import { snapshot } from "../../packages/git-provider/index.ts";
import { Journal } from "./journal.ts";
import { checkpoint, makeHarness, writeRuntimePatch } from "./runtime.ts";

export class Executor {
  readonly journal: Journal;
  readonly stopSignal = new AbortController();
  private harness?: DeepSeekHarness;
  private run?: Run;
  private runPromise?: Promise<void>;
  private syncing?: Promise<void>;
  private pending = new Map<
    string,
    { resolve: (answer: any) => void; reject: (error: Error) => void }
  >();
  private lastRenew = 0;
  private shuttingDown = false;
  private fatalError?: Error;
  constructor(readonly config: ExecutorConfig) {
    this.journal = new Journal(resolve(config.stateDir, "journal.sqlite"));
  }
  diagnostics() {
    return ((this.harness?.client as any)?.stderrTail ?? [])
      .map((line: string) => redact(line))
      .join("\n");
  }
  private call<T = any>(path: string, body?: unknown) {
    return api<T>(this.config.controlUrl, path, this.config.token, body);
  }
  async start() {
    const c = this.config;
    await Promise.all([
      mkdir(c.dshHome, { recursive: true }),
      mkdir(c.stateDir, { recursive: true }),
      mkdir(c.workspace, { recursive: true }),
    ]);
    // The supervisor starts this process only after proving the old container exited.
    await rm(c.socketPath ?? resolve(c.stateDir, "runtime.sock"), {
      force: true,
    });
    const prior = this.journal.all<any>(
      "SELECT * FROM commands WHERE phase NOT IN ('complete','aborted') ORDER BY rowid DESC LIMIT 1",
    )[0];
    const hello = await this.call("/v1/executor/hello", {
      protocol: PROTOCOL,
      dshVersion: DSH_VERSION,
      journalRunId: prior?.runId ?? null,
      phase: prior?.phase ?? "idle",
      restoreId: this.journal.value("restoreId", null),
    });
    requireValue(
      !hello.reconcileRequired,
      "RECONCILE_REQUIRED",
      "Control history and Executor journal need reconciliation",
    );
    this.journal.set("restoreId", hello.task.restoreId ?? null);
    if (prior) {
      // A replaced process cannot know the external effects of a dispatched input.
      // Preserve the evidence and require an explicit recovery Run.
      const run = hello.task.currentRunId === prior.runId ? prior : null;
      if (run) {
        const state =
          prior.phase === "dispatching" ? "uncertain" : "interrupted";
        this.journal.queue(
          "/v1/executor/status",
          {
            runId: prior.runId,
            state,
            result: {
              error:
                "Executor restarted after dispatch; inspect the original workspace before recovery",
              messageId: prior.messageId,
            },
          },
          `restart:${prior.id}`,
        );
      }
      this.journal.run(
        "UPDATE commands SET phase='aborted' WHERE id=?",
        prior.id,
      );
    }
    await this.prepareEnvironment();
    await writeRuntimePatch(c);
    this.harness = makeHarness(c, {
      onUserQuestion: (question, { signal }) =>
        this.interact("question", question.requestId, question, signal),
    });
    this.harness.client.start();
    this.harness.client.onRequest(async (method, params) => {
      if (method !== "approval/request")
        throw new Error("Unsupported runtime request");
      return this.interact(
        "approval",
        String(params.requestId ?? id()),
        params,
        this.stopSignal.signal,
      );
    });
    await this.harness.start();
    const initial = await this.readCheckpoint(-1, 1);
    if (initial.exists) {
      await this.harness.resumeSession(c.task.sessionId);
      const cwd = await this.harness
        .session(c.task.sessionId)
        .getWorkingDirectory();
      requireValue(
        (await realpath(cwd)) === (await realpath(c.workspace)),
        "WORKSPACE_MISMATCH",
        "Restored session belongs to a different workspace",
      );
    } else {
      requireValue(
        hello.durableSeq < 0,
        "NATIVE_HISTORY_MISSING",
        "Cloud history exists but the original DSH session is missing",
      );
      await this.harness
        .session(c.task.sessionId)
        .setWorkingDirectory(c.workspace);
    }
    const savedEnd = this.journal.get<any>(
      "SELECT COALESCE(MAX(seq),-1) AS n FROM native",
    )!.n;
    let durableEnd = -1;
    while (true) {
      const batch = await this.readCheckpoint(durableEnd);
      if (!batch.events.length) break;
      this.journal.saveEvents(batch.events, null);
      durableEnd = batch.durableSeq;
    }
    requireValue(
      durableEnd >= hello.durableSeq && durableEnd >= savedEnd,
      "NATIVE_HISTORY_BEHIND",
      "Original DSH history is behind its acknowledged checkpoint",
    );
    this.journal.set("ackedSeq", -1);
    this.journal.set("incarnation", c.incarnation);
    await this.sync();
  }
  async loop() {
    while (!this.stopSignal.signal.aborted) {
      try {
        if (Date.now() - this.lastRenew > 10 * 60000) {
          await this.call("/v1/executor/renew", {});
          this.lastRenew = Date.now();
        }
        await this.sync();
        const data = await this.call("/v1/executor/commands");
        if (data.current?.cancelled) {
          await this.stop("cancel_requested");
          break;
        }
        for (const answer of data.answers) {
          const pending = this.pending.get(answer.id);
          if (pending) {
            this.journal.receiveAnswer({ ...answer, runId: answer.runId ?? this.run!.id });
            const saved = this.journal.get<any>("SELECT * FROM answers WHERE id=?", answer.id)!;
            if (saved.consumed) continue;
            // No network await between local consumption and queuing its receipt.
            // A process crash fences this incarnation and requires explicit recovery;
            // a lost HTTP receipt cannot leave a live DSH waiter stranded.
            this.pending.delete(answer.id);
            pending.resolve(JSON.parse(saved.answer));
            this.journal.tx(() => {
              this.journal.run("UPDATE answers SET consumed=1 WHERE id=?", answer.id);
              this.journal.set(`delivered:${answer.id}`, saved.runId);
              this.journal.queue(`/v1/executor/interactions/${answer.id}/delivered`, {}, `delivered:${answer.id}`);
            });
          }
        }
        if (data.current?.run && !this.runPromise) {
          const run = data.current.run as Run,
            prior = this.journal.get(
              "SELECT * FROM commands WHERE id=?",
              run.commandId,
            );
          if (prior?.phase === "complete") {
            await this.sync();
          } else if (prior) {
            this.journal.queue(
              "/v1/executor/status",
              {
                runId: run.id,
                state: "uncertain",
                result: {
                  error: "Input delivery needs reconciliation",
                  messageId: prior.messageId,
                },
              },
              `uncertain:${run.commandId}`,
            );
            await this.sync();
          } else {
            this.run = run;
            this.runPromise = this.execute(run)
              .catch((error) => {
                this.fatalError = error;
                this.stopSignal.abort();
              })
              .finally(() => {
                this.run = undefined;
                this.runPromise = undefined;
              });
          }
        }
      } catch (error) {
        if (
          error instanceof CloudError &&
          ["STALE_EXECUTOR", "RUNNER_REVOKED", "UNAUTHORIZED", "DELIVERY_REJECTED"].includes(
            error.code,
          )
        ) {
          this.fatalError = error;
          await this.stop("credential_or_fence_lost");
          break;
        }
        console.error(
          JSON.stringify({
            level: "warn",
            taskId: this.config.task.id,
            error: redact(error),
          }),
        );
      }
      await delay(1000, this.stopSignal.signal);
    }
    if (this.fatalError) throw this.fatalError;
  }
  private readCheckpoint(after: number, limit = 200) {
    return checkpoint(
      this.config.socketPath ?? resolve(this.config.stateDir, "runtime.sock"),
      this.config.task.sessionId,
      after,
      limit,
    );
  }
  private collecting?: Promise<void>;
  private collect() {
    return (this.collecting ??= (async () => {
      if (this.harness && !this.shuttingDown) {
        let after = this.journal.get<any>(
          "SELECT COALESCE(MAX(seq),-1) AS n FROM native",
        )!.n;
        while (true) {
          const batch = await this.readCheckpoint(after);
          if (batch.header) this.journal.set("nativeHeader", batch.header);
          if (!batch.events.length) break;
          this.journal.saveEvents(batch.events, this.run?.id ?? null);
          after = batch.durableSeq;
        }
      }
    })().finally(() => {
      this.collecting = undefined;
    }));
  }
  private sync() {
    return (this.syncing ??= (async () => {
      await this.collect();
      // Upload native history before completing any Run. Rewind from the server's
      // acknowledged cursor on every start; the server detects content conflicts.
      let ack = this.journal.value("ackedSeq", -1);
      while (true) {
        const events = this.journal.all<any>(
          "SELECT * FROM native WHERE seq>? ORDER BY seq LIMIT 100",
          ack,
        );
        if (!events.length) break;
        const result = await this.call("/v1/executor/events", {
          header: this.journal.value("nativeHeader", undefined),
          events: events.map((e) => JSON.parse(e.event)),
          runId: this.run?.id ?? null,
        });
        ack = result.durableSeq;
        this.journal.set("ackedSeq", ack);
      }
      await replayOutbox(this.journal, this.call.bind(this), this.config.task.restoreId ?? null);
    })().finally(() => {
      this.syncing = undefined;
    }));
  }
  private async interact(
    kind: "question" | "approval",
    nativeId: string,
    body: unknown,
    signal: AbortSignal,
  ): Promise<any> {
    requireValue(this.run, "NO_ACTIVE_RUN", "Interaction has no active Run");
    const runId = this.run.id;
    const interaction = await this.call("/v1/executor/interactions", {
      nativeId,
      runId,
      kind,
      body,
    });
    this.journal.queue("/v1/executor/status", {
      runId,
      state: "waiting_input",
    });
    try {
      return await new Promise((resolve, reject) => {
        const onAbort = () => {
          this.pending.delete(interaction.id);
          this.journal.queue(
            `/v1/executor/interactions/${interaction.id}/expired`,
            {},
            `expired:${interaction.id}`,
          );
          reject(new Error("Runtime interaction cancelled"));
        };
        const cleanup = () => signal.removeEventListener("abort", onAbort);
        this.pending.set(interaction.id, {
          resolve: (value) => {
            cleanup();
            this.journal.queue("/v1/executor/status", {
              runId,
              state: "running",
            });
            resolve(value);
          },
          reject: (error) => {
            cleanup();
            reject(error);
          },
        });
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    } finally {
      this.pending.delete(interaction.id);
    }
  }
  private async execute(run: Run) {
    const c = this.config,
      harness = this.harness!;
    const startSeq = this.journal.get<any>(
      "SELECT COALESCE(MAX(seq),-1) AS n FROM native",
    )!.n;
    this.journal.run(
      "INSERT INTO commands VALUES (?,?,?,NULL,NULL)",
      run.commandId,
      run.id,
      "prepared",
    );
    let timedOut = false,
      activeMs = 0,
      lastTick = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      if (this.pending.size === 0) activeMs += now - lastTick;
      lastTick = now;
      if (activeMs > c.template.timeoutSeconds * 1000) {
        timedOut = true;
        void this.stop("run_timeout");
      }
    }, 1000);
    try {
      this.journal.run(
        "UPDATE commands SET phase='dispatching' WHERE id=?",
        run.commandId,
      );
      const messageId = await harness.client.prompt(c.task.sessionId, [
        { type: "text", text: run.input },
      ]);
      this.journal.tx(() => {
        this.journal.run(
          "UPDATE commands SET phase='accepted',messageId=? WHERE id=?",
          messageId,
          run.commandId,
        );
        this.journal.queue(
          "/v1/executor/status",
          { runId: run.id, state: "accepted", messageId },
          `accept:${run.commandId}`,
        );
      });
      await harness.client.request("session/wait", {
        sessionId: c.task.sessionId,
      });
      this.journal.queue(
        "/v1/executor/status",
        { runId: run.id, state: "finalizing" },
        `finalizing:${run.commandId}`,
      );
      await this.collect();
      const events = this.journal
        .all<any>("SELECT event FROM native WHERE seq>? ORDER BY seq", startSeq)
        .map((e) => JSON.parse(e.event));
      requireValue(
        events.some(
          (e) =>
            e.type === "agent/inbox/spliced" &&
            e.data?.inserted?.some((m: any) => m.id === messageId),
        ),
        "RECEIPT_MISSING",
        "Native log does not contain the accepted input receipt",
      );
      const end = events.filter((e) => e.type === "turn/end").at(-1),
        message = events.filter((e) => e.type === "assistant/message").at(-1);
      requireValue(
        end,
        "TURN_END_MISSING",
        "Runtime became idle without a committed turn ending",
      );
      const finishReason = end.data?.reason?.kind ?? "unknown",
        finalResponse = (message?.data?.message?.content ?? [])
          .filter((v: any) => v.type === "text")
          .map((v: any) => v.text)
          .join("");
      const checks: any[] = [];
      for (const check of c.template.checks) {
        const result = await processRun("/bin/bash", ["-lc", check.command], {
          cwd: c.workspace,
          timeout: Math.min(600000, c.template.timeoutSeconds * 1000),
          signal: this.stopSignal.signal,
          maxBytes: 4 * 1024 * 1024,
          allowFailure: true,
          env: { PATH: process.env.PATH, HOME: c.dshHome, LANG: "C.UTF-8" },
        });
        checks.push({
          ...check,
          state: result.timedOut
            ? "unknown"
            : result.code === 0
              ? "passed"
              : "failed",
          exitCode: result.code,
          timedOut: result.timedOut,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      }
      requireValue(
        c.task.baseCommit,
        "BASE_COMMIT_REQUIRED",
        "Task checkout has no base commit",
      );
      const snap = await snapshot(
        c.workspace,
        resolve(c.workspace, ".git"),
        resolve(c.stateDir, "result.index"),
        c.task.baseCommit,
      );
      const artifactId = id(),
        result = {
          finalResponse,
          finishReason,
          checks,
          workspaceRevision: snap.workspaceRevision,
          durableSeq: this.journal.get<any>(
            "SELECT COALESCE(MAX(seq),-1) AS n FROM native",
          )!.n,
          artifactId,
        };
      const artifact = { id: artifactId, runId: run.id, revision: snap.workspaceRevision, kind: "result", body: { ...snap, checks } };
      const state = finishReason === "completed" ? "succeeded" : "failed";
      const fullStatus = { runId: run.id, state, result };
      const localFile = `results/${run.id}.json`;
      await durableWrite(resolve(c.stateDir, localFile), JSON.stringify({ artifact, status: fullStatus }), true);
      const boundedArtifact = boundResultPayload(artifact, localFile);
      const artifactTruncation = (boundedArtifact.body as any).truncation;
      const boundedStatus = boundResultPayload({ ...fullStatus, result: { ...result, ...(artifactTruncation ? { artifactTruncation } : {}) } }, localFile);
      this.journal.tx(() => {
        this.journal.queue(
          "/v1/executor/artifacts", boundedArtifact,
          `artifact:${run.commandId}`,
        );
        for (const item of this.journal.all<any>(
          "SELECT key,value FROM meta WHERE key LIKE 'delivered:%'",
        ))
          if (JSON.parse(item.value) === run.id)
            this.journal.queue(
              `/v1/executor/interactions/${item.key.slice(10)}/resolved`,
              {},
              `answer:${item.key}`,
            );
        this.journal.queue(
          "/v1/executor/status",
          boundedStatus,
          `complete:${run.commandId}`,
        );
        this.journal.run(
          "UPDATE commands SET phase='complete',result=? WHERE id=?",
          JSON.stringify(boundedStatus.result),
          run.commandId,
        );
      });
      // The loop retries durable delivery; an upload outage cannot change a completed result.
    } catch (error) {
      if (!this.shuttingDown) {
        const command = this.journal.get(
          "SELECT * FROM commands WHERE id=?",
          run.commandId,
        );
        const state =
          command?.phase === "dispatching" ? "uncertain" : "interrupted";
        this.journal.queue(
          "/v1/executor/status",
          {
            runId: run.id,
            state,
            result: {
              error: redact(error),
              timedOut,
              messageId: command?.messageId ?? null,
              durableSeq: this.journal.value("ackedSeq", -1),
            },
          },
          `failure:${run.commandId}`,
        );
        // Never start another input beside an unproven failed Agent. The supervisor
        // reaps the complete container before exposing recovery.
        await this.stop("runtime_failure");
        throw error;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  private async prepareEnvironment() {
    const c = this.config;
    requireValue(
      !this.journal.value("setupInProgress", false),
      "SETUP_UNCERTAIN",
      "An initialization command was interrupted. Inspect the environment before explicitly retrying setup.",
    );
    const first = this.journal.value("setupStep", 0);
    for (let step = first; step < c.template.setup.length; step++) {
      this.journal.set("setupInProgress", true);
      await processRun("/bin/bash", ["-lc", c.template.setup[step]!], {
        cwd: c.workspace,
        timeout: c.template.timeoutSeconds * 1000,
        signal: this.stopSignal.signal,
        env: { PATH: process.env.PATH, HOME: c.dshHome, LANG: "C.UTF-8" },
      });
      this.journal.tx(() => {
        this.journal.set("setupStep", step + 1);
        this.journal.set("setupInProgress", false);
      });
    }
    for (const command of c.template.start)
      await processRun("/bin/bash", ["-lc", command], {
        cwd: c.workspace,
        timeout: 60000,
        signal: this.stopSignal.signal,
        env: { PATH: process.env.PATH, HOME: c.dshHome, LANG: "C.UTF-8" },
      });
  }
  async stop(reason = "shutdown") {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.stopSignal.abort();
    for (const pending of this.pending.values())
      pending.reject(new Error("Executor stopped"));
    this.pending.clear();
    if (this.harness) {
      try {
        await this.collecting;
        let after = this.journal.get<any>(
          "SELECT COALESCE(MAX(seq),-1) AS n FROM native",
        )!.n;
        for (let batch = 0; batch < 10; batch++) {
          const saved = await this.readCheckpoint(after, 1000);
          if (!saved.events.length) break;
          this.journal.saveEvents(saved.events, this.run?.id ?? null);
          after = saved.durableSeq;
        }
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "warn",
            taskId: this.config.task.id,
            event: "checkpoint.before_stop_failed",
            error: redact(error),
          }),
        );
      }
    }
    await this.harness?.close();
    await writeFile(
      resolve(this.config.stateDir, "exit.json"),
      JSON.stringify({
        reason,
        runId: this.run?.id ?? null,
        durableSeq: this.journal.value("ackedSeq", -1),
      }),
      { mode: 0o600 },
    );
    // The Runner, not this process, confirms cancellation after all container PIDs exit.
  }
  async close() {
    await this.stop();
    await this.runPromise?.catch(() => {});
    await this.syncing?.catch(() => {});
    this.journal.close();
  }
}
