import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.ts";
import {
  DSH_VERSION,
  PROTOCOL,
  id,
  digest,
} from "../packages/contracts/index.ts";
import { Store } from "../apps/control/db.ts";

test("idempotent creation and simultaneous inputs preserve one session and strict execution order", async () => {
  const f = await fixture();
  try {
    const key = id(),
      a = await f.create("first", key),
      b = await f.create("first", key),
      conflict = await f.create("different", key);
    assert.equal(a.status, 202);
    assert.deepEqual(a.data, b.data);
    assert.equal(conflict.status, 409);
    const tid = a.data.taskId,
      t = f.service.store.task(tid);
    assert.notEqual(t.sessionId, t.environmentId);
    const [second, third] = await Promise.all([
      f.request(`/v1/tasks/${tid}/inputs`, { input: "second" }),
      f.request(`/v1/tasks/${tid}/inputs`, { input: "third" }),
    ]);
    assert.equal(second.status, 202);
    assert.equal(third.status, 202);
    const lease = await f.start(tid);
    const [one, two] = await Promise.all([
      f.request("/v1/executor/commands", undefined, lease.token),
      f.request("/v1/executor/commands", undefined, lease.token),
    ]);
    assert.equal(one.data.current.run.id, a.data.runId);
    assert.deepEqual(one.data.current, two.data.current);
    assert.deepEqual(
      f.service.store
        .all<any>(
          "SELECT ordinal,state FROM runs WHERE taskId=? ORDER BY ordinal",
          tid,
        )
        .map((r) => [r.ordinal, r.state]),
      [
        [1, "preparing"],
        [2, "queued"],
        [3, "queued"],
      ],
    );
    assert.equal(f.service.store.task(tid).sessionId, t.sessionId);
  } finally {
    await f.close();
  }
});

test("native history is contiguous, conflict checked, replayable and survives database restart", async () => {
  const f = await fixture();
  try {
    const { taskId } = (await f.create()).data,
      e = await f.start(taskId);
    const send = (events: any[]) =>
      f.request("/v1/executor/events", { events, runId: null }, e.token);
    const event = { seq: 0, type: "session/init", data: {} };
    assert.equal((await send([event])).status, 200);
    assert.equal((await send([event])).data.durableSeq, 0);
    assert.equal(
      (await send([{ ...event, seq: 2 }])).data.error.code,
      "EVENT_GAP",
    );
    assert.equal(
      (await send([{ ...event, data: { different: true } }])).data.error.code,
      "EVENT_CONFLICT",
    );
    const store = new Store(f.service.config.database);
    assert.equal(store.task(taskId).durableSeq, 0);
    store.close();
    const snapshot = (await f.request(`/v1/tasks/${taskId}`)).data;
    const abort = new AbortController();
    const stream = await fetch(
      f.service.config.publicUrl +
        `/v1/tasks/${taskId}/events?after=${snapshot.snapshotSeq}`,
      { headers: { authorization: `Bearer ${f.owner}` }, signal: abort.signal },
    );
    const next = stream.body!.getReader().read();
    await send([
      { seq: 1, type: "assistant/message", data: { text: "persisted" } },
    ]);
    const part = await next;
    abort.abort();
    const body = new TextDecoder().decode(part.value);
    assert.match(body, /session.event/);
    assert.match(body, new RegExp(`id: ${snapshot.snapshotSeq + 1}`));
    assert.equal(
      (await f.request(`/v1/tasks/${taskId}/history?after=0`)).data.events[0]
        .seq,
      1,
    );
  } finally {
    await f.close();
  }
});

test("paired identities are scoped; expired/fenced credentials and foreign tasks are rejected", async () => {
  const f = await fixture();
  try {
    const { taskId } = (await f.create()).data,
      e = await f.start(taskId);
    assert.equal(
      (await f.request("/v1/tasks", undefined, f.runner.token)).status,
      403,
    );
    assert.equal(
      (await f.request("/v1/runner/work", undefined, e.token)).status,
      403,
    );
    assert.equal((await f.request(`/v1/tasks/${id()}`)).status, 404);
    f.service.store.exec(
      "UPDATE credentials SET expiresAt=0 WHERE hash=?",
      digest(e.token),
    );
    assert.equal(
      (await f.request("/v1/executor/commands", undefined, e.token)).status,
      401,
    );
    await f.request(
      "/v1/runner/heartbeat",
      {
        protocol: PROTOCOL,
        dshVersion: DSH_VERSION,
        capacity: 1,
        inventory: [
          { taskId, epoch: e.epoch, incarnation: e.incarnation, running: true },
        ],
      },
      f.runner.token,
    );
    assert.equal(
      (await f.request("/v1/executor/commands", undefined, e.token)).status,
      200,
    );
    f.service.store.exec("UPDATE tasks SET epoch=epoch+1 WHERE id=?", taskId);
    assert.equal(
      (await f.request("/v1/executor/commands", undefined, e.token)).data.error
        .code,
      "STALE_EXECUTOR",
    );
  } finally {
    await f.close();
  }
});

