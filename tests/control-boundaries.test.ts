import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import { id, digest, PROTOCOL, DSH_VERSION } from "../packages/contracts/index.ts";

test("parallel environment lease retries produce one incarnation and competing starts cannot replace it", async t => {
  const f = await fixture(); t.after(f.close);
  const { taskId } = (await f.create()).data;
  const body = { operationId: id(), previousEpoch: 0, previousContainerStopped: true };
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.request(`/v1/runner/environments/${taskId}/start`, body, f.runner.token)));
  assert.ok(replies.every(r => r.status === 200));
  assert.equal(new Set(replies.map(r => r.data.incarnation)).size, 1);
  assert.equal(new Set(replies.map(r => r.data.token)).size, 1);
  assert.equal(f.service.store.task(taskId).epoch, 1);
  const conflict = await f.request(`/v1/runner/environments/${taskId}/start`, { ...body, operationId: id() }, f.runner.token);
  assert.equal(conflict.data.error.code, "ENVIRONMENT_ACTIVE");
  assert.equal(f.service.store.all("SELECT * FROM events WHERE kind='environment.starting'").length, 1);
});

test("a stale supervisor blocks queued dispatch and a current heartbeat safely re-enables it", async t => {
  const f = await fixture(); t.after(f.close);
  const { taskId, runId } = (await f.create()).data, lease = await f.start(taskId);
  f.service.store.exec("UPDATE runners SET lastSeenAt=?", Date.now() - 30001);
  assert.equal((await f.request("/v1/executor/commands", undefined, lease.token)).data.current, null);
  assert.equal(f.service.store.one<any>("SELECT state FROM runs WHERE id=?", runId).state, "queued");
  assert.equal((await f.request("/v1/runner/heartbeat", { protocol: PROTOCOL, dshVersion: DSH_VERSION, capacity: 1, inventory: [] }, f.runner.token)).status, 200);
  const replies = await Promise.all(Array.from({ length: 10 }, () => f.request("/v1/executor/commands", undefined, lease.token)));
  assert.ok(replies.every(r => r.data.current.run.id === runId));
  assert.equal(f.service.store.all("SELECT * FROM attempts WHERE runId=?", runId).length, 1);
});

test("invalid request framing and oversized input never leave a task or idempotency record", async t => {
  const f = await fixture(); t.after(f.close);
  const cases = [
    { headers: { "content-type": "text/plain" }, body: "{}", code: "CONTENT_TYPE", status: 415 },
    { headers: { "content-type": "application/json" }, body: '{"broken":', code: "INVALID_JSON", status: 400 },
    { headers: { "content-type": "application/json" }, body: JSON.stringify({ input: "x".repeat(1024 * 1024) }), code: "BODY_TOO_LARGE", status: 413 },
  ];
  const before = f.service.store.all("SELECT * FROM idempotency").length;
  for (const item of cases) {
    const res = await fetch(f.service.config.publicUrl + "/v1/tasks", { method: "POST", headers: { authorization: `Bearer ${f.owner}`, "idempotency-key": id(), ...item.headers }, body: item.body });
    assert.equal(res.status, item.status);
    assert.equal((await res.json() as any).error.code, item.code);
  }
  assert.equal(f.service.store.all("SELECT * FROM tasks").length, 0);
  assert.equal(f.service.store.all("SELECT * FROM idempotency").length, before);
  assert.equal((await f.create()).status, 202, "an oversized request must not poison subsequent requests");
});

