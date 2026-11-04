import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Journal } from "../apps/executor/journal.ts";
import { durableWrite } from "../packages/contracts/storage.ts";
import { boundResultPayload } from "../packages/contracts/results.ts";
import { id, digest } from "../packages/contracts/index.ts";
import { temporaryDirectory } from "./test-utils.ts";

test("a reopened journal retains the exact command, consumed answer, history and per-message restore generation", async t => {
  const root = await temporaryDirectory(t, "durability"), file = resolve(root, "journal.sqlite");
  const command = id(), runId = id(), incarnation = id(), answerId = id(), restoreId = id();
  let journal = new Journal(file);
  journal.run("INSERT INTO commands VALUES (?,?,?,?,?)", command, runId, "accepted", "message-1", null);
  journal.receiveAnswer({ id: answerId, runId, incarnation, answer: { selected: ["保留😀"] } });
  journal.run("UPDATE answers SET consumed=1 WHERE id=?", answerId);
  journal.saveEvents([{ seq: 0, type: "session/init", data: { id: id() } }], runId);
  journal.queue("/old", { runId }, "old");
  journal.set("restoreId", restoreId);
  journal.queue("/new", { runId }, "new");
  journal.close(); journal = new Journal(file);
  try {
    assert.equal(journal.get("SELECT * FROM commands").messageId, "message-1");
    assert.equal(journal.get("SELECT * FROM commands").phase, "accepted");
    assert.equal(journal.get("SELECT * FROM answers").consumed, 1);
    assert.deepEqual(JSON.parse(journal.get("SELECT * FROM answers").answer), { selected: ["保留😀"] });
    assert.deepEqual(journal.all("SELECT restoreId FROM outbox ORDER BY id").map(v => v.restoreId), [null, restoreId]);
    assert.equal(journal.get("SELECT * FROM native").runId, runId);
    assert.equal(journal.value("restoreId", null), restoreId);
  } finally { journal.close(); }
});

test("legacy outbox migration is repeatable and preserves pending payloads", async t => {
  const file = resolve(await temporaryDirectory(t, "legacy-journal"), "journal.sqlite");
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE outbox(id INTEGER PRIMARY KEY AUTOINCREMENT,path TEXT NOT NULL,body TEXT NOT NULL,key TEXT UNIQUE)");
  old.prepare("INSERT INTO outbox(path,body,key) VALUES (?,?,?)").run("/v1/executor/status", '{"runId":"legacy"}', "receipt");
  old.close();
  for (let i = 0; i < 2; i++) {
    const journal = new Journal(file);
    try {
      assert.equal(journal.get("SELECT * FROM outbox").body, '{"runId":"legacy"}');
      assert.equal(journal.get("SELECT * FROM outbox").restoreId, null);
      assert.equal(journal.all<any>("PRAGMA table_info(outbox)").filter(c => c.name === "restoreId").length, 1);
    } finally { journal.close(); }
  }
});

test("a conflicting native batch rolls back its entire prefix and exact replays stay idempotent", async t => {
  const journal = new Journal(resolve(await temporaryDirectory(t, "history-atomic"), "journal.sqlite"));
  t.after(() => journal.close());
  const event = { seq: 0, type: "user/message", data: { content: "original" } };
  journal.saveEvents([event], "run"); journal.saveEvents([event], "run");
  assert.equal(journal.all("SELECT * FROM native").length, 1);
  assert.throws(() => journal.saveEvents([{ seq: 1, type: "assistant/message" }, { ...event, data: { content: "changed" } }], "run"), { code: "LOCAL_HISTORY_CONFLICT" });
  assert.deepEqual(journal.all("SELECT event FROM native").map(v => JSON.parse(v.event)), [event]);
});

test("durable answers reject changed content, run identity and incarnation without replacing the first answer", async t => {
  const journal = new Journal(resolve(await temporaryDirectory(t, "answer-conflict"), "journal.sqlite"));
  t.after(() => journal.close());
  const answer = { id: id(), runId: id(), incarnation: id(), answer: { outcome: "allowed-once" } };
  journal.receiveAnswer(answer); journal.receiveAnswer(answer);
  for (const change of [{ runId: id() }, { incarnation: id() }, { answer: { outcome: "denied" } }])
    assert.throws(() => journal.receiveAnswer({ ...answer, ...change }), { code: "ANSWER_CONFLICT" });
  assert.equal(journal.all("SELECT * FROM answers").length, 1);
  assert.deepEqual(JSON.parse(journal.get("SELECT * FROM answers").answer), answer.answer);
});