test("cancellation remains pending until the supervisor confirms the process tree stopped", async () => {
  const f = await fixture();
  try {
    const { taskId, runId } = (await f.create()).data,
      e = await f.start(taskId);
    await f.request("/v1/executor/commands", undefined, e.token);
    await f.request(`/v1/tasks/${taskId}/inputs`, { input: "queued followup" });
    assert.equal(
      (await f.request(`/v1/runs/${runId}/cancel`, {})).data.state,
      "cancelling",
    );
    assert.equal(
      (
        await f.request(
          "/v1/executor/status",
          {
            runId,
            state: "succeeded",
            result: { durableSeq: -1, workspaceRevision: "tree" },
          },
          e.token,
        )
      ).data.error.code,
      "CANCEL_PENDING",
    );
    assert.equal(
      (
        await f.request(
          `/v1/runner/environments/${taskId}/stopped`,
          {
            epoch: e.epoch,
            incarnation: e.incarnation,
            confirmedStopped: false,
          },
          f.runner.token,
        )
      ).status,
      409,
    );
    await f.request(
      `/v1/runner/environments/${taskId}/stopped`,
      { epoch: e.epoch, incarnation: e.incarnation, confirmedStopped: true },
      f.runner.token,
    );
    assert.equal(
      f.service.store.one<any>("SELECT state FROM runs WHERE id=?", runId)
        .state,
      "cancelled",
    );
    assert.equal(f.service.store.task(taskId).paused, 1);
  } finally {
    await f.close();
  }
});

test("uncertain input pauses the queue and recovery waits for the old environment to stop", async () => {
  const f = await fixture();
  try {
    const { taskId, runId } = (await f.create()).data,
      e = await f.start(taskId);
    await f.request("/v1/executor/commands", undefined, e.token);
    await f.request(
      "/v1/executor/status",
      { runId, state: "uncertain", result: { error: "lost acknowledgment" } },
      e.token,
    );
    const recovery = {
      input: "Inspect first, then continue",
      kind: "recovery",
      previousRunId: runId,
      acknowledgeUncertain: true,
    };
    assert.equal(
      (await f.request(`/v1/tasks/${taskId}/inputs`, recovery)).data.error.code,
      "STOP_UNCONFIRMED",
    );
    await f.request(
      `/v1/runner/environments/${taskId}/stopped`,
      { epoch: e.epoch, incarnation: e.incarnation, confirmedStopped: true },
      f.runner.token,
    );
    assert.equal(
      (
        await f.request(`/v1/tasks/${taskId}/inputs`, {
          ...recovery,
          acknowledgeUncertain: false,
        })
      ).data.error.code,
      "UNCERTAIN_ACK_REQUIRED",
    );
    assert.equal(
      (await f.request(`/v1/tasks/${taskId}/inputs`, recovery)).status,
      202,
    );
  } finally {
    await f.close();
  }
});

test("only one concurrent answer is accepted; restored runtimes reject old questions", async () => {
  const f = await fixture();
  try {
    const { taskId, runId } = (await f.create()).data,
      e = await f.start(taskId);
    await f.request("/v1/executor/commands", undefined, e.token);
    const q = await f.request(
      "/v1/executor/interactions",
      { runId, nativeId: "q1", kind: "approval", body: { tool: "bash" } },
      e.token,
    );
    const answers = await Promise.all([
      f.request(`/v1/interactions/${q.data.id}/answers`, {
        version: 1,
        answer: { outcome: "allowed-once" },
      }),
      f.request(`/v1/interactions/${q.data.id}/answers`, {
        version: 1,
        answer: { outcome: "rejected" },
      }),
    ]);
    assert.deepEqual(answers.map((a) => a.status).sort(), [200, 409]);
    f.service.store.exec(
      "UPDATE tasks SET incarnation=? WHERE id=?",
      id(),
      taskId,
    );
    assert.equal(
      (
        await f.request(`/v1/interactions/${q.data.id}/answers`, {
          version: 2,
          answer: { outcome: "allowed-once" },
        })
      ).data.error.code,
      "INTERACTION_STALE",
    );
  } finally {
    await f.close();
  }
});

test("runner and device pairing tolerate lost response without issuing a second identity", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(
      (await f.request("/v1/runner-pairings/complete", f.pairing, "")).data,
      f.runner,
    );
    const d = (await f.request("/auth/device", {}, "")).data;
    assert.equal(
      (
        await f.request(
          "/auth/device/token",
          { deviceId: d.deviceId, pollToken: d.pollToken },
          "",
        )
      ).data.state,
      "pending",
    );
    assert.equal(
      (
        await f.request("/auth/device/approve", {
          deviceId: d.deviceId,
          userCode: d.userCode,
        })
      ).status,
      200,
    );
    const one = await f.request(
      "/auth/device/token",
      { deviceId: d.deviceId, pollToken: d.pollToken },
      "",
    );
    const two = await f.request(
      "/auth/device/token",
      { deviceId: d.deviceId, pollToken: d.pollToken },
      "",
    );
    assert.deepEqual(one.data, two.data);
    assert.equal(
      (await f.request("/v1/me", undefined, one.data.token)).status,
      200,
    );
  } finally {
    await f.close();
  }
});

test("browser writes need a matching Origin and runner revocation invalidates active task tokens", async () => {
  const f = await fixture();
  try {
    const cookie = f.service.store.mint("owner", "owner");
    assert.equal(
      (
        await f.request("/v1/runner-pairings", {}, "", "key", {
          cookie: `dsh_cloud=${cookie}`,
        })
      ).status,
      403,
    );
    const { taskId } = (await f.create()).data,
      e = await f.start(taskId);
    await f.request(`/v1/runners/${f.runner.runnerId}/revoke`, {});
    assert.equal(
      (await f.request("/v1/executor/commands", undefined, e.token)).status,
      403,
    );
    assert.equal(
      (await f.request("/v1/runner/work", undefined, f.runner.token)).status,
      401,
    );
  } finally {
    await f.close();
  }
});
