import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { NativeCloudSessions } from "../packages/dsh-cloud-plugin/native.ts";
import { fixture } from "./helpers.ts";
import { id } from "../packages/contracts/index.ts";

test("native adapter preserves one remote identity, retries prompt once and never activates a local Agent", async () => {
  const f = await fixture(); let localCalls = 0, offline = false;
  const local = () => { localCalls++; return { local: true }; };
  // rc.5 deliberately has no events/state aliases: mounting must remain compatible.
  const controller: any = { list: async () => ({ items: [] }), create: local, prompt: local, resolveAgent: local, cancel: local, page: local, projections: local, follow: async function* () {}, control: async function* () {} };
  const ctx: any = { sessionController: controller, emit() {}, typertGateway: { hasLiveClient: () => false }, sessionProjections: { restore: (_c: any, events: any[]) => ({ snapshot: { asOfSeq: events.length - 1, values: {} } }) } };
  const request: any = async (path: string, body?: any, key?: string) => {
    if (offline) throw new Error("cloud offline");
    const r = await f.request(path, body, f.owner, key);
    if (r.status >= 400) throw new Error(JSON.stringify(r.data));
    return r.data;
  };
  const native = new NativeCloudSessions(ctx, request, resolve(f.root, "native.json"));
  const dispose = native.mount();
  try {
    const draft: any = await native.invoke("draft", { runnerId: f.runner.runnerId, templateId: "test", templateVersion: "1", repo: "https://github.com/example/project.git", ref: "main", baseBranch: "main", deliveryPolicy: "results" });
    const prompt = { sessionId: draft.sessionId, requestId: id(), mode: "queue", content: [{ type: "text", text: "Native prompt" }] };
    assert.deepEqual(await controller.prompt(prompt), { accepted: true });
    assert.deepEqual(await controller.prompt(prompt), { accepted: true });
    const task = f.service.store.one<any>("SELECT * FROM tasks WHERE sessionId=?", draft.sessionId)!;
    assert.equal(f.service.store.one<any>("SELECT COUNT(*) AS n FROM runs WHERE taskId=?", task.id)!.n, 1);
    assert.equal(localCalls, 0);
    const run = f.service.store.snapshot(task.id, "owner").runs[0];
    const messageId = id();
    f.service.store.exec("UPDATE runs SET messageId=? WHERE id=?", messageId, run.id);
    const nativeEvent = { seq: 0, time: Date.now(), type: "user/message", surfaceOp: "append", data: { id: messageId, role: "user", source: { kind: "user" }, content: [{ type: "text", text: "Native prompt" }] } };
    f.service.store.exec("INSERT INTO native_events VALUES (?,?,?,?)", task.id, 0, "fixture", JSON.stringify(nativeEvent));
    f.service.store.exec("UPDATE tasks SET durableSeq=0 WHERE id=?", task.id);
    await native.invoke("detail", { sessionId: draft.sessionId });
    const page = await controller.page({ address: { kind: "session", sessionId: draft.sessionId } });
    assert.equal(page.records[0].event.data.source.rpcId, prompt.requestId);
    assert.deepEqual(JSON.parse(f.service.store.one<any>("SELECT payload FROM native_events WHERE taskId=?", task.id)!.payload), nativeEvent, "browser correlation must not modify native storage");
    await assert.rejects(controller.resolveAgent(draft.sessionId), /不适用于云端/);
    offline = true;
    await assert.rejects(controller.resolveAgent(draft.sessionId), /offline|不适用于云端/);
    assert.equal(localCalls, 0);
    await controller.prompt({ sessionId: id(), content: [] });
    assert.equal(localCalls, 1, "unrelated local sessions keep the original route");
  } finally { dispose(); await f.close(); }
});

