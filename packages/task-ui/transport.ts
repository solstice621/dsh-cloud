export interface Transport {
  request(path: string, body?: unknown, key?: string): Promise<any>;
  watch(
    taskId: string,
    after: number,
    event: (event: any) => void,
    status: (connected: boolean) => void,
  ): () => void;
  login?(token?: string): Promise<any>;
  beginLogin?(): Promise<{ verificationUri: string; userCode: string }>;
  finishLogin?(): Promise<{ state: string }>;
  logout(): Promise<void>;
}
export function browserTransport(): Transport {
  async function request(path: string, body?: unknown, key?: string) {
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      headers:
        body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "idempotency-key": key ?? crypto.randomUUID(),
            },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await res.json();
    if (!res.ok)
      throw Object.assign(
        new Error(result.error?.message ?? `HTTP ${res.status}`),
        { code: result.error?.code, status: res.status },
      );
    return result;
  }
  return {
    request,
    watch(taskId, after, onEvent, onStatus) {
      const stream = new EventSource(
        `/v1/tasks/${taskId}/events?after=${after}`,
      );
      stream.onopen = () => onStatus(true);
      stream.onerror = () => onStatus(false);
      stream.addEventListener("task", (event) =>
        onEvent(JSON.parse((event as MessageEvent).data)),
      );
      return () => stream.close();
    },
    login: async (token) =>
      token
        ? request("/auth/development", { token })
        : location.assign(
            "/auth/login?returnTo=" +
              encodeURIComponent(location.pathname + location.search),
          ),
    logout: async () => {
      await request("/auth/logout", {});
    },
  };
}
/** Cursor polling carries the same durable stream through a DSH Host Remote. */
export function pollingWatch(
  request: Transport["request"],
): Transport["watch"] {
  return (taskId, after, onEvent, onStatus) => {
    let stopped = false;
    const run = async () => {
      while (!stopped) {
        try {
          const result = await request(
            `/v1/tasks/${taskId}/events/poll?after=${after}`,
          );
          if (stopped) break;
          for (const event of result.events) {
            if (event.taskSeq <= after) continue;
            if (event.taskSeq !== after + 1)
              throw new Error("Event sequence gap; reload the task");
            onEvent(event);
            after = event.taskSeq;
          }
          onStatus(true);
        } catch {
          onStatus(false);
        }
        await new Promise((r) => setTimeout(r, 800));
      }
    };
    void run();
    return () => {
      stopped = true;
    };
  };
}
