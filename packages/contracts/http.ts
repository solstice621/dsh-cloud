import { CloudError } from "./index.ts";
export async function api<T = any>(
  base: string,
  path: string,
  token: string,
  body?: unknown,
  options: {
    method?: string;
    signal?: AbortSignal;
    timeout?: number;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const r = await fetch(new URL(path, base), {
    method: options.method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: options.signal ?? AbortSignal.timeout(options.timeout ?? 20000),
    redirect: "error",
  });
  const data: any = await r.json().catch(error => { if (r.ok) throw error; return {}; });
  if (!r.ok)
    throw new CloudError(
      r.status,
      data.error?.code ?? "HTTP_ERROR",
      data.error?.message ?? r.statusText,
      retryAfter(r.headers.get("retry-after")),
    );
  return data as T;
}
export function retryAfter(value: string | null) {
  if (!value) return undefined;
  const milliseconds = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(milliseconds) ? Math.max(0, milliseconds) : undefined;
}
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}
