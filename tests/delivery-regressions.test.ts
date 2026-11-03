import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fixture, template } from "./helpers.ts";
import { api } from "../packages/contracts/http.ts";
import { CloudError, id } from "../packages/contracts/index.ts";
import { replayOutbox } from "../packages/contracts/outbox.ts";
import { Executor } from "../apps/executor/executor.ts";
import { Journal } from "../apps/executor/journal.ts";

for (const kind of ["question", "approval"]) test(`${kind} reaches a live DSH waiter once when the delivered response is lost`, async () => {
  const f = await fixture(); let executor: Executor | undefined;
  try {
    const { taskId, runId } = (await f.create()).data, e = await f.start(taskId);
    const command = (await f.request("/v1/executor/commands", undefined, e.token)).data.current.run;
    const body = kind === "question" ? { questions: [{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }] } : { toolName: "bash", callId: id(), reason: "verify fixture" };
    const interaction = (await f.request("/v1/executor/interactions", { runId, nativeId: id(), kind, body }, e.token)).data;
    const answer = kind === "question" ? { answers: [{ id: "q", selected: ["Yes"] }] } : { outcome: "allowed-once" };
    assert.equal((await f.request(`/v1/interactions/${interaction.id}/answers`, { version: 1, answer })).status, 200);
    executor = new Executor({ ...e, template, controlUrl: f.service.config.publicUrl, stateDir: resolve(f.root, "executor"), workspace: resolve(f.root, "workspace"), dshHome: resolve(f.root, "home") } as any);
    const runtime: any = executor;
    runtime.run = command; runtime.runPromise = new Promise(() => {});
    let delivered = 0, receipts = 0, polls = 0;
    runtime.pending.set(interaction.id, { resolve: (received: unknown) => { assert.deepEqual(received, answer); delivered++; }, reject: assert.fail });
    runtime.call = async (path: string, payload?: any) => {
      if (path.endsWith("/delivered")) assert.equal(delivered, 1, "local consumption must precede the remote receipt");
      const result = await api(f.service.config.publicUrl, path, e.token, payload);
      if (path.endsWith("/delivered") && receipts++ === 0) throw new Error("response lost after server commit");
      if (path.endsWith("/commands") && ++polls === 2) executor!.stopSignal.abort();
      return result;
    };
    await executor.loop();
    assert.equal(delivered, 1); assert.equal(receipts, 2); assert.equal(runtime.pending.size, 0);
    assert.equal(executor.journal.all("SELECT * FROM outbox").length, 0);
    const saved = executor.journal.get<any>("SELECT * FROM answers WHERE id=?", interaction.id);
    assert.equal(saved.consumed, 1); assert.deepEqual(JSON.parse(saved.answer), answer);
    assert.equal(f.service.store.one<any>("SELECT state FROM interactions WHERE id=?", interaction.id).state, "delivered");
    assert.equal(f.service.store.all("SELECT * FROM events WHERE kind='interaction.delivered'").length, 1, "retry must not create another transition");
    const replay = (await f.request("/v1/executor/commands", undefined, e.token)).data.answers;
    assert.equal(replay[0].id, interaction.id, "unresolved delivered answers remain recoverable for older live clients");
    const reader = new Journal(resolve(f.root, "executor/journal.sqlite"));
    assert.equal(reader.get<any>("SELECT * FROM answers WHERE id=?", interaction.id).consumed, 1); reader.close();
  } finally { executor?.stopSignal.abort(); executor?.journal.close(); await f.close(); }
});

test("transient outbox failures retain their payload and permanently rejected output remains inspectable", async () => {
  const f = await fixture(), journal = new Journal(resolve(f.root, "queue.sqlite"));
  try {
    const { taskId, runId } = (await f.create()).data, e = await f.start(taskId);
    await f.request("/v1/executor/commands", undefined, e.token);
    const payload = { runId, state: "succeeded", result: { text: "original evidence" } };
    journal.queue("/v1/executor/status", payload);
    for (const error of [new Error("network down"), new CloudError(429, "RATE_LIMIT", "wait"), new CloudError(503, "UNAVAILABLE", "retry")]) {
      await assert.rejects(replayOutbox(journal, async () => { throw error; }, null));
      assert.equal(journal.all("SELECT * FROM outbox").length, 1);
      assert.equal(journal.all("SELECT * FROM rejected_outbox").length, 0);
    }
    let receipts = 0;
    const send = async (path: string, body: any) => {
      if (path === "/v1/executor/status") throw new CloudError(413, "BODY_TOO_LARGE", "permanent");
      const result = await api(f.service.config.publicUrl, path, e.token, body);
      if (receipts++ === 0) throw new Error("lost reconciliation receipt");
      return result;
    };
    await assert.rejects(replayOutbox(journal, send, null), /lost reconciliation/);
    assert.equal(journal.all("SELECT * FROM outbox").length, 1, "retain evidence until its reconciliation notice is acknowledged");
    await assert.rejects(replayOutbox(journal, send, null), (err: any) => err.code === "DELIVERY_REJECTED");
    assert.equal(journal.all("SELECT * FROM outbox").length, 0);
    assert.deepEqual(JSON.parse(journal.get<any>("SELECT * FROM rejected_outbox").body), payload);
    assert.equal(f.service.store.all("SELECT * FROM events WHERE kind='outbox.reconciliation'").length, 1);
    assert.equal(f.service.store.task(taskId).recoveryRequired, 1);
  } finally { journal.close(); await f.close(); }
});
