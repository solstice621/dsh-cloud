import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Executor } from "../apps/executor/executor.ts";
import { Journal } from "../apps/executor/journal.ts";
import { id, type ExecutorConfig, type Run } from "../packages/contracts/index.ts";
import { processRun } from "../packages/contracts/process.ts";
import { fixture, template } from "./helpers.ts";
import { deferred, settle } from "./test-utils.ts";

async function executorFixture(t: TestContext, withGit = false) {
  const f = await fixture();
  const { taskId } = (await f.create()).data, lease = await f.start(taskId);
  const run: Run = (await f.request("/v1/executor/commands", undefined, lease.token)).data.current.run;
  const config: ExecutorConfig = { ...lease, controlUrl: f.service.config.publicUrl,
    template: structuredClone(template), workspace: resolve(f.root, "workspace"),
    stateDir: resolve(f.root, "state"), dshHome: resolve(f.root, "home"),
    model: "fixture", modelBaseUrl: "http://127.0.0.1:1", patchPath: resolve(f.root, "runtime.yml") };
  await mkdir(config.workspace); await mkdir(config.dshHome);
  const executor = new Executor(config), runtime = executor as any;
  t.after(async () => { await executor.close(); await f.close(); });
  runtime.run = run;
  const messageId = id();
  const events = [
    { seq: 0, type: "agent/inbox/spliced", data: { inserted: [{ id: messageId }] } },
    { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "Work complete" }] } } },
    { seq: 2, type: "turn/end", data: { reason: { kind: "completed" } } },
  ];
  const prompt = t.mock.fn(async () => {
    assert.equal(executor.journal.get("SELECT phase FROM commands WHERE id=?", run.commandId).phase, "dispatching");
    return messageId;
  });
  const close = t.mock.fn(async () => {});
  runtime.harness = { client: { prompt, request: async () => ({}) }, close };
  t.mock.method(runtime, "readCheckpoint", async (after: number) => ({
    exists: true, events: events.filter(e => e.seq > after), durableSeq: events.at(-1)?.seq ?? -1,
  }));
  if (withGit) {
    const git = (args: string[]) => processRun("git", ["-C", config.workspace, ...args], {
      env: { PATH: process.env.PATH, HOME: config.dshHome, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    });
    await git(["init", "-b", "main"]);
    await writeFile(resolve(config.workspace, "note.txt"), "initial\n");
    await git(["add", "."]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "initial"]);
    config.task.baseCommit = (await git(["rev-parse", "HEAD"])).stdout.trim();
  }
  return { ...f, executor, runtime, config, run, events, prompt, close, messageId };
}

test("Executor persists results and checks before marking a command complete; delivery can retry", async t => {
  const f = await executorFixture(t, true);
  f.config.template.checks = [{ name: "good", command: "test -s note.txt", required: true }, { name: "bad", command: "printf failure >&2; exit 7", required: true }];
  await writeFile(resolve(f.config.workspace, "note.txt"), "changed\n");
  await f.runtime.execute(f.run);
  const command = f.executor.journal.get("SELECT * FROM commands WHERE id=?", f.run.commandId);
  assert.equal(command.phase, "complete");
  assert.equal(command.messageId, f.messageId);
  const saved = JSON.parse(await readFile(resolve(f.config.stateDir, "results", `${f.run.id}.json`), "utf8"));
  assert.equal(saved.status.result.finalResponse, "Work complete");
  assert.deepEqual(saved.status.result.checks.map((c: any) => [c.state, c.exitCode]), [["passed", 0], ["failed", 7]]);
  assert.match(saved.artifact.body.diff, /changed/);
  assert.equal(saved.status.state, "succeeded", "check failures gate publication separately from turn completion");
  const original = f.runtime.call.bind(f.executor);
  let lost = false;
  t.mock.method(f.runtime, "call", async (path: string, body?: any) => {
    const result = await original(path, body);
    if (path.endsWith("/artifacts") && !lost) { lost = true; throw new Error("artifact response lost"); }
    return result;
  });
  await assert.rejects(f.runtime.sync(), /artifact response lost/);
  assert.equal(f.executor.journal.get("SELECT phase FROM commands WHERE id=?", f.run.commandId).phase, "complete");
  await f.runtime.sync();
  assert.equal(f.executor.journal.all("SELECT * FROM outbox").length, 0);
  assert.equal(f.service.store.one<any>("SELECT state FROM runs WHERE id=?", f.run.id).state, "succeeded");
  assert.equal(f.service.store.one<any>("SELECT COUNT(*) AS n FROM artifacts").n, 1);
  assert.equal(f.prompt.mock.callCount(), 1);
});

