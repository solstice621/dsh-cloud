import { CloudError, digest } from "./index.ts";

/** Only a journal from before a recorded restore may treat a missing Run as an orphan. */
export function outboxFailure(error: unknown, item: { restoreId?: string | null }, restoreId: string | null) {
  if (!(error instanceof CloudError)) return null;
  if (["STALE_EXECUTOR", "RUNNER_REVOKED", "UNAUTHORIZED"].includes(error.code)) return null;
  if (["RESULT_CONFLICT", "RUN_NOT_CURRENT", "CANCEL_PENDING", "INTERACTION_STALE", "INTERACTION_STATE"].includes(error.code))
    return { blocking: false, reason: error.code };
  if (error.code === "RUN_NOT_FOUND" && restoreId && (item.restoreId ?? null) !== restoreId)
    return { blocking: false, reason: "RESTORED_RUN_NOT_FOUND" };
  if (error.status >= 400 && error.status < 500 && ![408, 425, 429].includes(error.status))
    return { blocking: true, reason: error.code };
  return null;
}

// Shared by the live Executor and stopped-container replay. The complete payload
// remains in rejected_outbox; a compact, idempotent receipt makes it visible in Control.
export async function replayOutbox(journal: any, send: (path: string, body: any) => Promise<any>, restoreId: string | null) {
  for (const item of journal.all("SELECT * FROM outbox ORDER BY id LIMIT 100")) {
    try {
      await send(item.path, JSON.parse(item.body));
      journal.run("DELETE FROM outbox WHERE id=?", item.id);
    } catch (error) {
      const disposition = outboxFailure(error, item, restoreId);
      if (!disposition) throw error;
      const e = error as CloudError, body = JSON.parse(item.body);
      await send("/v1/executor/reconciliation", {
        id: digest({ path: item.path, body: item.body, restoreId: item.restoreId ?? null }),
        path: item.path, code: e.code, status: e.status,
        runId: typeof body.runId === "string" ? body.runId : null,
        restoreId: item.restoreId ?? null,
        bodyHash: digest(item.body), bytes: Buffer.byteLength(item.body),
      });
      journal.rejectOutbox(item, disposition.reason);
      if (disposition.blocking)
        throw new CloudError(409, "DELIVERY_REJECTED", `Durable output needs inspection: ${e.code}`);
    }
  }
}
