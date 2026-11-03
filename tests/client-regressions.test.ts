import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture } from "./helpers.ts";
import { CloudError } from "../packages/contracts/index.ts";
import { api } from "../packages/contracts/http.ts";
import { ReadCoordinator, authenticationFailed } from "../packages/dsh-cloud-plugin/polling.ts";
import { NativeCloudSessions } from "../packages/dsh-cloud-plugin/native.ts";
import { CloudService } from "../packages/dsh-cloud-plugin/index.ts";
import { Auth } from "../apps/control/auth.ts";
import { subscribeTask } from "../packages/task-ui/subscription.ts";

test("four desktop Hosts with twenty opened idle sessions stay below the shared owner budget", async t => {
  const f = await fixture();
  try {
    const tasks: any[] = [];
    for (let i = 0; i < 20; i++) tasks.push((await f.create()).data);
    f.service.store.exec("UPDATE runs SET state='succeeded'");
    f.service.store.exec("UPDATE tasks SET environmentState='ready'");
    let now = Date.now(); t.mock.method(Date, "now", () => now);
    let requests = 0, details = 0, histories = 0, rateLimits = 0;
    const hosts: NativeCloudSessions[] = [];
    for (let i = 0; i < 4; i++) {
      const reads = new ReadCoordinator();
      const ctx: any = { emit() {}, typertGateway: { hasLiveClient: () => false }, sessionProjections: { restore: () => ({ snapshot: { values: {} } }) } };
      const request = (path: string) => reads.read(path, async () => {
        requests++;
        if (/\/tasks\/[^/]+$/.test(path)) details++;
        if (path.includes("/history")) histories++;
        try { return await api(f.service.config.publicUrl, path, f.owner); }
        catch (error) { if ((error as any).status === 429) rateLimits++; throw error; }
      });
      const native = new NativeCloudSessions(ctx, request, resolve(f.root, `native-${i}.json`));
      await native.status();
      for (const [sessionId] of native.entries) await native.invoke("detail", { sessionId });
      hosts.push(native);
    }
    const initialDetails = details, initialHistories = histories, initialRequests = requests;
    // Exercise the same poll used by real native control subscriptions for 90 virtual seconds.
    for (let elapsed = 0; elapsed < 90000; elapsed += 700) {
      now += 700;
      await Promise.all(hosts.flatMap(host => [(host as any).pollActive(), (host as any).pollActive()]));
    }
    assert.equal(details, initialDetails); assert.equal(histories, initialHistories);
    assert.ok(requests - initialRequests < 150, `idle polling used ${requests - initialRequests} requests`);
    assert.equal(rateLimits, 0);
    t.diagnostic(`4 Hosts / 20 opened idle sessions / 90 virtual seconds: ${requests - initialRequests - 4} background requests, ${initialRequests} initial requests, 0 HTTP 429`);
    assert.equal((await f.request(`/v1/tasks/${tasks[0].taskId}/title`, { title: "Changed on another device" })).status, 200);
    now += 4000;
    await Promise.all(hosts.map(host => (host as any).pollActive()));
    assert.equal(details, initialDetails + 4, "only the changed session is refreshed on each Host");
    assert.equal(histories, initialHistories, "metadata changes do not re-read unchanged history");
    assert.equal(rateLimits, 0);
  } finally { await f.close(); }
});

test("read coalescing, shared 429 backoff and transient errors preserve authentication", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const reads = new ReadCoordinator(); let calls = 0, fail = true;
  const fetch = async () => { calls++; if (fail) throw new CloudError(429, "RATE_LIMIT", "retry", 90000); return { ok: true }; };
  await Promise.allSettled([reads.read("/v1/tasks", fetch), reads.read("/v1/tasks", fetch)]);
  assert.equal(calls, 1);
  for (let i = 0; i < 10; i++) await assert.rejects(reads.read("/v1/runners", fetch));
  now += 60000; await assert.rejects(reads.read("/v1/tasks", fetch)); assert.equal(calls, 1);
  now += 30000; fail = false;
  assert.deepEqual(await reads.read("/v1/tasks", fetch), { ok: true }); assert.equal(calls, 2);
  assert.equal(authenticationFailed(new CloudError(429, "RATE_LIMIT", "retry")), false);
  assert.equal(authenticationFailed(new Error("offline")), false);
  assert.equal(authenticationFailed(new CloudError(401, "UNAUTHORIZED", "sign in")), true);
});

