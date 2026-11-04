import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Runner } from "../apps/runner/runner.ts";
import { type Container } from "../apps/runner/docker.ts";
import { beginRecovery } from "../apps/control/recovery.ts";
import { processRun } from "../packages/contracts/process.ts";
import { fixture } from "./helpers.ts";
import { deferred, settle } from "./test-utils.ts";

async function runnerFixture(t: TestContext) {
  const f = await fixture();
  const config = { ...f.runner, controlUrl: f.service.config.publicUrl,
    executorControlUrl: f.service.config.publicUrl, root: resolve(f.root, "runner"),
    capacity: 1, gitTokenEnv: "DSH_CLOUD_TEST_UNUSED_TOKEN" };
  let runner = new Runner(config);
  t.after(async () => { await runner.close(); await f.close(); });
  const inventory: Container[] = [];
  const attach = () => {
    t.mock.method(runner.docker, "containers", async () => inventory);
    t.mock.method(runner.docker, "available", async () => "test-backend");
  };
  attach();
  const createRunning = async () => {
    const { taskId, runId } = (await f.create()).data;
    const e = await f.start(taskId);
    await f.request("/v1/executor/commands", undefined, e.token);
    const container: Container = { id: taskId, name: "test-container", taskId,
      epoch: e.epoch, incarnation: e.incarnation, running: true, paused: false,
      exitCode: 0, oomKilled: false, imageId: "sha256:fixture" };
    inventory.push(container);
    return { taskId, runId, container, e };
  };
  return { ...f, get runner() { return runner; }, inventory, createRunning,
    async restart() { await runner.close(); runner = new Runner(config); attach(); return runner; } };
}

test("Runner revocation stops every container before acknowledging and terminating", async t => {
  const f = await runnerFixture(t);
  const { taskId, runId } = await f.createRunning();
  const stopped: string[] = [];
  t.mock.method(f.runner.docker, "stop", async (c: Container) => { c.running = false; stopped.push(c.id); return c; });
  await f.request(`/v1/runners/${f.runner.config.runnerId}/revoke`, {});
  await assert.rejects(f.runner.heartbeat(), (e: any) => e.status === 401);
  assert.deepEqual(stopped, [taskId]);
  assert.equal(f.runner.abort.signal.aborted, true);
  assert.equal(f.service.store.task(taskId).environmentState, "stopped");
  assert.equal(f.service.store.one<any>("SELECT state FROM runs WHERE id=?", runId).state, "interrupted");
});

test("unconfirmed Docker stop cannot acknowledge a revoked Runner as stopped", async t => {
  const f = await runnerFixture(t);
  const { taskId } = await f.createRunning();
  t.mock.method(f.runner.docker, "stop", async () => { throw new Error("Docker unavailable"); });
  await f.request(`/v1/runners/${f.runner.config.runnerId}/revoke`, {});
  await assert.rejects(f.runner.heartbeat(), /Docker unavailable/);
  assert.equal(f.service.store.task(taskId).environmentState, "needs_stop");
  assert.equal(f.inventory[0]!.running, true);
});

test("overlapping heartbeats share an inventory probe and release the guard after failure", async t => {
  const f = await runnerFixture(t), gate = deferred<Container[]>();
  const probe = t.mock.method(f.runner.docker, "containers", () => gate.promise);
  const first = f.runner.heartbeat();
  await f.runner.heartbeat();
  assert.equal(probe.mock.callCount(), 1);
  gate.reject(new Error("probe failed"));
  await assert.rejects(first, /probe failed/);
  probe.mock.mockImplementation(async () => []);
  await f.runner.heartbeat();
  assert.equal(probe.mock.callCount(), 2);
});

test("a foreign live incarnation blocks provisioning and is never stopped by a normal tick", async t => {
  const f = await runnerFixture(t);
  const { taskId, container } = await f.createRunning();
  container.incarnation = "unknown-incarnation";
  const stop = t.mock.method(f.runner.docker, "stop", async (c: Container) => c);
  const provision = t.mock.method(f.runner as any, "provision", async () => {});
  t.mock.method(console, "error", () => {});
  await f.runner.tick();
  assert.equal(stop.mock.callCount(), 0);
  assert.equal(provision.mock.callCount(), 0);
  assert.equal(f.service.store.task(taskId).environmentState, "busy");
});

