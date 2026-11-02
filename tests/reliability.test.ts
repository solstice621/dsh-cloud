import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture } from "./helpers.ts";
import { modelFixture } from "./model-fixture.ts";
import { beginRecovery } from "../apps/control/recovery.ts";
import { id, PROTOCOL, DSH_VERSION } from "../packages/contracts/index.ts";
import { processRun } from "../packages/contracts/process.ts";

test("database restore blocks dispatch until every Runner stops; old input never replays", async () => {
  const f = await fixture();
  try {
    const { taskId, runId } = (await f.create()).data,
      e = await f.start(taskId);
    await f.request("/v1/executor/commands", undefined, e.token);
    const queued = await f.request(`/v1/tasks/${taskId}/inputs`, {
      input: "Old queued command",
    });
    const mode = beginRecovery(f.service.store);
    assert.equal(
      (await f.request("/v1/executor/commands", undefined, e.token)).data
        .current,
      null,
    );
    assert.equal(
      (await f.request("/v1/runner/work", undefined, f.runner.token)).data
        .recovery.id,
      mode.id,
    );
    assert.equal(
      (await f.request("/v1/recovery/complete", { acknowledgeUncertain: true }))
        .data.error.code,
      "RUNNER_NOT_RECONCILED",
    );
    await f.request(
      "/v1/runner/heartbeat",
      {
        protocol: PROTOCOL,
        dshVersion: DSH_VERSION,
        capacity: 1,
        inventory: [
          {
            taskId,
            epoch: e.epoch + 2,
            incarnation: "later-runtime",
            running: false,
          },
        ],
      },
      f.runner.token,
    );
    assert.equal(
      (
        await f.request(
          "/v1/runner/reconciled",
          { restoreId: mode.id },
          f.runner.token,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.request("/v1/recovery/complete", { acknowledgeUncertain: true }))
        .status,
      200,
    );
    assert.equal(f.service.store.task(taskId).paused, 1);
    assert.equal(f.service.store.task(taskId).epoch, e.epoch + 2);
    assert.equal(
      f.service.store.one<any>("SELECT state FROM runs WHERE id=?", runId)
        .state,
      "interrupted",
    );
    assert.equal(
      f.service.store.one<any>(
        "SELECT state FROM runs WHERE id=?",
        queued.data.runId,
      ).state,
      "cancelled",
    );
    assert.equal(
      (await f.request("/v1/executor/commands", undefined, e.token)).status,
      401,
    );
  } finally {
    await f.close();
  }
});

test("artifact receipt is durable, idempotent, integrity checked and scoped to the owner", async () => {
  const f = await fixture();
  try {
    const { taskId, runId } = (await f.create()).data,
      e = await f.start(taskId),
      artifact = {
        id: id(),
        runId,
        revision: "tree",
        kind: "result",
        body: { diff: "change" },
      };
    assert.equal(
      (await f.request("/v1/executor/artifacts", artifact, e.token)).status,
      200,
    );
    assert.equal(
      (await f.request("/v1/executor/artifacts", artifact, e.token)).status,
      200,
    );
    assert.equal(
      (
        await f.request(
          "/v1/executor/artifacts",
          { ...artifact, body: { diff: "other" } },
          e.token,
        )
      ).data.error.code,
      "ARTIFACT_CONFLICT",
    );
    assert.equal(
      (
        await f.request(
          `/v1/artifacts/${artifact.id}`,
          undefined,
          f.runner.token,
        )
      ).status,
      403,
    );
    assert.deepEqual(
      (await f.request(`/v1/artifacts/${artifact.id}`)).data.body,
      artifact.body,
    );
    await writeFile(
      resolve(f.root, "artifacts", artifact.id + ".json"),
      "damaged",
    );
    assert.equal((await f.request(`/v1/artifacts/${artifact.id}`)).status, 500);
  } finally {
    await f.close();
  }
});

test("real streaming model proxy records returned usage, enforces model and call budget", async () => {
  const f = await fixture(),
    model = await modelFixture((_body, index) => {
      if (index === 1) throw new Error("Injected provider failure");
      return { text: "checked" };
    });
  try {
    f.service.config.model.baseUrl = model.url;
    const { taskId } = (await f.create()).data,
      e = await f.start(taskId);
    const command = await f.request(
        "/v1/executor/commands",
        undefined,
        e.token,
      ),
      runId = command.data.current.run.id;
    const call = (modelName = "fixture") =>
      fetch(f.service.config.publicUrl + "/model/v1/messages", {
        method: "POST",
        headers: { "x-api-key": e.token, "content-type": "application/json" },
        body: JSON.stringify({
          model: modelName,
          max_tokens: 128,
          messages: [{ role: "user", content: "test" }],
          stream: true,
        }),
      });
    assert.equal((await call("wrong")).status, 403);
    const response = await call();
    assert.equal(response.status, 200);
    assert.match(await response.text(), /message_stop/);
    const usage = f.service.store.one<any>(
      "SELECT * FROM model_usage WHERE runId=?",
      runId,
    );
    assert.equal(usage.calls, 1);
    assert.equal(usage.inputTokens, 20);
    assert.equal(usage.outputTokens, 12);
    assert.equal((await call()).status, 502);
    const incomplete = f.service.store.one<any>(
      "SELECT * FROM model_usage WHERE runId=?",
      runId,
    );
    assert.equal(incomplete.calls, 2);
    assert.equal(incomplete.inputTokens, null);
    assert.equal(incomplete.outputTokens, null);
    f.service.store.exec(
      "UPDATE model_usage SET calls=12 WHERE runId=?",
      runId,
    );
    assert.equal((await call()).status, 429);
    await f.request(`/v1/runners/${f.runner.runnerId}/revoke`, {});
    assert.equal((await call()).status, 403);
  } finally {
    await f.close();
    await model.close();
  }
});

test("backup and restore produce a new integrity-checked database in reconciliation mode", async () => {
  const f = await fixture();
  try {
    const { taskId } = (await f.create()).data;
    const backup = resolve(f.root, "backup"),
      restored = resolve(f.root, "restored");
    await processRun(process.execPath, [
      "--import",
      "tsx",
      "scripts/maintenance.ts",
      "backup",
      f.service.config.database,
      backup,
    ]);
    await processRun(process.execPath, [
      "--import",
      "tsx",
      "scripts/maintenance.ts",
      "restore",
      backup,
      restored,
    ]);
    const { Store } = await import("../apps/control/db.ts");
    const { recoveryState } = await import("../apps/control/recovery.ts");
    const s = new Store(resolve(restored, "control.sqlite"));
    try {
      assert.ok(recoveryState(s));
      assert.equal(s.task(taskId).paused, 1);
    } finally {
      s.close();
    }
    await assert.rejects(
      processRun(process.execPath, [
        "--import",
        "tsx",
        "scripts/maintenance.ts",
        "restore",
        backup,
        restored,
      ]),
    );
  } finally {
    await f.close();
  }
});

test("revocation accepts only a stop acknowledgement and closes active runs after confirmation", async () => {
  const f = await fixture();
  try {
    const { taskId, runId } = (await f.create()).data,
      e = await f.start(taskId);
    await f.request("/v1/executor/commands", undefined, e.token);
    await f.request(`/v1/runners/${f.runner.runnerId}/revoke`, {});
    assert.equal(f.service.store.task(taskId).environmentState, "needs_stop");
    assert.equal(
      (await f.request("/v1/runner/work", undefined, f.runner.token)).status,
      401,
    );
    assert.equal(
      (
        await f.request(
          "/v1/runner/revoked-stopped",
          { allContainersStopped: true },
          e.token,
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await f.request(
          "/v1/runner/revoked-stopped",
          { allContainersStopped: true },
          f.runner.token,
        )
      ).status,
      200,
    );
    assert.equal(f.service.store.task(taskId).environmentState, "stopped");
    assert.equal(
      f.service.store.one<any>("SELECT state FROM runs WHERE id=?", runId)
        .state,
      "interrupted",
    );
  } finally {
    await f.close();
  }
});

test("database write exhaustion cannot acknowledge an uncommitted native checkpoint", async () => {
  const f = await fixture();
  try {
    const { taskId } = (await f.create()).data,
      e = await f.start(taskId);
    const pages = f.service.store.one<any>("PRAGMA page_count").page_count;
    f.service.store.db.exec("PRAGMA max_page_count=" + pages);
    const failed = await f.request(
      "/v1/executor/events",
      {
        events: [
          {
            seq: 0,
            type: "assistant/message",
            data: { text: "x".repeat(2 * 1024 * 1024) },
          },
        ],
        runId: null,
      },
      e.token,
    );
    assert.equal(failed.status, 500);
    assert.equal(f.service.store.task(taskId).durableSeq, -1);
    assert.equal(
      f.service.store.all("SELECT * FROM native_events WHERE taskId=?", taskId)
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("a consumed pairing code is retryable only inside its original expiry window", async () => {
  const f = await fixture();
  try {
    f.service.store.exec("UPDATE pairings SET expiresAt=0");
    const response = await f.request(
      "/v1/runner-pairings/complete",
      f.pairing,
      "",
    );
    assert.equal(response.status, 400);
    assert.equal(response.data.error.code, "PAIRING_EXPIRED");
  } finally {
    await f.close();
  }
});

test("a task pins its model route while allowing credential rotation", async () => {
  const f = await fixture();
  try {
    const { taskId } = (await f.create()).data;
    const saved = (await f.request(`/v1/tasks/${taskId}`)).data.modelRoute;
    assert.equal(saved.name, "fixture");
    assert.ok(saved.routeHash);
    f.service.config.model.apiKey = "rotated-test-key";
    assert.equal(
      (await f.request(`/v1/tasks/${taskId}/inputs`, { input: "same route" }))
        .status,
      202,
    );
    const e = await f.start(taskId);
    f.service.config.model.baseUrl = "http://127.0.0.1:2";
    assert.equal(
      (
        await f.request(`/v1/tasks/${taskId}/inputs`, {
          input: "changed route",
        })
      ).data.error.code,
      "MODEL_ROUTE_CHANGED",
    );
    assert.equal(
      (await f.request("/v1/executor/commands", undefined, e.token)).data.error
        .code,
      "MODEL_ROUTE_CHANGED",
    );
    const response = await f.request(
      "/model/v1/messages",
      { model: "fixture", max_tokens: 128, messages: [] },
      e.token,
    );
    assert.equal(response.data.error.code, "MODEL_ROUTE_CHANGED");
    assert.equal(
      f.service.store.one<any>("SELECT COUNT(*) AS n FROM model_usage")?.n,
      0,
    );
    f.service.config.model.baseUrl = "http://127.0.0.1:1";
    assert.equal(
      (await f.request("/v1/executor/commands", undefined, e.token)).status,
      200,
    );
  } finally {
    await f.close();
  }
});
