import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once, getEventListeners } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { api, retryAfter } from "../packages/contracts/http.ts";
import { processRun } from "../packages/contracts/process.ts";
import { pollingWatch } from "../packages/task-ui/transport.ts";
import { deferred, settle, temporaryDirectory } from "./test-utils.ts";

async function httpFixture(t: TestContext, handler: Parameters<typeof createServer>[1]) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

test("API redirects cannot forward bearer credentials to another endpoint", async t => {
  let destinationCalls = 0;
  const destination = await httpFixture(t, (_req, res) => { destinationCalls++; res.end("{}"); });
  const source = await httpFixture(t, (_req, res) => { res.writeHead(307, { location: destination + "/collect" }); res.end(); });
  await assert.rejects(api(source, "/start", "fixture-secret", {}));
  assert.equal(destinationCalls, 0);
});

test("API errors retain retry hints even when a gateway sends a non-JSON body", async t => {
  const url = await httpFixture(t, (_req, res) => { res.writeHead(503, { "retry-after": "2.5" }); res.end("upstream unavailable"); });
  await assert.rejects(api(url, "/work", "fixture"), (e: any) => e.status === 503 && e.code === "HTTP_ERROR" && e.retryAfterMs === 2500);
});

test("API success requires valid JSON and honours cancellation of a stalled response", async t => {
  const received = deferred<void>();
  const url = await httpFixture(t, (req, res) => {
    if (req.url === "/invalid") res.end("not JSON");
    else received.resolve();
  });
  await assert.rejects(api(url, "/invalid", "fixture"), SyntaxError);
  const abort = new AbortController();
  const stalled = api(url, "/stalled", "fixture", undefined, { signal: abort.signal });
  const rejected = assert.rejects(stalled, (e: any) => e.name === "AbortError");
  await received.promise; abort.abort(); await rejected;
});

test("Retry-After supports seconds, dates, expired values and invalid input", t => {
  t.mock.method(Date, "now", () => Date.UTC(2026, 0, 1));
  assert.equal(retryAfter("1.25"), 1250);
  assert.equal(retryAfter("Thu, 01 Jan 2026 00:00:04 GMT"), 4000);
  assert.equal(retryAfter("Wed, 31 Dec 2025 23:00:00 GMT"), 0);
  assert.equal(retryAfter("invalid"), undefined);
  assert.equal(retryAfter(null), undefined);
});

test("polling delivers only contiguous unseen events and retries from its last safe cursor", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const paths: string[] = [], events: number[] = [], status: boolean[] = [];
  const replies = [[1, 1, 2], [4], [3, 4]];
  const stop = pollingWatch(async path => {
    paths.push(path);
    return { events: (replies.shift() ?? []).map(taskSeq => ({ taskSeq })) };
  })("task", 0, e => events.push(e.taskSeq), s => status.push(s));
  t.after(stop);
  await settle(); t.mock.timers.tick(800); await settle();
  assert.deepEqual(events, [1, 2]);
  assert.deepEqual(status, [true, false]);
  t.mock.timers.tick(800); await settle();
  assert.deepEqual(events, [1, 2, 3, 4]);
  assert.deepEqual(paths, ["/v1/tasks/task/events/poll?after=0", "/v1/tasks/task/events/poll?after=2", "/v1/tasks/task/events/poll?after=2"]);
  stop(); t.mock.timers.tick(800); await settle();
  assert.equal(paths.length, 3);
});

for (const outcome of ["resolve", "reject"] as const) test(`polling stop suppresses late ${outcome} callbacks and future requests`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const response = deferred<any>(), statuses: boolean[] = [], events: any[] = [];
  let calls = 0;
  const stop = pollingWatch(async () => { calls++; return response.promise; })("task", 0, e => events.push(e), s => statuses.push(s));
  stop();
  if (outcome === "resolve") response.resolve({ events: [{ taskSeq: 1 }] });
  else response.reject(new Error("request failed after unmount"));
  await settle(); t.mock.timers.tick(10000); await settle();
  assert.deepEqual(statuses, []);
  assert.deepEqual(events, []);
  assert.equal(calls, 1);
});

test("unmount during an event callback stops the rest of the batch and status updates", async () => {
  const events: number[] = [], statuses: boolean[] = [];
  const stop = pollingWatch(async () => ({ events: [{ taskSeq: 1 }, { taskSeq: 2 }] }))(
    "task", 0, e => { events.push(e.taskSeq); stop(); }, status => statuses.push(status));
  await settle();
  assert.deepEqual(events, [1]);
  assert.deepEqual(statuses, []);
});

test("process execution preserves stdin, separate outputs and explicit nonzero exit results", async () => {
  const result = await processRun(process.execPath, ["-e", "process.stdin.on('data', b => process.stdout.write(b)); process.stderr.write('diagnostic'); process.exitCode=7"], { input: "input", allowFailure: true });
  assert.deepEqual(result, { stdout: "input", stderr: "diagnostic", code: 7, timedOut: false });
  await assert.rejects(processRun(process.execPath, ["-e", "process.exit(7)"]), (e: any) => e.code === "PROCESS_FAILED");
});

test("combined process output is bounded even when failure is allowed", async () => {
  await assert.rejects(processRun(process.execPath, ["-e", "process.stdout.write('a'.repeat(700)); process.stderr.write('b'.repeat(700))"],
    { maxBytes: 1000, allowFailure: true }), (e: any) => e.code === "PROCESS_OUTPUT_LIMIT" && e.status === 413);
});

test("process timeout remains observable with allowFailure and escalates past ignored SIGTERM", { timeout: 10000 }, async () => {
  const result = await processRun(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.stdout.write('ready'); setInterval(()=>{},1000)"], { timeout: 1000, allowFailure: true });
  assert.equal(result.stdout, "ready", "SIGTERM handler must be installed before timeout");
  assert.equal(result.timedOut, true);
  assert.notEqual(result.code, 0);
});

test("abort terminates an active process and releases its listeners", { timeout: 10000 }, async t => {
  const root = await temporaryDirectory(t, "abort"), ready = resolve(root, "ready");
  const abort = new AbortController();
  const promise = processRun(process.execPath, ["-e", "require('fs').writeFileSync(process.argv[1],String(process.pid)); setInterval(()=>{},1000)", ready], { signal: abort.signal });
  const rejected = assert.rejects(promise, (e: any) => e.code === "PROCESS_FAILED");
  let pid = 0;
  for (let i = 0; i < 200 && !pid; i++) {
    try { pid = Number(await readFile(ready, "utf8")); } catch { await sleep(10); }
  }
  assert.equal(getEventListeners(abort.signal, "abort").length, 1);
  abort.abort(); await rejected;
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  assert.ok(pid, "child must be running before cancellation");
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
