import { Store } from "./db.ts";
import { id, requireValue, type Task } from "../../packages/contracts/index.ts";
export function recoveryState(store: Store) {
  const row = store.one<any>(
    "SELECT value FROM meta WHERE key='reconciliation'",
  );
  return row ? JSON.parse(row.value) : null;
}
export function beginRecovery(store: Store) {
  const state = { id: id(), startedAt: Date.now() };
  store.tx(() => {
    store.exec(
      "INSERT OR REPLACE INTO meta VALUES ('reconciliation',?)",
      JSON.stringify(state),
    );
    store.exec("UPDATE tasks SET paused=1");
  });
  return state;
}
export function finishRecovery(store: Store) {
  const mode = recoveryState(store);
  requireValue(mode, "NOT_RECONCILING", "No database recovery is pending");
  return store.tx(() => {
    const runners = store.all<any>("SELECT * FROM runners WHERE revoked=0");
    for (const r of runners) {
      const ack = store.one<any>(
        "SELECT value FROM meta WHERE key=?",
        "reconciled:" + r.id,
      );
      requireValue(
        ack?.value === mode.id && Date.now() - r.lastSeenAt < 30000,
        "RUNNER_NOT_RECONCILED",
        `Runner ${r.name} must reconnect and confirm every container stopped`,
      );
      requireValue(
        !JSON.parse(r.inventory).some((c: any) => c.running),
        "RUNTIME_ACTIVE",
        "A Runner still has live containers",
      );
    }
    const orphans: any[] = [];
    for (const r of runners)
      for (const c of JSON.parse(r.inventory)) {
        const t = store.one<Task>(
          "SELECT * FROM tasks WHERE id=? AND runnerId=?",
          c.taskId,
          r.id,
        );
        if (!t) {
          orphans.push({ runnerId: r.id, ...c });
          continue;
        }
        if (c.epoch >= t.epoch)
          store.exec(
            "UPDATE tasks SET epoch=?,incarnation=? WHERE id=?",
            c.epoch,
            c.incarnation,
            t.id,
          );
      }
    for (const t of store.all<Task>(
      "SELECT * FROM tasks WHERE lifecycle!='deleted'",
    )) {
      for (const run of store.all<any>(
        "SELECT * FROM runs WHERE taskId=? AND state NOT IN ('succeeded','failed','interrupted','uncertain','cancelled')",
        t.id,
      )) {
        const state = run.state === "queued" ? "cancelled" : "interrupted",
          result = JSON.stringify({
            error:
              "Database restored: external effects require inspection; original input will not be replayed",
          });
        store.exec(
          "UPDATE runs SET state=?,result=?,endedAt=? WHERE id=?",
          state,
          result,
          Date.now(),
          run.id,
        );
        store.exec(
          "UPDATE attempts SET endedAt=?,outcome=? WHERE runId=?",
          Date.now(),
          state,
          run.id,
        );
      }
      store.exec(
        `UPDATE tasks SET currentRunId=NULL,paused=1,environmentState='stopped',recoveryRequired=1,
          recoveryRunId=COALESCE(recoveryRunId,?,(SELECT id FROM runs WHERE taskId=? ORDER BY COALESCE(startedAt,0) DESC,ordinal DESC LIMIT 1)),
          recoveryReason='database_restore',restoreId=? WHERE id=?`,
        t.currentRunId, t.id, mode.id,
        t.id,
      );
      store.exec(
        "UPDATE interactions SET state='expired',version=version+1 WHERE taskId=?",
        t.id,
      );
      store.exec(
        "UPDATE operations SET state='unknown',result=? WHERE taskId=? AND state IN ('pending','running')",
        JSON.stringify({
          error: "Database restore requires explicit operation retry",
        }),
        t.id,
      );
      store.event(t.id, "database.reconciled", {
        restoreId: mode.id,
        requiresInspection: true,
      });
    }
    store.exec("UPDATE credentials SET revoked=1 WHERE kind='executor'");
    store.exec("DELETE FROM idempotency WHERE scope LIKE 'runner:%:start:%'");
    store.exec("DELETE FROM meta WHERE key='reconciliation'");
    store.exec(
      "INSERT OR REPLACE INTO meta VALUES ('lastRecovery',?)",
      JSON.stringify({ ...mode, completedAt: Date.now(), orphans }),
    );
    return {
      ok: true,
      orphans,
      notice:
        "All task queues remain paused. Inspect each workspace and submit explicit recovery input.",
    };
  });
}
