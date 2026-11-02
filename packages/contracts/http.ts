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
  const data: any = await r.json();
  if (!r.ok)
    throw new CloudError(
      r.status,
      data.error?.code ?? "HTTP_ERROR",
      data.error?.message ?? r.statusText,
    );
  return data as T;
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