test("control saves the exact native header and rejects a changed session identity", async () => {
  const f = await fixture();
  try {
    const c = await f.create(), e = await f.start(c.data.taskId);
    const task = f.service.store.task(c.data.taskId);
    const header = { version: 4, id: task.sessionId, createdAt: 123456, cwd: "/workspace", isSeeded: false, delegationDepth: 0 };
    assert.equal((await f.request("/v1/executor/events", { events: [], runId: null, header }, e.token)).status, 200);
    assert.deepEqual((await f.request(`/v1/tasks/${task.id}/history`)).data.header, header);
    assert.equal((await f.request("/v1/executor/events", { events: [], runId: null, header: { ...header, id: id() } }, e.token)).data.error.code, "SESSION_MISMATCH");
    assert.equal((await f.request("/v1/executor/events", { events: [], runId: null, header: { ...header, createdAt: 123457 } }, e.token)).data.error.code, "HEADER_CONFLICT");
  } finally { await f.close(); }
});

test("native file adapter confines cloud paths and leaves local file operations intact", async () => {
  const f = await fixture(); let localReads = 0;
  const files: any = Object.fromEntries(["read", "readBytes", "stat", "list"].map(key => [key, async () => { localReads++; return { local: key }; }]));
  let configured: any;
  const ctx: any = {
    sessionController: {}, emit() {},
    get: (name: string) => name === "workspaceFiles" ? files : undefined,
    typert: { lookups: { get: () => ({ resolve: async (sessionId: string) => ({ sessionId, workspaceRoot: "/local" }) }), configure: (_: string, resolver: any) => { configured = resolver; return () => {}; } } },
    typertGateway: { hasLiveClient: () => false },
    sessionProjections: { restore: () => ({ snapshot: { values: {} } }) },
  };
  const native = new NativeCloudSessions(ctx, async (path, body, key) => { const r = await f.request(path, body, f.owner, key); if (r.status >= 400) throw new Error(r.data.error.message); return r.data; }, resolve(f.root, "files-native.json"));
  const dispose = native.mount();
  try {
    const task = await f.create(); await native.status();
    const sessionId = f.service.store.task(task.data.taskId).sessionId;
    const scope = await configured(sessionId);
    const paths: string[] = [];
    native.inspect = async (_id, _action, path) => { paths.push(path ?? ""); return path === undefined ? { files: [{ path: "folder/note.md", size: 8, symlink: false }], truncated: false } : { content: "one\ntwo\n", encoding: "utf8", hash: "saved-file", size: 8 }; };
    assert.equal(scope.workspaceRoot, "/workspace");
    assert.deepEqual(await files.list(scope, "", undefined), { path: "", entries: [{ name: "folder", type: "directory" }], truncated: false });
    const value = await files.read(scope, "/workspace/folder/note.md", { offset: 2, limit: 1 });
    assert.equal(value.text, "two"); assert.equal(value.eof, true); assert.equal(value.absolutePath, "/workspace/folder/note.md");
    assert.equal(Buffer.from((await files.readBytes(scope, "note.md", { baseFile: "/workspace/folder/entry.md", range: { offset: 0, length: 3 } })).data).toString(), "one");
    const before = paths.length;
    await assert.rejects(files.read(scope, "../../etc/passwd", {}), /escapes/);
    assert.equal(paths.length, before, "escaped paths must not reach the Runner");
    assert.equal(localReads, 0, "cloud files never touch the Host file provider");
    assert.deepEqual(await files.stat(await configured(id()), "/local/readme"), { local: "stat" });
    assert.equal(localReads, 1);
  } finally { dispose(); await f.close(); }
});

