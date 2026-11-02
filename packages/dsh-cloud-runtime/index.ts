import type { Context } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-session-persistence";
import z from "@deepseek-ai/schemastery";
import { createServer } from "node:http";
import { chmod, unlink } from "node:fs/promises";

export const name = "dsh-cloud-runtime";
export const inject = ["sessionPersistence"];
export interface Config {
  socketPath: string;
  sessionId: string;
}
export const Config = z.object({
  socketPath: z.string().required(),
  sessionId: z.string().required(),
});

/** Private, task-scoped durability/read adapter. Never writes native log files. */
export async function apply(ctx: Context, config: Config) {
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    try {
      if (
        req.method !== "POST" ||
        !["/checkpoint", "/inspect"].includes(req.url ?? "")
      ) {
        res.writeHead(404).end("{}");
        return;
      }
      let raw = "";
      for await (const c of req) {
        raw += c;
        if (Buffer.byteLength(raw) > 4096) throw new Error("Request too large");
      }
      const body = JSON.parse(raw || "{}");
      if (body.sessionId !== config.sessionId) {
        res.writeHead(403).end("{}");
        return;
      }
      await ctx.sessionPersistence.flush();
      const snapshot = await ctx.sessionPersistence.stat(
        config.sessionId as SessionId,
      );
      if (!snapshot) {
        res.end(JSON.stringify({ exists: false, durableSeq: -1, events: [] }));
        return;
      }
      const after = body.after ?? -1,
        limit = body.limit ?? 200;
      if (
        !Number.isSafeInteger(after) ||
        after < -1 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new Error("Invalid event window");
      await using handle = await ctx.sessionPersistence.open(
        config.sessionId as SessionId,
        "read",
      );
      const { events } = await handle.read(after + 1, limit);
      // The returned prefix was read after flush. Read length, rather than wall-clock,
      // determines the durable cursor; callers page until an empty batch.
      res.end(
        JSON.stringify({
          exists: true,
          header: handle.header,
          events,
          durableSeq: events.length ? events[events.length - 1]!.seq : after,
        }),
      );
    } catch (error) {
      res
        .writeHead(500)
        .end(
          JSON.stringify({
            error:
              error instanceof Error ? error.message : "Persistence failure",
          }),
        );
    }
  });
  await ctx.effect(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    await chmod(config.socketPath, 0o600);
    return async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await unlink(config.socketPath).catch(() => {});
    };
  });
}