test("complete inventory absence interrupts the old Run before allowing any replacement", async t => {
  const f = await runnerFixture(t);
  const { taskId, runId } = await f.createRunning();
  f.inventory.length = 0;
  const provision = t.mock.method(f.runner as any, "provision", async () => {});
  await f.runner.tick();
  const task = f.service.store.task(taskId);
  assert.equal(task.environmentState, "stopped");
  assert.equal(task.recoveryRequired, 1);
  assert.equal(f.service.store.one<any>("SELECT state FROM runs WHERE id=?", runId).state, "interrupted");
  assert.equal(provision.mock.callCount(), 0);
  await f.runner.tick();
  assert.equal(provision.mock.callCount(), 0);
});

test("Runner capacity and pending stop operations prevent a competing launch", async t => {
  const f = await runnerFixture(t);
  await f.createRunning();
  const { taskId } = (await f.create("second task")).data;
  const provision = t.mock.method(f.runner as any, "provision", async () => {});
  await f.runner.tick();
  assert.equal(provision.mock.callCount(), 0);
  const stop = await f.request(`/v1/tasks/${taskId}/environment/stop`, {});
  assert.equal(stop.status, 202, JSON.stringify(stop.data));
  f.inventory[0]!.running = false;
  await f.runner.tick();
  assert.equal(provision.mock.callCount(), 0);
});

test("restore reconciliation stops all containers and publishes the stopped inventory first", async t => {
  const f = await runnerFixture(t);
  const { taskId } = await f.createRunning();
  const recovery = beginRecovery(f.service.store);
  t.mock.method(f.runner.docker, "stop", async (c: Container) => { c.running = false; return c; });
  await f.runner.tick();
  const complete = await f.request("/v1/recovery/complete", { acknowledgeUncertain: true });
  assert.equal(complete.status, 200, JSON.stringify(complete.data));
  assert.equal(f.inventory.every(c => !c.running), true);
  assert.equal(f.service.store.task(taskId).restoreId, recovery.id);
});

test("inspection receipt survives a lost response and Runner restart without inspecting twice", async t => {
  const f = await runnerFixture(t);
  const { taskId, container } = await f.createRunning();
  const workspace = resolve(f.runner.config.root, "tasks", taskId, "workspace");
  await mkdir(workspace, { recursive: true });
  await writeFile(resolve(workspace, "note.txt"), "original");
  const created = await f.request(`/v1/tasks/${taskId}/files?path=note.txt`);
  assert.equal(created.status, 202, JSON.stringify(created.data));
  const work = (await f.request("/v1/runner/work", undefined, f.runner.config.token)).data;
  const op = work.operations.find((o: any) => o.id === created.data.operationId);
  const task = work.tasks.find((x: any) => x.id === taskId);
  const actions: string[] = [];
  t.mock.method(f.runner.docker, "pause", async () => { actions.push("pause"); });
  t.mock.method(f.runner.docker, "unpause", async () => { actions.push("unpause"); });
  const original = (f.runner as any).call.bind(f.runner);
  t.mock.method(f.runner as any, "call", async (path: string, body?: unknown) => {
    const result = await original(path, body);
    if (path.endsWith("/result")) throw new Error("response lost after commit");
    return result;
  });
  await assert.rejects((f.runner as any).perform(op, task, [container]), /response lost/);
  assert.deepEqual(actions, ["pause", "unpause"]);
  await writeFile(resolve(workspace, "note.txt"), "changed after receipt");
  await f.restart();
  t.mock.method(f.runner.docker, "pause", async () => { assert.fail("cached inspection must not run again"); });
  await (f.runner as any).perform(op, task, [container]);
  const receipt = (await f.request(`/v1/operations/${op.id}`)).data;
  assert.equal(receipt.state, "succeeded");
  assert.equal(receipt.result.content, "original");
});

