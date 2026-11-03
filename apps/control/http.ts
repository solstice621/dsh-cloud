import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { CloudError, requireValue } from "../../packages/contracts/index.ts";
export async function body(
  req: IncomingMessage,
  limit = 1024 * 1024,
): Promise<any> {
  requireValue(
    req.headers["content-type"]?.split(";")[0] === "application/json",
    "CONTENT_TYPE",
    "Expected application/json",
    415,
  );
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) req.resume();
    requireValue(
      size <= limit,
      "BODY_TOO_LARGE",
      "Request exceeds size limit",
      413,
    );
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CloudError(400, "INVALID_JSON", "Invalid JSON");
  }
}
export function json(res: ServerResponse, value: unknown, status = 200) {
  if (res.writableEnded) return;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
}
export function cookie(req: IncomingMessage, name: string) {
  return (req.headers.cookie ?? "")
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(name + "="))
    ?.slice(name.length + 1);
}
export function idempotency(req: IncomingMessage) {
  const key = req.headers["idempotency-key"];
  requireValue(
    typeof key === "string" && key.length > 0 && key.length <= 200,
    "IDEMPOTENCY_REQUIRED",
    "Idempotency-Key is required",
    400,
  );
  return key;
}
export const textInput = z.string().trim().min(1).max(100000);
export class RateLimit {
  private entries = new Map<string, { count: number; expires: number }>();
  check(key: string, limit = 60, window = 60000) {
    const now = Date.now();
    let item = this.entries.get(key);
    if (!item || item.expires <= now) {
      item = { count: 0, expires: now + window };
      this.entries.set(key, item);
    }
    requireValue(
      ++item.count <= limit,
      "RATE_LIMIT",
      "Too many requests, try again shortly",
      429,
    );
    if (this.entries.size > 10000)
      for (const [k, v] of this.entries)
        if (v.expires <= now) this.entries.delete(k);
  }
}
