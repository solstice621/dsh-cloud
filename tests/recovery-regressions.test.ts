import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fixture, template } from "./helpers.ts";
import { CloudError, id, PROTOCOL, DSH_VERSION } from "../packages/contracts/index.ts";
import { api } from "../packages/contracts/http.ts";
import { boundResultPayload, RESULT_BODY_LIMIT } from "../packages/contracts/results.ts";
import { Store } from "../apps/control/db.ts";
import { beginRecovery } from "../apps/control/recovery.ts";
import { Executor } from "../apps/executor/executor.ts";
import { Runner } from "../apps/runner/runner.ts";

const stopped = (f: Awaited<ReturnType<typeof fixture>>, taskId: string, lease: any) => f.request(`/v1/runner/environments/${taskId}/stopped`, {
  epoch: lease.epoch, incarnation: lease.incarnation, confirmedStopped: true,
}, f.runner.token);

for (const state of ["uncertain", "interrupted"]) test(`${state} recovery barrier survives archive, newer cancellation, setup retry and restart`, async () => {
  const f = await fixture();
  try {
    const { taskId, runId } = (await f.create()).data, e = await f.start(taskId);
    await f.request("/v1/executor/commands", undefined, e.token);
    const queued = (await f.request(`/v1/tasks/${taskId}/inputs`, { input: "depends on old result" })).data;
    const cancelled = (await f.request(`/v1/tasks/${taskId}/inputs`, { input: "newer cancelled input" })).data;
    await f.request("/v1/executor/status", { runId, state, result: { error: "injected uncertainty" } }, e.token);
    assert.equal((await f.request(`/v1/tasks/${taskId}/inputs`, { input: "premature recovery", kind: "recovery", previousRunId: runId, acknowledgeUncertain: true })).data.error.code, "STOP_UNCONFIRMED");
    await stopped(f, taskId, e);
    await f.request(`/v1/runs/${cancelled.runId}/cancel`, {});
    for (const action of ["archive", "reopen"]) assert.equal((await f.request(`/v1/tasks/${taskId}/lifecycle`, { action })).status, 202);
    assert.equal(f.service.store.task(taskId).paused, 1);
    assert.equal(f.service.store.task(taskId).recoveryRunId, runId);
    assert.equal((await f.request(`/v1/tasks/${taskId}/queue/resume`, {})).data.error.code, "RECOVERY_REQUIRED");
    assert.equal((await f.request(`/v1/tasks/${taskId}/inputs`, { input: "bypass" })).data.error.code, "RECOVERY_REQUIRED");
    const op = (await f.request(`/v1/tasks/${taskId}/environment/retry-setup`, {})).data;
    await f.request(`/v1/runner/operations/${op.operationId}/result`, { state: "succeeded", result: {} }, f.runner.token);
    assert.equal(f.service.store.task(taskId).paused, 1, "setup retry must not clear recovery");
    // Even an accidental paused=0 in another code path must not dispatch the old queue.
    f.service.store.exec("UPDATE tasks SET paused=0 WHERE id=?", taskId);
    assert.equal(f.service.store.nextRun(taskId, e.epoch, e.incarnation), null);
    const reopened = new Store(f.service.config.database);
    assert.equal(reopened.task(taskId).recoveryRunId, runId); reopened.close();
    assert.equal((await f.request(`/v1/tasks/${taskId}/inputs`, { input: "wrong predecessor", kind: "recovery", previousRunId: cancelled.runId, acknowledgeUncertain: true })).data.error.code, "INVALID_RECOVERY");
    if (state === "uncertain") assert.equal((await f.request(`/v1/tasks/${taskId}/inputs`, { input: "unchecked", kind: "recovery", previousRunId: runId })).data.error.code, "UNCERTAIN_ACK_REQUIRED");
    const recovery = await f.request(`/v1/tasks/${taskId}/inputs`, { input: "inspected original workspace", kind: "recovery", previousRunId: runId, acknowledgeUncertain: true });
    assert.equal(recovery.status, 202);
    assert.equal(f.service.store.task(taskId).recoveryRequired, 0);
    assert.equal(f.service.store.one<any>("SELECT state FROM runs WHERE id=?", queued.runId).state, "cancelled");
    assert.equal(f.service.store.nextRun(taskId, e.epoch, e.incarnation)?.run.id, recovery.data.runId);
  } finally { await f.close(); }
});

test("schema 1 migration reconstructs an unresolved barrier hidden behind a cancelled Run", async () => {
  const f = await fixture();
  try {
    const { taskId, runId } = (await f.create()).data, e = await f.start(taskId);
    await f.request("/v1/executor/commands", undefined, e.token);
    const later = (await f.request(`/v1/tasks/${taskId}/inputs`, { input: "newer" })).data;
    await f.request("/v1/executor/status", { runId, state: "uncertain", result: {} }, e.token);
    await f.request(`/v1/runs/${later.runId}/cancel`, {});
    f.service.store.db.exec(`ALTER TABLE tasks DROP COLUMN recoveryRequired; ALTER TABLE tasks DROP COLUMN recoveryRunId;
      ALTER TABLE tasks DROP COLUMN recoveryReason; ALTER TABLE tasks DROP COLUMN restoreId; UPDATE meta SET value='1' WHERE key='schemaVersion'; UPDATE tasks SET paused=0;`);
    const upgraded = new Store(f.service.config.database);
    try { assert.equal(upgraded.task(taskId).recoveryRunId, runId); assert.equal(upgraded.task(taskId).paused, 1); }
    finally { upgraded.close(); }
  } finally { await f.close(); }
});

