import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { ReadCoordinator } from "../packages/dsh-cloud-plugin/polling.ts";
import { CloudError } from "../packages/contracts/index.ts";
import { subscribeTask } from "../packages/task-ui/subscription.ts";
import { deferred, settle } from "./test-utils.ts";

test("a read started before a write cannot overwrite a newer cache or delete the newer in-flight read", async () => {
  const reads = new ReadCoordinator(), old = deferred<string>(), fresh = deferred<string>();
  const first = reads.read("/v1/tasks", () => old.promise);
  await settle(); reads.invalidate();
  let fetches = 0;
  const second = reads.read("/v1/tasks", () => { fetches++; return fresh.promise; });
  old.resolve("before-write"); assert.equal(await first, "before-write");
  const joined = reads.read("/v1/tasks", async () => { fetches++; return "wrong"; });
  fresh.resolve("after-write");
  assert.deepEqual(await Promise.all([second, joined]), ["after-write", "after-write"]);
  assert.equal(fetches, 1);
  assert.equal(await reads.read("/v1/tasks", async () => "unexpected"), "after-write");
});

test("a failed old identity cannot back off or repopulate a new identity's reads", async () => {
  const reads = new ReadCoordinator(), old = deferred<string>();
  const stale = reads.read("/v1/tasks", () => old.promise);
  const rejection = assert.rejects(stale, { code: "UNAUTHORIZED" });
  await settle(); reads.reset();
  old.reject(new CloudError(401, "UNAUTHORIZED", "expired old token"));
  await rejection;
  assert.equal(await reads.read("/v1/tasks", async () => "new owner"), "new owner");
});

test("an overlapping successful read does not cancel another request's shared rate-limit backoff", async t => {
  let now = 1000; t.mock.method(Date, "now", () => now);
  const reads = new ReadCoordinator(), delayed = deferred<string>();
  const pending = reads.read("/v1/info", () => delayed.promise);
  await assert.rejects(reads.read("/v1/tasks", async () => { throw new CloudError(429, "RATE_LIMIT", "busy", 90000); }));
  delayed.resolve("info"); await pending;
  let requests = 0;
  now += 89999;
  await assert.rejects(reads.read("/v1/runners", async () => { requests++; return []; }), { code: "RATE_LIMIT" });
  assert.equal(requests, 0);
  now++;
  await reads.read("/v1/runners", async () => { requests++; return []; });
  assert.equal(requests, 1);
});

test("read expiry follows resource freshness and history cursors are never served from a stale cache", async t => {
  let now = 1000; t.mock.method(Date, "now", () => now);
  for (const [path, ttl] of [["/v1/info", 60000], ["/v1/templates", 60000], ["/v1/tasks", 3000], ["/v1/runners", 3000], ["/v1/tasks/task", 2000], ["/v1/tasks/task/history?after=0", 0]] as const) {
    const reads = new ReadCoordinator(); let n = 0;
    const request = () => reads.read(path, async () => ++n);
    assert.equal(await request(), 1);
    if (ttl) { now += ttl - 1; assert.equal(await request(), 1); now++; }
    assert.equal(await request(), 2, path);
  }
});

test("transient read failures back off, cap the delay and reset after successful recovery", async t => {
  let now = 1000; t.mock.method(Date, "now", () => now);
  const reads = new ReadCoordinator(); let calls = 0;
  const fail = () => reads.read("/v1/tasks", async () => { calls++; throw new Error("offline"); });
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    const prior = calls;
    await assert.rejects(fail()); assert.equal(calls, prior + 1);
    now += delay - 1; await assert.rejects(fail()); assert.equal(calls, prior + 1);
    now++;
  }
  await reads.read("/v1/tasks", async () => "reconnected"); reads.invalidate();
  await assert.rejects(fail()); now += 1000;
  assert.equal(await reads.read("/v1/tasks", async () => "working"), "working");
});

function subscription(t: TestContext, request: (path: string) => Promise<any>) {
  const histories: any[][] = [], snapshots: any[] = [], events: any[] = [], errors: string[] = [], statuses: boolean[] = [];
  const watches: { after: number; event: (e: any) => void; status: (v: boolean) => void; closed: number }[] = [];
  const stop = subscribeTask({ request, logout: async () => {}, watch: (_id, after, event, status) => {
    const item = { after, event, status, closed: 0 }; watches.push(item); status(true);
    return () => { item.closed++; };
  } }, "test", {
    snapshot: v => snapshots.push(v), history: v => histories.push(v), event: v => events.push(v),
    status: v => statuses.push(v), error: v => errors.push(v),
  }, 5);
  t.after(stop);
  return { stop, watches, histories, snapshots, events, errors, statuses };
}