test("native rename, pin and archive stay in cloud metadata without creating a local Session", async () => {
  const f = await fixture(); const local = { archivedSessionIds: [id()], pinnedSessionIds: [id()] };
  const workspace: any = Object.fromEntries(["archiveSession", "unarchiveSession", "pinSession", "unpinSession"].map(key => [key, async () => { throw new Error("must not route to local workspace mutation"); }]));
  const ctx: any = { sessionController: { rename() {} }, emit() {}, get: (name: string) => name === "workspaceController" ? workspace : name === "workspaceRegistry" ? local : undefined, typertGateway: { hasLiveClient: () => false }, sessionProjections: { restore: () => ({ snapshot: { values: {} } }) } };
  const native = new NativeCloudSessions(ctx, async (path, body, key) => { const r = await f.request(path, body, f.owner, key); if (r.status >= 400) throw new Error(r.data.error.message); return r.data; }, resolve(f.root, "workspace-native.json"));
  const dispose = native.mount();
  try {
    const c = await f.create(), sessionId = f.service.store.task(c.data.taskId).sessionId; await native.status();
    assert.deepEqual(await ctx.sessionController.rename({ sessionId, title: "Cloud title" }), { title: "Cloud title" });
    assert.equal(f.service.store.task(c.data.taskId).title, "Cloud title");
    assert.deepEqual((await workspace.pinSession({ sessionId })).pinnedSessionIds, [sessionId, ...local.pinnedSessionIds]);
    assert.deepEqual((await workspace.archiveSession({ sessionId })).archivedSessionIds, [...local.archivedSessionIds, sessionId]);
    assert.equal(f.service.store.task(c.data.taskId).lifecycle, "archived");
    assert.deepEqual((await workspace.unarchiveSession({ sessionId })).archivedSessionIds, local.archivedSessionIds);
    assert.equal(f.service.store.task(c.data.taskId).lifecycle, "open");
  } finally { dispose(); await f.close(); }
});

test("stored early templates receive conservative defaults when dispatched", async () => {
  const f = await fixture();
  try {
    const row = f.service.store.one<any>("SELECT body FROM templates WHERE id='test'")!;
    const early = JSON.parse(row.body); delete early.minFreeDiskMb;
    f.service.store.exec("UPDATE templates SET body=? WHERE id='test'", JSON.stringify(early));
    assert.equal(f.service.store.template("test", "1").minFreeDiskMb, 2048);
  } finally { await f.close(); }
});

test("native history subscription survives a control outage and publishes idle without a control subscriber", async () => {
  const f = await fixture(); let offline = false; const notices: any[] = [];
  const ctx: any = { sessionController: {}, emit: (...args: any[]) => notices.push(args), typertGateway: { hasLiveClient: () => false }, sessionProjections: { restore: () => ({ snapshot: { values: {} } }) } };
  const native = new NativeCloudSessions(ctx, async (path, body, key) => { if (offline) throw new Error("temporary control outage"); const r = await f.request(path, body, f.owner, key); if (r.status >= 400) throw new Error(r.data.error.message); return r.data; }, resolve(f.root, "outage-native.json"));
  const dispose = native.mount(), abort = new AbortController();
  try {
    const c = await f.create(), task = f.service.store.task(c.data.taskId);
    const event = (seq: number) => ({ seq, time: Date.now(), type: "session/title", data: { title: "Cloud " + seq } });
    const add = (seq: number) => { const e = event(seq); f.service.store.exec("INSERT INTO native_events VALUES (?,?,?,?)", task.id, seq, "fixture", JSON.stringify(e)); f.service.store.exec("UPDATE tasks SET durableSeq=? WHERE id=?", seq, task.id); return e; };
    add(0); const stream = native.follow({ address: { sessionId: task.sessionId } }, abort.signal);
    assert.equal((await stream.next()).value?.type, "snapshot");
    offline = true; const pending = stream.next();
    await new Promise(resolve => setTimeout(resolve, 850));
    const second = add(1); offline = false;
    const next: any = await Promise.race([pending, new Promise((_, reject) => setTimeout(() => reject(new Error("subscription did not recover")), 4000))]);
    assert.deepEqual(next.value, { type: "event", event: second });
    assert.ok(notices.some(v => v[0] === "api-session/status" && v[1] === task.sessionId && v[2] === false));
    assert.equal(f.service.store.one<any>("SELECT COUNT(*) AS n FROM runs WHERE taskId=?", task.id)!.n, 1);
    abort.abort(); await stream.return(undefined);
  } finally { abort.abort(); dispose(); await f.close(); }
});