test("restore quarantines old unknown output, while a new unknown Run remains a protocol failure", async () => {
  const f = await fixture(); let executor: Executor | undefined;
  try {
    const { taskId, runId } = (await f.create()).data, old = await f.start(taskId);
    await f.request("/v1/executor/commands", undefined, old.token);
    const mode = beginRecovery(f.service.store);
    await f.request("/v1/runner/heartbeat", { protocol: PROTOCOL, dshVersion: DSH_VERSION, capacity: 1, inventory: [] }, f.runner.token);
    await f.request("/v1/runner/reconciled", { restoreId: mode.id }, f.runner.token);
    assert.equal((await f.request("/v1/recovery/complete", { acknowledgeUncertain: true })).status, 200);
    assert.equal((await f.request(`/v1/tasks/${taskId}/queue/resume`, {})).data.error.code, "RECOVERY_REQUIRED");
    const recovery = (await f.request(`/v1/tasks/${taskId}/inputs`, { input: "inspect and recover", kind: "recovery", previousRunId: runId, acknowledgeUncertain: true })).data;
    const e = await f.start(taskId);
    const orphanRunId = id();
    const hello = await f.request("/v1/executor/hello", { protocol: PROTOCOL, dshVersion: DSH_VERSION, journalRunId: orphanRunId, phase: "complete", restoreId: null }, e.token);
    assert.equal(hello.data.reconcileRequired, false);
    executor = new Executor({ ...e, controlUrl: f.service.config.publicUrl, template, stateDir: resolve(f.root, "executor"), workspace: resolve(f.root, "workspace"), dshHome: resolve(f.root, "home") } as any);
    executor.journal.queue("/v1/executor/status", { runId: orphanRunId, state: "succeeded", result: { workspaceRevision: "tree", durableSeq: -1 } });
    executor.journal.set("restoreId", mode.id);
    await (executor as any).sync();
    assert.equal(executor.journal.all("SELECT * FROM outbox").length, 0);
    assert.equal(executor.journal.get<any>("SELECT * FROM rejected_outbox").reason, "RESTORED_RUN_NOT_FOUND");
    assert.equal(f.service.store.task(taskId).recoveryRequired, 0);
    assert.equal((await f.request("/v1/executor/commands", undefined, e.token)).data.current.run.id, recovery.runId);
    assert.equal(f.service.store.all("SELECT * FROM events WHERE kind='outbox.reconciliation'").length, 1);
    executor.journal.queue("/v1/executor/status", { runId: id(), state: "succeeded", result: {} });
    await assert.rejects((executor as any).sync(), (err: any) => err.code === "DELIVERY_REJECTED");
    assert.equal(executor.journal.all("SELECT * FROM rejected_outbox").length, 2);
    assert.equal(f.service.store.task(taskId).recoveryRequired, 1);
  } finally { executor?.journal.close(); await f.close(); }
});

test("combined result and status fit actual HTTP limits after UTF-8 and JSON escaping", async () => {
  const f = await fixture();
  try {
    const { taskId, runId } = (await f.create()).data, e = await f.start(taskId);
    await f.request("/v1/executor/commands", undefined, e.token);
    const artifact = { id: id(), runId, revision: "tree", kind: "result", body: {
      diff: "x".repeat(6 * 1024 * 1024), workspaceRevision: "tree",
      checks: [0, 1].map(i => ({ name: `check-${i}`, required: true, state: "passed", stdout: '"\n'.repeat(1.75 * 1024 * 1024), stderr: "" })),
    } };
    assert.ok(Buffer.byteLength(JSON.stringify(artifact)) > RESULT_BODY_LIMIT);
    const bounded = boundResultPayload(artifact, `results/${runId}.json`);
    assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= RESULT_BODY_LIMIT);
    assert.equal((await f.request("/v1/executor/artifacts", bounded, e.token)).status, 200);
    const stored = (await f.request(`/v1/artifacts/${artifact.id}`)).data.body;
    assert.ok(stored.truncation.fields.length);
    assert.deepEqual(stored.checks.map((c: any) => c.state), ["passed", "passed"]);
    const status = boundResultPayload({ runId, state: "succeeded", result: { checks: artifact.body.checks, finalResponse: "结果😀".repeat(1024 * 1024), workspaceRevision: "tree", durableSeq: -1 } }, `results/${runId}.json`);
    assert.ok(Buffer.byteLength(JSON.stringify(status)) <= RESULT_BODY_LIMIT);
    assert.equal((await f.request("/v1/executor/status", status, e.token)).status, 200);
    await assert.rejects(api(f.service.config.publicUrl, "/v1/executor/artifacts", e.token, artifact), (err: any) => err instanceof CloudError && err.status === 413);
  } finally { await f.close(); }
});

test("stopped-container acknowledgement survives result replay failure", async () => {
  const f = await fixture();
  try {
    const { taskId, runId } = (await f.create()).data, e = await f.start(taskId);
    await f.request("/v1/executor/commands", undefined, e.token);
    await f.request(`/v1/runs/${runId}/cancel`, {});
    const runner: any = Object.create(Runner.prototype);
    runner.replayStoppedJournal = async () => { throw new CloudError(413, "BODY_TOO_LARGE", "injected upload failure"); };
    runner.log = () => {};
    runner.call = (path: string, body: any) => api(f.service.config.publicUrl, path, f.runner.token, body);
    await runner.reportStopped(f.service.store.task(taskId), e, "cancel_requested");
    assert.equal(f.service.store.task(taskId).environmentState, "stopped");
    assert.equal(f.service.store.one<any>("SELECT state FROM runs WHERE id=?", runId).state, "cancelled");
  } finally { await f.close(); }
});