test("inspection failure unpauses the container; failed unpause remains recoverable at startup", async t => {
  const f = await runnerFixture(t);
  const { container } = await f.createRunning();
  t.mock.method(f.runner.docker, "pause", async () => { container.paused = true; });
  t.mock.method(f.runner.docker, "unpause", async () => { throw new Error("unpause unavailable"); });
  await assert.rejects((f.runner as any).paused(container, async () => { throw new Error("read failed"); }), /unpause unavailable/);
  assert.equal(f.runner.journal.value(`paused:${container.id}`, false), true);
  await f.restart();
  const unpause = t.mock.method(f.runner.docker, "unpause", async () => { container.paused = false; });
  await f.runner.start();
  assert.equal(unpause.mock.callCount(), 1);
  assert.equal(f.runner.journal.value(`paused:${container.id}`, true), false);
});

test("Runner lock rejects a live owner and close only removes its own lock", async t => {
  const f = await runnerFixture(t);
  await f.runner.start();
  const lock = resolve(f.runner.config.root, "runner.lock");
  const second = new Runner(f.runner.config);
  await assert.rejects(second.start(), (e: any) => e.code === "RUNNER_LOCKED");
  await second.close();
  assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, process.pid);
  await f.runner.close();
  await assert.rejects(readFile(lock), { code: "ENOENT" });
});

test("close waits for an in-flight heartbeat before closing the journal", async t => {
  const f = await runnerFixture(t), gate = deferred<Container[]>();
  t.mock.method(f.runner.docker, "containers", () => gate.promise);
  const heartbeat = f.runner.heartbeat();
  let closed = false;
  const closing = f.runner.close().then(() => { closed = true; });
  await settle();
  assert.equal(closed, false);
  gate.resolve([]);
  await Promise.all([heartbeat, closing]);
  assert.equal(closed, true);
});

for (const lostLaunchResponse of [false, true]) test(`provisioning pins image and preserves checkout when launch response is ${lostLaunchResponse ? "lost" : "received"}`, async t => {
  const f = await runnerFixture(t);
  const { taskId } = (await f.create()).data;
  const seed = resolve(f.root, "seed"), trusted = resolve(f.runner.config.root, "trusted", taskId + ".git");
  await mkdir(resolve(f.runner.config.root, "trusted"), { recursive: true });
  await processRun("git", ["init", "-b", "main", seed]);
  await writeFile(resolve(seed, "note.txt"), "initial");
  await processRun("git", ["-C", seed, "add", "."]);
  await processRun("git", ["-C", seed, "-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "initial"]);
  await processRun("git", ["clone", "--bare", seed, trusted]);
  const image = t.mock.method(f.runner.docker, "image", async () => ({ Id: "sha256:resolved-runtime" }));
  const launch = t.mock.method(f.runner.docker, "launch", async (config: any, paths: any, imageId: string) => {
    assert.equal(imageId, "sha256:resolved-runtime");
    const onDisk = JSON.parse(await readFile(resolve(paths.state, `config-${config.incarnation}.json`), "utf8"));
    assert.equal(onDisk.token, config.token);
    assert.equal(onDisk.task.baseCommit, config.task.baseCommit);
    assert.equal(await readFile(resolve(paths.workspace, "note.txt"), "utf8"), "initial");
    const c = { id: taskId, name: "fixture", taskId, epoch: config.epoch, incarnation: config.incarnation,
      running: true, paused: false, exitCode: 0, oomKilled: false, imageId };
    f.inventory.push(c);
    if (lostLaunchResponse) throw new Error("launch response lost after container started");
    return c;
  });
  await f.runner.tick();
  await f.runner.tick();
  assert.equal(launch.mock.callCount(), 1);
  assert.equal(image.mock.callCount(), 1);
  assert.equal(f.runner.journal.value(`image:${taskId}`, ""), "sha256:resolved-runtime");
  assert.notEqual(f.service.store.task(taskId).environmentState, "error");
  assert.equal(f.inventory.length, 1);
});
