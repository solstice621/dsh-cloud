import { createServer, type ServerResponse } from "node:http";
import { id } from "../contracts/index.ts";
export type Reply = { text: string } | { tool: string; input: unknown };
export function streamReply(res: ServerResponse, reply: Reply, model: string) {
  const send = (type: string, data: unknown) =>
    res.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, ...(data as object) })}\n\n`,
    );
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
  });
  send("message_start", {
    message: {
      id: "msg_" + id(),
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 0 },
    },
  });
  if ("tool" in reply) {
    send("content_block_start", {
      index: 0,
      content_block: {
        type: "tool_use",
        id: "call_" + id(),
        name: reply.tool,
        input: {},
      },
    });
    send("content_block_delta", {
      index: 0,
      delta: {
        type: "input_json_delta",
        partial_json: JSON.stringify(reply.input),
      },
    });
  } else {
    send("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    });
    send("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: reply.text },
    });
  }
  send("content_block_stop", { index: 0 });
  send("message_delta", {
    delta: {
      stop_reason: "tool" in reply ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage: { output_tokens: 12 },
  });
  send("message_stop", {});
  res.end();
}
export async function modelFixture(
  reply: (body: any, index: number) => Reply | Promise<Reply>,
  listenPort = 0,
) {
  const requests: any[] = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const c of req) raw += c;
      const body = JSON.parse(raw);
      requests.push(body);
      streamReply(res, await reply(body, requests.length - 1), body.model);
    } catch (error) {
      res.writeHead(500).end(JSON.stringify({ error: String(error) }));
    }
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "0.0.0.0", () => {
      server.off("error", reject);
      done();
    });
  });
  const port = (server.address() as { port: number }).port;
  return {
    requests,
    port,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}