test("transaction failure cannot persist half a command or remove an unrecorded rejected message", async t => {
  const journal = new Journal(resolve(await temporaryDirectory(t, "journal-rollback"), "journal.sqlite"));
  t.after(() => journal.close());
  assert.throws(() => journal.tx(() => { journal.set("command", "accepted"); journal.queue("/status", { done: true }); throw new Error("crash boundary"); }), /crash boundary/);
  assert.equal(journal.value("command", null), null);
  assert.equal(journal.all("SELECT * FROM outbox").length, 0);
  journal.queue("/status", { original: "evidence" }, "unique");
  journal.queue("/status", { original: "evidence" }, "unique");
  const row = journal.get("SELECT * FROM outbox");
  journal.db.exec("CREATE TRIGGER reject_write BEFORE INSERT ON rejected_outbox BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END");
  assert.throws(() => journal.rejectOutbox(row, "BODY_TOO_LARGE"), /injected storage failure/);
  assert.equal(journal.all("SELECT * FROM outbox").length, 1);
  assert.equal(journal.all("SELECT * FROM rejected_outbox").length, 0);
  journal.db.exec("DROP TRIGGER reject_write");
  journal.rejectOutbox(row, "BODY_TOO_LARGE");
  assert.equal(journal.all("SELECT * FROM outbox").length, 0);
  assert.equal(journal.get("SELECT * FROM rejected_outbox").body, row.body);
});

test("concurrent immutable writes preserve one complete artifact and clean temporary files on conflict", async t => {
  const root = await temporaryDirectory(t, "immutable-artifact"), path = resolve(root, "artifact.json");
  const content = JSON.stringify({ text: "persistent😀".repeat(5000) });
  await Promise.all(Array.from({ length: 8 }, () => durableWrite(path, content, true)));
  await assert.rejects(durableWrite(path, "different", true), { code: "ARTIFACT_CONFLICT" });
  assert.equal(await readFile(path, "utf8"), content);
  assert.deepEqual(await readdir(root), ["artifact.json"]);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await durableWrite(path, "updated");
  assert.equal(await readFile(path, "utf8"), "updated");
});

test("result truncation preserves identifiers and metadata, hashes original text and never mutates the full local result", () => {
  const source = { runId: id(), state: "succeeded", result: { finalResponse: '结果😀\n"'.repeat(4000), workspaceRevision: "tree", durableSeq: 42, checks: [{ name: "test", state: "failed", exitCode: 1, stdout: "x".repeat(2000), stderr: "failure" }] } };
  const full = structuredClone(source), bounded = boundResultPayload(source, "results/original.json", 4096);
  assert.deepEqual(source, full);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 4096);
  assert.equal(bounded.runId, source.runId);
  assert.equal(bounded.result.durableSeq, 42);
  assert.equal(bounded.result.workspaceRevision, "tree");
  assert.equal(bounded.result.checks[0]!.state, "failed");
  assert.equal(bounded.result.checks[0]!.exitCode, 1);
  const fields = (bounded.result as any).truncation.fields;
  const text = fields.find((v: any) => v.path === "finalResponse");
  assert.equal(text.sha256, digest(source.result.finalResponse));
  assert.equal(text.originalBytes, Buffer.byteLength(source.result.finalResponse));
  assert.equal(text.retainedBytes, Buffer.byteLength(bounded.result.finalResponse));
  assert.equal(Buffer.from(bounded.result.finalResponse, "utf8").toString("utf8"), bounded.result.finalResponse);
});

test("a result exactly at its byte budget is unchanged and oversized essential metadata is rejected", () => {
  const value = { result: { finalResponse: "中文😀", durableSeq: 1 } };
  const size = Buffer.byteLength(JSON.stringify(value));
  assert.deepEqual(boundResultPayload(value, "full.json", size), value);
  assert.throws(() => boundResultPayload({ result: { essential: "x".repeat(5000) } }, "full.json", 1024), { code: "RESULT_METADATA_TOO_LARGE" });
});