test("lost prompt acknowledgement remains uncertain and closes the runtime without retrying input", async t => {
  const f = await executorFixture(t);
  f.prompt.mock.mockImplementation(async () => { throw new Error("prompt response lost"); });
  await assert.rejects(f.runtime.execute(f.run), /prompt response lost/);
  const command = f.executor.journal.get("SELECT * FROM commands WHERE id=?", f.run.commandId);
  assert.equal(command.phase, "dispatching");
  assert.equal(command.messageId, null);
  const failure = f.executor.journal.get("SELECT body FROM outbox WHERE key=?", `failure:${f.run.commandId}`);
  assert.equal(JSON.parse(failure.body).state, "uncertain");
  assert.equal(f.prompt.mock.callCount(), 1);
  assert.equal(f.close.mock.callCount(), 1);
  assert.equal(f.executor.stopSignal.signal.aborted, true);
});

for (const missing of ["receipt", "turn-end"] as const) test(`idle runtime with missing ${missing} cannot complete a Run`, async t => {
  const f = await executorFixture(t);
  if (missing === "receipt") f.events[0]!.data = { inserted: [{ id: "different-message" }] } as any;
  else f.events.pop();
  await assert.rejects(f.runtime.execute(f.run), (e: any) => e.code === (missing === "receipt" ? "RECEIPT_MISSING" : "TURN_END_MISSING"));
  const failure = f.executor.journal.get("SELECT body FROM outbox WHERE key=?", `failure:${f.run.commandId}`);
  assert.equal(JSON.parse(failure.body).state, "interrupted");
  assert.equal(f.executor.journal.get("SELECT phase FROM commands WHERE id=?", f.run.commandId).phase, "accepted");
  assert.equal(f.executor.journal.all("SELECT * FROM outbox WHERE path='/v1/executor/artifacts'").length, 0);
});

test("non-completed native turn persists a failed result even when the workspace is valid", async t => {
  const f = await executorFixture(t, true);
  f.events[2]!.data = { reason: { kind: "error" } } as any;
  await f.runtime.execute(f.run);
  const complete = f.executor.journal.get("SELECT body FROM outbox WHERE key=?", `complete:${f.run.commandId}`);
  assert.equal(JSON.parse(complete.body).state, "failed");
  assert.equal(f.executor.journal.get("SELECT phase FROM commands WHERE id=?", f.run.commandId).phase, "complete");
});

test("local result write failure never marks a command complete or advertises an artifact", async t => {
  const f = await executorFixture(t, true);
  await writeFile(resolve(f.config.stateDir, "results"), "not a directory");
  await assert.rejects(f.runtime.execute(f.run), (e: any) => ["EEXIST", "ENOTDIR"].includes(e.code));
  assert.equal(f.executor.journal.get("SELECT phase FROM commands WHERE id=?", f.run.commandId).phase, "accepted");
  assert.equal(f.executor.journal.all("SELECT * FROM outbox WHERE path='/v1/executor/artifacts'").length, 0);
});

test("completed setup steps are durable across journal reopen while start commands run again", async t => {
  const f = await executorFixture(t);
  f.config.template.setup = ["printf setup >> setup.txt", "printf second >> setup.txt"];
  f.config.template.start = ["printf start >> start.txt"];
  await f.runtime.prepareEnvironment();
  f.executor.journal.close();
  f.runtime.journal = new Journal(resolve(f.config.stateDir, "journal.sqlite"));
  await f.runtime.prepareEnvironment();
  assert.equal(await readFile(resolve(f.config.workspace, "setup.txt"), "utf8"), "setupsecond");
  assert.equal(await readFile(resolve(f.config.workspace, "start.txt"), "utf8"), "startstart");
  assert.equal(f.executor.journal.value("setupStep", 0), 2);
});

test("failed setup retains the barrier across reopen and cannot silently repeat side effects", async t => {
  const f = await executorFixture(t);
  f.config.template.setup = ["printf started >> side-effect.txt; exit 7"];
  await assert.rejects(f.runtime.prepareEnvironment(), (e: any) => e.code === "PROCESS_FAILED");
  f.executor.journal.close();
  f.runtime.journal = new Journal(resolve(f.config.stateDir, "journal.sqlite"));
  await assert.rejects(f.runtime.prepareEnvironment(), (e: any) => e.code === "SETUP_UNCERTAIN");
  assert.equal(await readFile(resolve(f.config.workspace, "side-effect.txt"), "utf8"), "started");
  assert.equal(f.executor.journal.value("setupStep", 0), 0);
});