test("OIDC discovery failure is shared, backs off, and can subsequently initialize", async t => {
  let now = Date.now(); t.mock.method(Date, "now", () => now);
  const auth: any = new Auth({} as any, {} as any), configuration = { issuer: "fixture" };
  let calls = 0;
  t.mock.method(auth, "discover", async () => { if (++calls === 1) throw new Error("identity provider offline"); return configuration; });
  const first = await Promise.allSettled([auth.client(), auth.client()]);
  assert.ok(first.every(result => result.status === "rejected")); assert.equal(calls, 1);
  await assert.rejects(auth.client(), (e: any) => e.code === "OIDC_UNAVAILABLE");
  now += 1001;
  assert.equal(await auth.client(), configuration); assert.equal(await auth.client(), configuration); assert.equal(calls, 2);
});

for (const failure of ["offline", "expired"]) test(`logout clears local credentials when remote revocation is ${failure}`, async t => {
  const f = await fixture();
  try {
    const file = resolve(f.root, "device.json"); await writeFile(file, JSON.stringify({ token: "test-token" }));
    const cloud: any = Object.create(CloudService.prototype);
    cloud.ready = Promise.resolve(); cloud.credentialWrites = Promise.resolve(); cloud.authGeneration = 0; cloud.token = "test-token"; cloud.pending = { deviceId: "pending" };
    cloud.reads = new ReadCoordinator(); cloud.credentialFile = file; cloud.url = f.service.config.publicUrl;
    let signedOut = 0; cloud.native = { signOut: () => signedOut++ };
    t.mock.method(globalThis, "fetch", async () => {
      assert.equal(cloud.token, "", "local credentials clear before awaiting remote revocation");
      if (failure === "offline") throw new Error("offline");
      return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED" } }), { status: 401 });
    });
    const result = JSON.parse(await cloud.invoke(JSON.stringify({ op: "logout" })));
    assert.equal(result.ok, true); assert.equal(result.value.revoked, false); assert.ok(result.value.warning);
    assert.equal(cloud.token, ""); assert.equal(cloud.pending, undefined); assert.equal(signedOut, 1);
    await assert.rejects(readFile(file), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("logout cancels an in-flight device login before it can restore credentials", async t => {
  const f = await fixture();
  try {
    const cloud: any = Object.create(CloudService.prototype), file = resolve(f.root, "device.json");
    cloud.ready = Promise.resolve(); cloud.credentialWrites = Promise.resolve(); cloud.authGeneration = 0;
    cloud.token = "old-token"; cloud.pending = { deviceId: "test", pollToken: "poll" };
    cloud.reads = new ReadCoordinator(); cloud.credentialFile = file; cloud.url = f.service.config.publicUrl; cloud.native = { signOut() {} };
    await writeFile(file, "old credential");
    let release!: (response: Response) => void;
    const pending = new Promise<Response>(resolve => release = resolve);
    t.mock.method(globalThis, "fetch", async (url: any) => String(url).endsWith("/auth/device/token") ? pending : new Response('{"ok":true}'));
    const login = cloud.invoke(JSON.stringify({ op: "finishLogin" }));
    assert.equal(JSON.parse(await cloud.invoke(JSON.stringify({ op: "logout" }))).ok, true);
    release(new Response(JSON.stringify({ state: "approved", token: "late-token" })));
    assert.equal(JSON.parse(await login).error.code, "LOGIN_CANCELLED");
    assert.equal(cloud.token, ""); await assert.rejects(readFile(file), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("initial history failure retries the entire subscription and cleans up on unmount", { timeout: 5000 }, async () => {
  let historyCalls = 0, watches = 0, stops = 0, eventCallback: (event: any) => void = () => {};
  const states: boolean[] = [], errors: string[] = [], histories: any[] = [], seen: any[] = [];
  let connected!: () => void;
  const ready = new Promise<void>(resolve => connected = resolve);
  const transport: any = {
    request: async (path: string) => {
      if (!path.includes("history")) return { task: {}, snapshotSeq: 3 };
      if (++historyCalls === 1) throw new Error("temporary history outage");
      return { events: [{ seq: 0, type: "user/message" }], durableSeq: 0 };
    },
    watch: (_task: string, cursor: number, event: any, status: any) => {
      watches++; assert.equal(cursor, 3); eventCallback = event; status(true); connected();
      return () => { stops++; };
    },
  };
  const stop = subscribeTask(transport, "fixture", { snapshot() {}, history: events => histories.push(events), event: event => seen.push(event), status: value => states.push(value), error: message => errors.push(message) }, 5);
  try {
    await ready;
    assert.equal(historyCalls, 2); assert.equal(watches, 1); assert.equal(errors.at(-1), ""); assert.equal(states.at(-1), true);
    eventCallback({ taskSeq: 4, kind: "session.event", payload: { seq: 1 } }); assert.equal(seen.length, 1);
    stop(); eventCallback({ taskSeq: 5 }); assert.equal(seen.length, 1); assert.equal(stops, 1);
  } finally { stop(); }
});