test("native and control histories paginate without gaps, reject invalid cursors and roll back a conflicting batch", async t => {
  const f = await fixture(); t.after(f.close);
  const { taskId } = (await f.create()).data, lease = await f.start(taskId);
  const events = Array.from({ length: 701 }, (_, seq) => ({ seq, type: "assistant/message", data: { text: `event-${seq}` } }));
  assert.equal((await f.request("/v1/executor/events", { runId: null, events }, lease.token)).status, 200);
  const read: any[] = [];
  for (let after = -1; after < 700;) {
    const page = (await f.request(`/v1/tasks/${taskId}/history?after=${after}`)).data;
    assert.ok(page.events.length <= 300); read.push(...page.events); after = read.at(-1).seq;
  }
  assert.deepEqual(read, events);
  let cursor = 0; const seqs: number[] = [];
  while (true) {
    const page = (await f.request(`/v1/tasks/${taskId}/events/poll?after=${cursor}`)).data;
    if (!page.events.length) break;
    assert.ok(page.events.length <= 200);
    for (const event of page.events) { assert.equal(event.taskSeq, ++cursor); seqs.push(cursor); }
  }
  assert.equal(seqs.length, f.service.store.snapshot(taskId, "owner").snapshotSeq);
  for (const invalid of ["-2", "0.5", "NaN", "9007199254740992"]) {
    assert.equal((await f.request(`/v1/tasks/${taskId}/history?after=${invalid}`)).data.error.code, "INVALID_CURSOR");
    assert.equal((await f.request(`/v1/tasks/${taskId}/events/poll?after=${invalid}`)).data.error.code, "INVALID_CURSOR");
  }
  const before = f.service.store.snapshot(taskId, "owner").snapshotSeq;
  const result = await f.request("/v1/executor/events", { runId: null, events: [{ seq: 701, type: "new" }, { ...events[0], data: { text: "changed" } }] }, lease.token);
  assert.equal(result.data.error.code, "EVENT_CONFLICT");
  assert.equal(f.service.store.task(taskId).durableSeq, 700);
  assert.equal(f.service.store.snapshot(taskId, "owner").snapshotSeq, before);
});

test("publication binds checks to the exact revision and retries one operation without bypassing failed required checks", async t => {
  const f = await fixture(); t.after(f.close);
  const { taskId, runId } = (await f.create()).data, lease = await f.start(taskId);
  await f.request("/v1/executor/commands", undefined, lease.token);
  const result = { workspaceRevision: "tree-1", durableSeq: -1, checks: [{ required: true, state: "failed" }] };
  assert.equal((await f.request("/v1/executor/status", { runId, state: "succeeded", result }, lease.token)).status, 200);
  const body = { runId, workspaceRevision: "tree-1" };
  assert.equal((await f.request(`/v1/tasks/${taskId}/publications`, { ...body, workspaceRevision: "old-tree" })).data.error.code, "STALE_WORKSPACE");
  assert.equal((await f.request(`/v1/tasks/${taskId}/publications`, body)).data.error.code, "CHECKS_FAILED");
  const key = id(), publish = { ...body, allowFailedChecks: true };
  const first = await f.request(`/v1/tasks/${taskId}/publications`, publish, f.owner, key);
  const again = await f.request(`/v1/tasks/${taskId}/publications`, publish, f.owner, key);
  assert.equal(first.status, 202); assert.deepEqual(first.data, again.data);
  assert.equal((await f.request(`/v1/tasks/${taskId}/publications`, publish)).data.error.code, "PUBLICATION_ACTIVE");
  assert.equal(f.service.store.all("SELECT * FROM operations WHERE kind='publish'").length, 1);
});