test("native history is uploaded in bounded batches before final status, including lost acknowledgements", async t => {
  const f = await executorFixture(t);
  f.events.length = 0;
  f.executor.journal.saveEvents(Array.from({ length: 205 }, (_, seq) => ({ seq, type: "fixture", data: { seq } })), f.run.id);
  f.executor.journal.queue("/v1/executor/status", { runId: f.run.id, state: "succeeded", result: { durableSeq: 204, workspaceRevision: "fixture-tree" } });
  const original = f.runtime.call.bind(f.executor), sent: number[] = [];
  let lose = true;
  t.mock.method(f.runtime, "call", async (path: string, body?: any) => {
    if (path.endsWith("/events")) sent.push(body.events.length);
    else assert.equal(f.service.store.task(f.run.taskId).durableSeq, 204);
    const result = await original(path, body);
    if (path.endsWith("/events") && lose) { lose = false; throw new Error("event ack lost"); }
    return result;
  });
  await assert.rejects(f.runtime.sync(), /event ack lost/);
  assert.equal(f.executor.journal.value("ackedSeq", -1), -1);
  await f.runtime.sync();
  assert.deepEqual(sent, [100, 100, 100, 5]);
  assert.equal(f.executor.journal.value("ackedSeq", -1), 204);
  assert.equal(f.service.store.all("SELECT * FROM native_events").length, 205);
});

test("concurrent sync callers share collection and network delivery", async t => {
  const f = await executorFixture(t), gate = deferred<any>();
  const checkpoint = t.mock.method(f.runtime, "readCheckpoint", () => gate.promise);
  const first = f.runtime.sync(), second = f.runtime.sync();
  assert.equal(first, second);
  gate.resolve({ events: [], durableSeq: -1 });
  await Promise.all([first, second]);
  assert.equal(checkpoint.mock.callCount(), 1);
});

test("cancelling an interaction expires it exactly once and releases its waiter", async t => {
  const f = await executorFixture(t), abort = new AbortController(), registered = deferred<void>();
  const original = f.runtime.call.bind(f.executor);
  t.mock.method(f.runtime, "call", async (path: string, body?: any) => {
    const result = await original(path, body); registered.resolve(); return result;
  });
  const answer = f.runtime.interact("question", "native-question", { text: "continue?" }, abort.signal);
  const rejection = assert.rejects(answer, /interaction cancelled/);
  await registered.promise; await settle();
  abort.abort(); abort.abort();
  await rejection;
  assert.equal(f.runtime.pending.size, 0);
  const expired = f.executor.journal.all("SELECT * FROM outbox WHERE path LIKE '%/expired'");
  assert.equal(expired.length, 1);
  await f.runtime.sync();
  assert.equal(f.service.store.one<any>("SELECT state FROM interactions").state, "expired");
});

test("stop rejects pending input, captures its last native events, and closes the SDK once", async t => {
  const f = await executorFixture(t);
  const rejected = t.mock.fn((_e: Error) => {});
  f.runtime.pending.set("pending", { resolve() {}, reject: rejected });
  await f.executor.stop("test-stop"); await f.executor.stop("duplicate-stop");
  assert.equal(rejected.mock.callCount(), 1);
  assert.equal(f.close.mock.callCount(), 1);
  assert.equal(f.executor.journal.all("SELECT * FROM native").length, 3);
  const exit = JSON.parse(await readFile(resolve(f.config.stateDir, "exit.json"), "utf8"));
  assert.equal(exit.reason, "test-stop");
  assert.equal(exit.runId, f.run.id);
});

for (const phase of ["complete", "dispatching"] as const) test(`reoffered ${phase} command is never prompted again`, async t => {
  const f = await executorFixture(t);
  f.events.length = 0;
  f.executor.journal.run("INSERT INTO commands VALUES (?,?,?,NULL,NULL)", f.run.commandId, f.run.id, phase);
  const original = f.runtime.call.bind(f.executor);
  t.mock.method(f.runtime, "call", async (path: string, body?: any) => {
    const result = await original(path, body);
    if (path.endsWith("/commands")) f.executor.stopSignal.abort();
    return result;
  });
  await f.executor.loop();
  assert.equal(f.prompt.mock.callCount(), 0);
  if (phase === "dispatching") assert.equal(f.service.store.one<any>("SELECT state FROM runs WHERE id=?", f.run.id).state, "uncertain");
});
