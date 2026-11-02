import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  readdir,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ControlService } from "../../apps/control/server.ts";
import { Runner, type RunnerConfig } from "../../apps/runner/runner.ts";
import { api, delay } from "../../packages/contracts/http.ts";
import { processRun } from "../../packages/contracts/process.ts";
import {
  id,
  secret,
  DSH_VERSION,
  PROTOCOL,
  TemplateSchema,
} from "../../packages/contracts/index.ts";
import { modelFixture } from "../model-fixture.ts";

test(
  "Docker Runner retains the real DSH session across daemon and environment restart, then confirms cancellation",
  { timeout: 300000, skip: process.env.CLOUD_DOCKER_TEST !== "1" },
  async () => {
    const root = await realpath(
        await mkdtemp(resolve(tmpdir(), "dsh-cloud-docker-")),
      ),
      token = secret(),
      marker = "marker-" + id();
    let modelCalls = 0;
    const model = await modelFixture((body) => {
      modelCalls++;
      const last = body.messages.at(-1),
        content = last.content ?? [],
        toolResult =
          Array.isArray(content) &&
          content.some((c: any) => c.type === "tool_result");
      if (toolResult)
        return { text: "The requested workspace operation is complete." };
      const prompt = JSON.stringify(last);
      if (prompt.includes("ASK_AND_WAIT"))
        return {
          tool: "ask_user_question",
          input: {
            questions: [
              {
                id: "continue",
                question: "Continue this task?",
                options: [{ label: "Continue" }],
              },
            ],
          },
        };
      if (prompt.includes("READ_MARKER"))
        return { tool: "read", input: { file_path: "marker.txt" } };
      return {
        tool: "write",
        input: { file_path: "marker.txt", content: marker },
      };
    });
    const template = TemplateSchema.parse({
      id: "docker",
      version: "1",
      image: "dsh-cloud-runtime:0.1.1",
      platforms: ["linux/arm64", "linux/amd64"],
      checks: [
        {
          name: "Marker exists",
          command: "test -s marker.txt",
          required: true,
        },
      ],
      maxOutputTokens: 1024,
      minFreeDiskMb: 512,
      timeoutSeconds: 120,
      network: process.env.CLOUD_TEST_NETWORK ?? "bridge",
    });
    let service = new ControlService({
      host: "0.0.0.0",
      port: 0,
      publicUrl: "http://127.0.0.1:0",
      database: resolve(root, "control.sqlite"),
      webRoot: resolve("dist/web"),
      ownerId: "owner",
      development: true,
      devToken: token,
      model: { baseUrl: model.url, apiKey: "fixture-secret", name: "fixture" },
      templates: [template],
      allowedRepoHosts: ["github.com"],
    });
    await service.listen();
    const port = (service.server.address() as { port: number }).port;
    service.config.publicUrl = `http://127.0.0.1:${port}`;
    const user = (path: string, body?: unknown) =>
      api<any>(service.config.publicUrl, path, token, body, {
        headers: { "idempotency-key": id() },
      });
    const code = await user("/v1/runner-pairings", {}),
      pair = await api<any>(
        service.config.publicUrl,
        "/v1/runner-pairings/complete",
        "",
        {
          code: code.code,
          name: "Docker acceptance",
          platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
          protocol: PROTOCOL,
          dshVersion: DSH_VERSION,
        },
      );
    const config: RunnerConfig = {
      ...pair,
      root: resolve(root, "runner"),
      controlUrl: service.config.publicUrl,
      executorControlUrl: `http://${process.env.CLOUD_TEST_EXECUTOR_HOST ?? "host.docker.internal"}:${port}`,
      capacity: 2,
      gitTokenEnv: "CLOUD_FIXTURE_UNUSED_GIT_TOKEN",
    };
    let runner = new Runner(config);
    let taskId = "";
    async function waitFor(
      check: () => Promise<boolean> | boolean,
      label: string,
      timeout = 90000,
    ) {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        await runner.tick();
        if (await check()) return;
        if (taskId && service.store.task(taskId).environmentState === "error")
          throw new Error(
            `Environment failed during ${label}: ${JSON.stringify(service.store.all("SELECT kind,payload FROM events WHERE taskId=? AND kind NOT IN ('session.event') ORDER BY taskSeq DESC LIMIT 8", taskId))}`,
          );
        await delay(750);
      }
      throw new Error(
        `Timed out: ${label}; task=${JSON.stringify(taskId ? service.store.snapshot(taskId, "owner") : null)}`,
      );
    }
    async function create(input: string) {
      const result = await user("/v1/tasks", {
        title: "Docker acceptance",
        runnerId: pair.runnerId,
        templateId: template.id,
        templateVersion: template.version,
        repo: "https://github.com/dsh-cloud/fixture.git",
        ref: "main",
        baseBranch: "main",
        input,
      });
      const seed = resolve(root, "seed-" + result.taskId),
        mirror = resolve(config.root, "trusted", result.taskId + ".git");
      await mkdir(seed, { recursive: true });
      await mkdir(resolve(config.root, "trusted"), { recursive: true });
      await processRun("git", ["init", "-b", "main", seed]);
      await writeFile(
        resolve(seed, "README.md"),
        "Local acceptance repository\n",
      );
      await processRun("git", ["-C", seed, "add", "."]);
      await processRun("git", [
        "-C",
        seed,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@localhost",
        "commit",
        "-m",
        "Initial fixture",
      ]);
      await processRun("git", ["clone", "--bare", seed, mirror]);
      return result;
    }
    try {
      await runner.start();
      const first = await create("WRITE_MARKER");
      taskId = first.taskId;
      const original = service.store.task(taskId);
      await waitFor(
        () =>
          service.store.one<any>(
            "SELECT state FROM runs WHERE id=?",
            first.runId,
          )?.state === "succeeded",
        "first real task",
      );
      const taskRoot = resolve(config.root, "tasks", taskId);
      assert.equal(
        await readFile(resolve(taskRoot, "workspace/marker.txt"), "utf8"),
        marker,
      );
      const firstContainer = (await runner.docker.containers()).find(
        (c) => c.taskId === taskId,
      )!;
      const waiting = await user(`/v1/tasks/${taskId}/inputs`, {
        input: "ASK_AND_WAIT",
      });
      await waitFor(
        () =>
          !!service.store.one(
            "SELECT id FROM interactions WHERE runId=? AND state='pending'",
            waiting.runId,
          ),
        "real cross-device question",
      );
      await runner.close();
      runner = new Runner(config);
      await runner.start();
      assert.equal(
        (await runner.docker.containers()).find((c) => c.taskId === taskId)?.id,
        firstContainer.id,
      );
      const savedConfig = { ...service.config, port };
      await service.close();
      service = new ControlService(savedConfig);
      await service.listen();
      const question = service.store.one<any>(
        "SELECT * FROM interactions WHERE runId=? AND state='pending'",
        waiting.runId,
      )!;
      await user(`/v1/interactions/${question.id}/answers`, {
        version: question.version,
        answer: { answers: [{ id: "continue", selected: ["Continue"] }] },
      });
      await waitFor(
        () =>
          service.store.one<any>(
            "SELECT state FROM runs WHERE id=?",
            waiting.runId,
          )?.state === "succeeded",
        "answer delivered",
      );
      await user(`/v1/tasks/${taskId}/environment/stop`, {});
      await waitFor(
        () => service.store.task(taskId).environmentState === "stopped",
        "environment stopped",
      );
      const resumed = await user(`/v1/tasks/${taskId}/inputs`, {
        input: "READ_MARKER",
      });
      await waitFor(
        () =>
          service.store.one<any>(
            "SELECT state FROM runs WHERE id=?",
            resumed.runId,
          )?.state === "succeeded",
        "resume original native session",
      );
      const now = service.store.task(taskId);
      assert.equal(now.sessionId, original.sessionId);
      assert.equal(now.environmentId, original.environmentId);
      assert.equal(now.epoch, 2);
      assert.equal(
        await readFile(resolve(taskRoot, "workspace/marker.txt"), "utf8"),
        marker,
      );
      assert.ok(now.durableSeq > 30);
      const other = await create("WRITE_MARKER");
      await waitFor(
        () =>
          service.store.one<any>(
            "SELECT state FROM runs WHERE id=?",
            other.runId,
          )?.state === "succeeded",
        "isolated second task",
      );
      assert.notEqual(
        service.store.task(other.taskId).sessionId,
        now.sessionId,
      );
      assert.notEqual(
        service.store.task(other.taskId).environmentId,
        now.environmentId,
      );
      const cancelled = await user(`/v1/tasks/${taskId}/inputs`, {
        input: "ASK_AND_WAIT",
      });
      await waitFor(
        () =>
          !!service.store.one(
            "SELECT id FROM interactions WHERE runId=? AND state='pending'",
            cancelled.runId,
          ),
        "cancellable pending question",
      );
      const queued = await user(`/v1/tasks/${taskId}/inputs`, {
        input: "READ_MARKER",
      });
      const before = Date.now();
      await user(`/v1/runs/${cancelled.runId}/cancel`, {});
      await waitFor(
        () =>
          service.store.one<any>(
            "SELECT state FROM runs WHERE id=?",
            cancelled.runId,
          )?.state === "cancelled",
        "confirmed cancellation",
        45000,
      );
      const cancellationMs = Date.now() - before;
      assert.equal(
        service.store.one<any>(
          "SELECT state FROM runs WHERE id=?",
          queued.runId,
        )?.state,
        "queued",
      );
      assert.equal(service.store.task(taskId).paused, 1);
      assert.ok(
        !(await runner.docker.containers()).find((c) => c.taskId === taskId)!
          .running,
      );
      const recovered = await user(`/v1/tasks/${taskId}/inputs`, {
        input: "READ_MARKER",
        kind: "recovery",
        previousRunId: cancelled.runId,
      });
      await waitFor(
        () =>
          service.store.one<any>(
            "SELECT state FROM runs WHERE id=?",
            recovered.runId,
          )?.state === "succeeded",
        "explicit recovery after cancellation",
      );
      assert.equal(
        service.store.one<any>(
          "SELECT state FROM runs WHERE id=?",
          queued.runId,
        )?.state,
        "cancelled",
      );
      const crashed = await user(`/v1/tasks/${taskId}/inputs`, {
        input: "ASK_AND_WAIT",
      });
      await waitFor(
        () =>
          !!service.store.one(
            "SELECT id FROM interactions WHERE runId=? AND state='pending'",
            crashed.runId,
          ),
        "question before forced runtime crash",
      );
      const victim = (await runner.docker.containers()).find(
        (c) => c.taskId === taskId,
      )!;
      await processRun("docker", ["kill", victim.id]);
      await waitFor(
        () =>
          service.store.one<any>(
            "SELECT state FROM runs WHERE id=?",
            crashed.runId,
          )?.state === "interrupted",
        "crash recorded",
      );
      const afterCrash = await user(`/v1/tasks/${taskId}/inputs`, {
        input: "READ_MARKER",
        kind: "recovery",
        previousRunId: crashed.runId,
      });
      await waitFor(
        () =>
          service.store.one<any>(
            "SELECT state FROM runs WHERE id=?",
            afterCrash.runId,
          )?.state === "succeeded",
        "same native session after forced crash",
      );
      assert.equal(service.store.task(taskId).sessionId, original.sessionId);
      assert.equal(
        await readFile(resolve(taskRoot, "workspace/marker.txt"), "utf8"),
        marker,
      );
      const finalTask = service.store.task(taskId);
      console.log(
        JSON.stringify({
          docker: true,
          runnerOS: process.platform,
          taskId,
          sessionId: now.sessionId,
          environmentId: now.environmentId,
          epoch: finalTask.epoch,
          durableSeq: finalTask.durableSeq,
          forcedCrashRecovery: true,
          modelCalls,
          cancellationMs,
        }),
      );
    } catch (error) {
      for (const c of await runner.docker.containers())
        console.error(
          "Container diagnostics",
          c.taskId,
          await runner.docker.logs(c),
          "Host state files:",
          await readdir(
            resolve(config.root, "tasks", c.taskId, "executor-state"),
          ),
        );
      throw error;
    } finally {
      for (const c of await runner.docker.containers()) {
        const stopped = await runner.docker.stop(c);
        await runner.docker.remove(stopped);
      }
      await runner.close();
      await service.close();
      await model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