test("history is fully paginated before publishing a snapshot or opening the live stream", async t => {
  const pages: string[] = [], second = deferred<any>();
  const s = subscription(t, async path => {
    if (!path.includes("history")) return { task: { id: "test" }, snapshotSeq: 10 };
    pages.push(path);
    return path.endsWith("after=-1") ? { events: [{ seq: 0 }, { seq: 1 }], durableSeq: 2 } : second.promise;
  });
  await settle();
  assert.equal(s.snapshots.length, 0); assert.equal(s.watches.length, 0);
  second.resolve({ events: [{ seq: 2 }], durableSeq: 2 }); await settle();
  assert.deepEqual(pages, ["/v1/tasks/test/history?after=-1", "/v1/tasks/test/history?after=1"]);
  assert.deepEqual(s.histories[0], [{ seq: 0 }, { seq: 1 }, { seq: 2 }]);
  assert.equal(s.watches[0]!.after, 10);
});

test("a live event gap reconnects from a complete snapshot and ignores duplicate or obsolete callbacks", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let generation = 0;
  const s = subscription(t, async path => path.includes("history")
    ? { events: Array.from({ length: generation }, (_, seq) => ({ seq })), durableSeq: generation - 1 }
    : { snapshotSeq: ++generation === 1 ? 10 : 20, task: { generation } });
  await settle(); const old = s.watches[0]!;
  old.event({ taskSeq: 10 }); assert.equal(s.events.length, 0);
  old.event({ taskSeq: 12 }); assert.equal(old.closed, 1);
  old.event({ taskSeq: 11 }); old.status(true); assert.equal(s.events.length, 0);
  t.mock.timers.tick(5); await settle();
  assert.equal(s.watches.length, 2); assert.equal(s.watches[1]!.after, 20);
  assert.equal(s.histories[1]!.length, 2); assert.equal(s.errors.at(-1), "");
  s.watches[1]!.event({ taskSeq: 21 }); s.watches[1]!.event({ taskSeq: 21 });
  assert.deepEqual(s.events, [{ taskSeq: 21 }]);
});

test("a disconnected live stream is closed and reacquires history before reconnecting", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let histories = 0;
  const s = subscription(t, async path => path.includes("history") ? (histories++, { events: [], durableSeq: -1 }) : { task: {}, snapshotSeq: 0 });
  await settle(); s.watches[0]!.status(false);
  assert.equal(s.statuses.at(-1), false); assert.equal(s.watches[0]!.closed, 1);
  t.mock.timers.tick(5); await settle();
  assert.equal(histories, 2); assert.equal(s.statuses.at(-1), true);
  s.stop(); assert.equal(s.watches[1]!.closed, 1);
});

for (const broken of ["gap", "empty-prefix"]) test(`${broken} history never appears as a complete conversation and can recover`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let calls = 0;
  const s = subscription(t, async path => {
    if (!path.includes("history")) return { task: {}, snapshotSeq: 0 };
    if (++calls === 1) return { events: broken === "gap" ? [{ seq: 1 }] : [], durableSeq: 1 };
    return { events: [{ seq: 0 }, { seq: 1 }], durableSeq: 1 };
  });
  await settle(); assert.equal(s.watches.length, 0); assert.equal(s.histories.length, 0);
  t.mock.timers.tick(5); await settle();
  assert.equal(s.watches.length, 1); assert.equal(s.histories[0]!.length, 2);
});

for (const phase of ["snapshot", "history"]) test(`unmount during ${phase} prevents late state changes and subscriptions`, async t => {
  const pending = deferred<any>();
  const s = subscription(t, async path => path.includes("history") ? pending.promise : phase === "snapshot" ? pending.promise : { task: {}, snapshotSeq: 0 });
  await settle(); s.stop();
  pending.resolve({ task: {}, snapshotSeq: 0, events: [], durableSeq: -1 }); await settle();
  assert.equal(s.watches.length, 0); assert.equal(s.histories.length, 0); assert.equal(s.snapshots.length, 0);
});