test("archived tasks cannot admit input and an acknowledged deletion removes history, results and executor credentials", async t => {
  const f = await fixture(); t.after(f.close);
  const { taskId, runId } = (await f.create()).data, lease = await f.start(taskId);
  await f.request("/v1/executor/commands", undefined, lease.token);
  await f.request("/v1/executor/events", { runId, events: [{ seq: 0, type: "user/message", data: { text: "private test fixture" } }] }, lease.token);
  await f.request("/v1/executor/status", { runId, state: "succeeded", result: { workspaceRevision: "tree", durableSeq: 0 } }, lease.token);
  await f.request(`/v1/tasks/${taskId}/lifecycle`, { action: "archive" });
  assert.equal((await f.request(`/v1/tasks/${taskId}/inputs`, { input: "not admitted" })).data.error.code, "TASK_CLOSED");
  const removal = (await f.request(`/v1/tasks/${taskId}/lifecycle`, { action: "delete" })).data;
  assert.equal(f.service.store.task(taskId).lifecycle, "delete_pending");
  assert.equal(f.service.store.all("SELECT * FROM native_events WHERE taskId=?", taskId).length, 1);
  await f.request(`/v1/runner/operations/${removal.operationId}/claim`, {}, f.runner.token);
  const receipt = { state: "succeeded", result: { deleted: true, stopped: true } };
  assert.equal((await f.request(`/v1/runner/operations/${removal.operationId}/result`, receipt, f.runner.token)).status, 200);
  assert.equal((await f.request(`/v1/runner/operations/${removal.operationId}/result`, receipt, f.runner.token)).status, 200);
  assert.equal(f.service.store.task(taskId).lifecycle, "deleted");
  assert.equal(f.service.store.all("SELECT * FROM native_events WHERE taskId=?", taskId).length, 0);
  assert.equal(f.service.store.one<any>("SELECT * FROM runs WHERE id=?", runId).input, "");
  assert.equal(f.service.store.one<any>("SELECT * FROM runs WHERE id=?", runId).result, null);
  assert.equal(f.service.store.one("SELECT * FROM credentials WHERE hash=?", digest(lease.token)), undefined);
  assert.equal((await f.request("/v1/executor/commands", undefined, lease.token)).status, 401);
});

test("nonterminal replays cannot regress a finalizing run or rewrite a terminal result", async t => {
  const f = await fixture(); t.after(f.close);
  const { taskId, runId } = (await f.create()).data, lease = await f.start(taskId);
  await f.request("/v1/executor/commands", undefined, lease.token);
  const status = (state: string, extra = {}) => f.request("/v1/executor/status", { runId, state, ...extra }, lease.token);
  assert.equal((await status("accepted", { messageId: "message-1" })).status, 200);
  assert.equal((await status("accepted", { messageId: "message-2" })).data.error.code, "MESSAGE_CONFLICT");
  assert.equal((await status("finalizing")).status, 200);
  assert.equal((await status("running")).data.error.code, "INVALID_TRANSITION");
  const result = { durableSeq: -1, workspaceRevision: "tree" };
  await status("succeeded", { result });
  await status("running");
  assert.equal(f.service.store.one<any>("SELECT state FROM runs WHERE id=?", runId).state, "succeeded");
  assert.equal((await status("succeeded", { result })).status, 200);
  assert.equal((await status("succeeded", { result: { ...result, changed: true } })).data.error.code, "RESULT_CONFLICT");
  assert.equal(f.service.store.all("SELECT * FROM events WHERE taskId=? AND kind='run.succeeded'", taskId).length, 1);
});

test("interaction identity retries preserve the question and cannot change its kind or originating run", async t => {
  const f = await fixture(); t.after(f.close);
  const { taskId, runId } = (await f.create()).data, lease = await f.start(taskId);
  await f.request("/v1/executor/commands", undefined, lease.token);
  const payload = { runId, nativeId: id(), kind: "question", body: { question: "continue?" } };
  const first = await f.request("/v1/executor/interactions", payload, lease.token);
  assert.deepEqual((await f.request("/v1/executor/interactions", payload, lease.token)).data, first.data);
  assert.equal((await f.request("/v1/executor/interactions", { ...payload, kind: "approval" }, lease.token)).data.error?.code, "INTERACTION_CONFLICT");
  await f.request("/v1/executor/status", { runId, state: "succeeded", result: { durableSeq: -1, workspaceRevision: "tree" } }, lease.token);
  const next = (await f.request(`/v1/tasks/${taskId}/inputs`, { input: "next" })).data.runId;
  await f.request("/v1/executor/commands", undefined, lease.token);
  assert.equal((await f.request("/v1/executor/interactions", { ...payload, runId: next }, lease.token)).data.error?.code, "INTERACTION_CONFLICT");
});
