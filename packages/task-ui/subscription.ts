import type { Transport } from "./transport.ts";

/** Details, a complete native prefix and its event subscription form one retryable unit. */
export function subscribeTask(transport: Transport, taskId: string, callbacks: {
  snapshot: (snapshot: any) => void;
  history: (events: any[]) => void;
  event: (event: any) => void;
  status: (connected: boolean) => void;
  error: (message: string) => void;
}, retryMs = 1000) {
  let stopped = false, generation = 0, failures = 0;
  let unwatch: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const retry = (message?: string) => {
    if (stopped) return;
    generation++;
    unwatch?.(); unwatch = undefined;
    clearTimeout(timer);
    callbacks.status(false);
    if (message) callbacks.error(message);
    timer = setTimeout(() => void initialize(), Math.min(15000, retryMs * 2 ** failures++));
  };
  const initialize = async () => {
    const attempt = generation;
    const live = () => !stopped && generation === attempt;
    try {
      const snapshot = await transport.request(`/v1/tasks/${taskId}`);
      if (!live()) return;
      let after = -1;
      const events: any[] = [];
      while (live()) {
        const batch = await transport.request(`/v1/tasks/${taskId}/history?after=${after}`);
        if (!live()) return;
        for (const event of batch.events) {
          if (event.seq !== after + 1) throw new Error("原生日志不连续，正在重新同步。");
          events.push(event); after = event.seq;
        }
        if (after >= batch.durableSeq) break;
        if (!batch.events.length) throw new Error("历史尚未同步完整，正在重试。");
      }
      if (!live()) return;
      callbacks.snapshot(snapshot);
      callbacks.history(events);
      callbacks.error("");
      let cursor = snapshot.snapshotSeq;
      const stop = transport.watch(taskId, cursor, event => {
        if (!live() || event.taskSeq <= cursor) return;
        if (event.taskSeq !== cursor + 1) { retry("事件序号存在缺口，正在重新同步。"); return; }
        cursor = event.taskSeq;
        callbacks.event(event);
      }, connected => {
        if (!live()) return;
        callbacks.status(connected);
        if (connected) { failures = 0; callbacks.error(""); }
        else retry();
      });
      if (live()) unwatch = stop;
      else stop();
    } catch (error: any) { if (live()) retry(error.message); }
  };
  void initialize();
  return () => { stopped = true; generation++; clearTimeout(timer); unwatch?.(); };
}
