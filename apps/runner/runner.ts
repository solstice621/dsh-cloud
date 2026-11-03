import {
  mkdir,
  readFile,
  writeFile,
  rename,
  open,
  rm,
  statfs,
} from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  DSH_VERSION,
  PROTOCOL,
  CloudError,
  id,
  requireValue,
  redact,
  type Task,
  type Template,
  type ExecutorConfig,
} from "../../packages/contracts/index.ts";
import { api, delay } from "../../packages/contracts/http.ts";
import {
  prepareRepository,
  snapshot,
  listWorkspace,
  readWorkspaceFile,
  publish,
  GitHubProvider,
} from "../../packages/git-provider/index.ts";
import { durableWrite } from "../../packages/contracts/storage.ts";
import { Journal } from "../executor/journal.ts";
import { replayOutbox } from "../../packages/contracts/outbox.ts";
import { Docker, type Container } from "./docker.ts";

export interface RunnerConfig {
  runnerId: string;
  token: string;
  controlUrl: string;
  executorControlUrl: string;
  root: string;
  capacity: number;
  gitTokenEnv: string;
  gitApiBase?: string;
}
type WorkTask = Task & {
  template: Template;
  queued: number;
  cancelRequested: boolean;
  publication?: { commitId: string };
};
export class Runner {
  readonly docker: Docker;
  readonly journal: Journal;
  readonly abort = new AbortController();
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeating = false;
  private lockToken = id();
  private lastError = "";
  private closed = false;
  constructor(readonly config: RunnerConfig) {
    this.docker = new Docker(config.runnerId);
    this.journal = new Journal(resolve(config.root, "runner.sqlite"));
  }
  private call<T = any>(path: string, body?: unknown) {
    return api<T>(this.config.controlUrl, path, this.config.token, body);
  }
  private paths(taskId: string) {
    requireValue(
      /^[a-f0-9-]{36}$/.test(taskId),
      "INVALID_TASK",
      "Invalid task ID",
    );
    const root = resolve(this.config.root, "tasks", taskId);
    return {
      root,
      workspace: resolve(root, "workspace"),
      home: resolve(root, "dsh-home"),
      state: resolve(root, "executor-state"),
      trusted: resolve(this.config.root, "trusted", taskId + ".git"),
    };
  }
  async start() {
    requireValue(
      process.getuid?.() !== 0,
      "NON_ROOT_REQUIRED",
      "Run the Runner as a non-root user with access to its Docker backend",
    );
    await mkdir(this.config.root, { recursive: true, mode: 0o700 });
    const lock = resolve(this.config.root, "runner.lock");
    if (existsSync(lock)) {
      const prior = JSON.parse(await readFile(lock, "utf8"));
      let alive = true;
      try {
        process.kill(prior.pid, 0);
      } catch (e: any) {
        if (e.code === "ESRCH") alive = false;
      }
      requireValue(
        !alive,
        "RUNNER_LOCKED",
        "Another Runner daemon may still be active",
      );
      await rm(lock);
    }
    const handle = await open(lock, "wx", 0o600);
    await handle.writeFile(
      JSON.stringify({ pid: process.pid, token: this.lockToken }),
    );
    await handle.sync();
    await handle.close();
    await this.docker.available();
    for (const c of await this.docker.containers())
      if (c.paused && this.journal.value(`paused:${c.id}`, false)) {
        await this.docker.unpause(c);
        this.journal.set(`paused:${c.id}`, false);
      }
    await this.heartbeat();
    this.heartbeatTimer = setInterval(
      () => void this.heartbeat().catch((e) => this.log(e)),
      10000,
    );
  }
  async heartbeat() {
    if (this.heartbeating) return;
    this.heartbeating = true;
    try {
      const containers = await this.docker.containers();
      await this.call("/v1/runner/heartbeat", {
        protocol: PROTOCOL,
        dshVersion: DSH_VERSION,
        capacity: this.config.capacity,
        inventory: containers.map((c) => ({
          taskId: c.taskId,
          epoch: c.epoch,
          incarnation: c.incarnation,
          running: c.running,
        })),
      });
    } catch (e) {
      if (e instanceof CloudError && [401, 403].includes(e.status)) {
        for (const c of await this.docker.containers())
          if (c.running) await this.docker.stop(c);
        await this.call("/v1/runner/revoked-stopped", {
          allContainersStopped: true,
        }).catch(() => {});
        this.abort.abort();
      }
      throw e;
    } finally {
      this.heartbeating = false;
    }
  }
  private log(error: unknown) {
    const message = redact(error);
    if (message !== this.lastError) {
      console.error(
        JSON.stringify({
          level: "warn",
          runnerId: this.config.runnerId,
          error: message,
        }),
      );
      this.lastError = message;
    }
  }
  async loop() {
    while (!this.abort.signal.aborted) {
      try {
        await this.tick();
        this.lastError = "";
      } catch (e) {
        this.log(e);
      }
      await delay(1500, this.abort.signal);
    }
  }
  async tick() {
    const work = await this.call<{
      tasks: WorkTask[];
      operations: any[];
      recovery?: { id: string };
    }>("/v1/runner/work");
    let containers = await this.docker.containers();
    if (work.recovery) {
      for (const c of containers) if (c.running) await this.docker.stop(c);
      await this.heartbeat();
      await this.call("/v1/runner/reconciled", { restoreId: work.recovery.id });
      return;
    }
    for (const task of work.tasks) {
      const related = containers.filter((c) => c.taskId === task.id),
        current = related.find(
          (c) => c.epoch === task.epoch && c.incarnation === task.incarnation,
        );
      const unknown = related.find(
        (c) =>
          c.running &&
          (c.epoch !== task.epoch || c.incarnation !== task.incarnation),
      );
      if (unknown) {
        this.log(
          new Error(
            `Task ${task.id}: active container differs from control history; reconciliation required`,
          ),
        );
        continue;
      }
      if (current && task.environmentState === "needs_stop") {
        const stopped = await this.docker.stop(current);
        await this.reportStopped(task, stopped, "recovery_barrier");
        continue;
      }
      if (current && task.cancelRequested) {
        const stopped = await this.docker.stop(current);
        await this.reportStopped(task, stopped, "cancel_requested");
        continue;
      }
      if (
        current &&
        !current.running &&
        task.environmentState !== "stopped" &&
        task.environmentState !== "error"
      ) {
        const p = this.paths(task.id);
        let result: any = {
          error: `Runtime exited ${current.exitCode}`,
          oomKilled: current.oomKilled,
        };
        try {
          result = {
            ...result,
            ...JSON.parse(
              await readFile(resolve(p.state, "exit.json"), "utf8"),
            ),
          };
        } catch {}
        await this.reportStopped(task, current, current.exitCode === 0 ? "runtime_stopped" : "runtime_exited", result, current.exitCode !== 0);
        continue;
      }
      if (
        !current &&
        task.epoch > 0 &&
        !["stopped", "error", "provisioning"].includes(task.environmentState)
      ) {
        // A removed container is absent from the complete Docker inventory. Report
        // interruption before considering another runtime, never infer completion.
        await this.call(`/v1/runner/environments/${task.id}/stopped`, {
          epoch: task.epoch,
          incarnation: task.incarnation,
          confirmedStopped: true,
          reason: "Original container is absent",
        });
        continue;
      }
      if (
        !task.paused && !task.recoveryRequired &&
        task.lifecycle === "open" &&
        task.queued > 0 &&
        !task.currentRunId &&
        ["provisioning", "stopped", "error"].includes(task.environmentState) &&
        !current?.running &&
        containers.filter((c) => c.running).length < this.config.capacity &&
        !work.operations.some(
          (o) =>
            o.taskId === task.id &&
            ["stop", "delete", "publish"].includes(o.kind),
        )
      ) {
        await this.provision(task, current);
        containers = await this.docker.containers();
      }
    }
    for (const operation of work.operations) {
      await this.perform(
        operation,
        work.tasks.find((t) => t.id === operation.taskId)!,
        containers,
      ).catch((e) => this.log(e));
    }
  }
  private async provision(task: WorkTask, old?: Container) {
    const p = this.paths(task.id);
    await Promise.all([
      mkdir(p.workspace, { recursive: true }),
      mkdir(p.home, { recursive: true }),
      mkdir(p.state, { recursive: true, mode: 0o700 }),
    ]);
    const startKey = `start:${task.id}:${task.epoch}`;
    let request = this.journal.value<any>(startKey, null);
    if (!request) {
      request = {
        operationId: id(),
        previousEpoch: task.epoch,
        previousContainerStopped: true,
      };
      this.journal.set(startKey, request);
    }
    const lease = await this.call(
      `/v1/runner/environments/${task.id}/start`,
      request,
    );
    try {
      const disk = await statfs(p.root);
      requireValue(
        Number(disk.bavail) * Number(disk.bsize) >=
          task.template.minFreeDiskMb * 1024 * 1024,
        "DISK_SPACE_LOW",
        "Runner has insufficient free disk space for this template",
      );
      if (old) await this.docker.remove(old);
      const baseCommit = await prepareRepository(
        lease.task,
        p.workspace,
        p.trusted,
        process.env[this.config.gitTokenEnv],
      );
      await this.call(`/v1/runner/environments/${task.id}/provisioned`, {
        epoch: lease.epoch,
        incarnation: lease.incarnation,
        baseCommit,
      });
      lease.task.baseCommit = baseCommit;
      const pinned = this.journal.value<string | null>(
          `image:${task.id}`,
          null,
        ),
        image = await this.docker.image(pinned ?? task.template.image);
      this.journal.set(`image:${task.id}`, image.Id);
      const config: ExecutorConfig = {
        controlUrl: this.config.executorControlUrl,
        token: lease.token,
        task: lease.task,
        template: task.template,
        epoch: lease.epoch,
        incarnation: lease.incarnation,
        workspace: "/workspace",
        dshHome: "/dsh-home",
        stateDir: "/executor",
        model: lease.model,
        modelBaseUrl:
          this.config.executorControlUrl.replace(/\/$/, "") + "/model",
        patchPath: "/executor/runtime.patch.yml",
        socketPath: "/tmp/dsh-cloud-runtime.sock",
      };
      await rm(resolve(p.state, "exit.json"), { force: true });
      await durableWrite(
        resolve(p.state, `config-${config.incarnation}.json`),
        JSON.stringify(config),
        true,
      );
      await durableWrite(
        resolve(p.state, "config.json"),
        JSON.stringify(config),
      );
      await this.docker.launch(config, p, image.Id);
      this.journal.set(`active:${task.id}`, {
        epoch: lease.epoch,
        incarnation: lease.incarnation,
      });
      await this.heartbeat();
    } catch (error) {
      // If launch succeeded but its response was lost, attach to the existing
      // labelled container. Only report failure after proving no process remains.
      const actual = (await this.docker.containers()).find(
        (c) => c.taskId === task.id && c.epoch === lease.epoch,
      );
      if (actual?.running) return;
      await this.call(`/v1/runner/environments/${task.id}/error`, {
        epoch: lease.epoch,
        incarnation: lease.incarnation,
        confirmedStopped: true,
        reason: redact(error),
      });
      throw error;
    }
  }
  private async reportStopped(
    task: Task,
    c: Container,
    reason: string,
    result?: unknown,
    failed = false,
  ) {
    // Give completed output a short opportunity to arrive, but never make proof
    // of a stopped process depend on successful result delivery.
    try { await this.replayStoppedJournal(task, AbortSignal.timeout(2000)); }
    catch (error) { this.log(error); }
    return this.call(`/v1/runner/environments/${task.id}/${failed ? "error" : "stopped"}`, {
      epoch: c.epoch,
      incarnation: c.incarnation,
      confirmedStopped: true,
      reason,
      ...(result ? { result } : {}),
    });
  }
  private async replayStoppedJournal(task: Task, signal?: AbortSignal) {
    const p = this.paths(task.id);
    if (
      !existsSync(resolve(p.state, "journal.sqlite")) ||
      !existsSync(resolve(p.state, "config.json"))
    )
      return;
    const config = JSON.parse(
      await readFile(resolve(p.state, "config.json"), "utf8"),
    ) as ExecutorConfig;
    if (config.epoch !== task.epoch || config.incarnation !== task.incarnation)
      return;
    const journal = new Journal(resolve(p.state, "journal.sqlite"));
    try {
      for (let after = -1; ; ) {
        const batch = journal.all<any>(
          "SELECT * FROM native WHERE seq>? ORDER BY seq LIMIT 100",
          after,
        );
        if (!batch.length) break;
        await api(this.config.controlUrl, "/v1/executor/events", config.token, {
          header: journal.value("nativeHeader", undefined),
          events: batch.map((e) => JSON.parse(e.event)),
          runId: task.currentRunId,
        }, { signal });
        after = batch.at(-1).seq;
      }
      await replayOutbox(journal, (path, body) => api(this.config.controlUrl, path, config.token, body, { signal }), task.restoreId ?? null);
    } finally {
      journal.close();
    }
  }
  private async paused<T>(
    container: Container | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    let didPause = false;
    if (container?.running && !container.paused) {
      this.journal.set(`paused:${container.id}`, true);
      await this.docker.pause(container);
      didPause = true;
    }
    try {
      return await fn();
    } finally {
      if (didPause) {
        await this.docker.unpause(container!);
        this.journal.set(`paused:${container!.id}`, false);
      }
    }
  }
  private async perform(op: any, task: WorkTask, containers: Container[]) {
    if (!task) return;
    const cached = this.journal.value<any>(`operation:${op.id}`, null);
    if (cached) {
      await this.call(`/v1/runner/operations/${op.id}/result`, cached);
      return;
    }
    await this.call(`/v1/runner/operations/${op.id}/claim`, {});
    const p = this.paths(task.id),
      container = containers.find(
        (c) => c.taskId === task.id && c.epoch === task.epoch,
      );
    let result: any,
      state: "succeeded" | "failed" | "unknown" = "succeeded";
    try {
      if (op.kind === "retry-setup") {
        requireValue(
          !container?.running,
          "ENVIRONMENT_ACTIVE",
          "Stop the environment before retrying setup",
        );
        const journal = new Journal(resolve(p.state, "journal.sqlite"));
        try {
          journal.set("setupInProgress", false);
        } finally {
          journal.close();
        }
        result = { retrySetup: true };
      } else if (op.kind === "stop" || op.kind === "delete") {
        if (container) {
          const stopped = await this.docker.stop(container);
          await this.reportStopped(task, stopped, "user_stopped");
          if (op.kind === "delete") await this.docker.remove(stopped);
        }
        if (!container && task.epoch > 0)
          await this.call(`/v1/runner/environments/${task.id}/stopped`, {
            epoch: task.epoch,
            incarnation: task.incarnation,
            confirmedStopped: true,
            reason: "Container is absent from complete inventory",
          });
        if (op.kind === "delete") {
          await rm(p.root, { recursive: true, force: true });
          await rm(p.trusted, { recursive: true, force: true });
        }
        result = { stopped: true, deleted: op.kind === "delete" };
      } else if (op.kind === "inspect") {
        result = await this.paused(container, async () => {
          if (op.request.kind === "files")
            return {
              ...(await listWorkspace(p.workspace)),
              live: !!container?.running,
              environmentId: task.environmentId,
            };
          if (op.request.kind === "file")
            return {
              ...(await readWorkspaceFile(p.workspace, op.request.path)),
              live: !!container?.running,
            };
          requireValue(
            task.baseCommit,
            "BASE_COMMIT_REQUIRED",
            "Task checkout is not ready",
          );
          return {
            ...(await snapshot(
              p.workspace,
              p.trusted,
              resolve(p.root, "inspect.index"),
              task.baseCommit,
            )),
            live: !!container?.running,
          };
        });
      } else if (op.kind === "publish") {
        const token = process.env[this.config.gitTokenEnv];
        requireValue(
          token,
          "GIT_CREDENTIAL_MISSING",
          `Configure ${this.config.gitTokenEnv} on the Runner`,
          503,
        );
        const prior =
          this.journal.value<string | null>(`published:${task.id}`, null) ??
          task.publication?.commitId ??
          null;
        result = await this.paused(container, () =>
          publish(
            task,
            p.workspace,
            p.trusted,
            p.root,
            op.request,
            prior,
            new GitHubProvider({ token, apiBase: this.config.gitApiBase }),
            token,
          ),
        );
        this.journal.set(`published:${task.id}`, result.commit);
      } else throw new Error("Unsupported operation");
    } catch (error) {
      state = op.kind === "publish" ? "unknown" : "failed";
      result = {
        error: redact(error),
        code: error instanceof CloudError ? error.code : "OPERATION_FAILED",
      };
    }
    const output = { state, result };
    this.journal.set(`operation:${op.id}`, output);
    await this.call(`/v1/runner/operations/${op.id}/result`, output);
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.abort.abort();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    while (this.heartbeating) await delay(25);
    const lock = resolve(this.config.root, "runner.lock");
    try {
      const current = JSON.parse(await readFile(lock, "utf8"));
      if (current.token === this.lockToken) await rm(lock);
    } catch {}
    this.journal.close();
  }
}
