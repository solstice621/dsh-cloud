import {
  DeepSeekHarness,
  type HarnessNotification,
  type DeepSeekHarnessOptions,
} from "@deepseek-ai/dsh-sdk-client";
import { request } from "node:http";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { stringify } from "yaml";
import type { ExecutorConfig } from "../../packages/contracts/index.ts";

export async function checkpoint(
  socketPath: string,
  sessionId: string,
  after = -1,
  limit = 200,
): Promise<{
  exists: boolean;
  events: any[];
  durableSeq: number;
  header?: any;
}> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path: "/checkpoint",
        method: "POST",
        headers: { "content-type": "application/json" },
        timeout: 20000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 20 * 1024 * 1024)
            req.destroy(new Error("Checkpoint exceeds batch limit"));
          else chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode !== 200)
              reject(new Error(data.error ?? "Checkpoint failed"));
            else resolve(data);
          } catch (e) {
            reject(e);
          }
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("Checkpoint timeout")));
    req.end(JSON.stringify({ sessionId, after, limit }));
  });
}

export async function writeRuntimePatch(
  config: Pick<
    ExecutorConfig,
    | "patchPath"
    | "task"
    | "stateDir"
    | "dshHome"
    | "workspace"
    | "model"
    | "modelBaseUrl"
    | "socketPath"
  >,
  pluginPath = existsSync(
    fileURLToPath(
      new URL("../../packages/dsh-cloud-runtime/index.js", import.meta.url),
    ),
  )
    ? fileURLToPath(
        new URL("../../packages/dsh-cloud-runtime/index.js", import.meta.url),
      )
    : resolve("dist/packages/dsh-cloud-runtime/index.js"),
) {
  const disabled = [
    "goal-round-driver",
    "tool-goal",
    "command-goal",
    "tool-subagent",
    "tool-subagent-control",
    "tool-subagent-fork",
    "subagent-spawn-in-process",
    "subagent-fork-in-process",
    "schedule",
    "tool-schedule",
    "tool-plugin-manager",
    "session-title-llm",
    "llm-deepseek-account",
    "web-search-deepseek",
    "web-deepseek-api",
    "skill-office",
    "workspace-dependencies",
  ];
  const patch: any[] = [
    {
      id: "tool-bash",
      config: { enableRunInBackground: false, promoteOnTimeout: false },
    },
    ...disabled.map((id) => ({ id, disabled: true })),
    {
      id: "llm-deepseek",
      config: {
        baseURL: config.modelBaseUrl,
        apiKeyEnv: "DSH_CLOUD_MODEL_TOKEN",
        reasoningEffort: "off",
        models: [{ id: config.model, contextWindow: 131072, maxTokens: 8192 }],
      },
    },
    {
      id: "session-persistence-jsonl",
      config: {
        root: resolve(config.dshHome, "sessions"),
        compression: "none",
      },
    },
    {
      id: "sandbox-policy",
      config: { mode: "danger-full-access", workspaceRoot: config.workspace },
    },
    {
      id: "permission",
      config: {
        presets: { cloud: { sandbox: "danger-full-access", approval: "ask" } },
        defaultPreset: "cloud",
      },
    },
    {
      insert: [
        {
          id: "cloud-runtime",
          name: pluginPath,
          config: {
            socketPath:
              config.socketPath ?? resolve(config.stateDir, "runtime.sock"),
            sessionId: config.task.sessionId,
          },
        },
      ],
    },
  ];
  await mkdir(dirname(config.patchPath), { recursive: true });
  await writeFile(config.patchPath, stringify(patch), { mode: 0o600 });
}

export function makeHarness(
  config: ExecutorConfig,
  callbacks: Pick<DeepSeekHarnessOptions, "onUserQuestion">,
  extra: Partial<DeepSeekHarnessOptions> = {},
) {
  return new DeepSeekHarness({
    profile: "sdk",
    dshHome: config.dshHome,
    cwd: config.workspace,
    processCwd: config.workspace,
    provider: "deepseek-official",
    model: config.model,
    maxTokens: config.template.maxOutputTokens,
    patches: [config.patchPath],
    approvalRequests: true,
    initializeTimeoutMs: 120000,
    env: {
      PATH: process.env.PATH,
      HOME: config.dshHome,
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: "C.UTF-8",
      DSH_CLOUD_MODEL_TOKEN: config.token,
      DSH_MAX_TOKENS_AS_SUCCESS: "false",
      NODE_USE_ENV_PROXY: "1",
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([k, v]) =>
            v !== undefined &&
            [
              "HTTP_PROXY",
              "HTTPS_PROXY",
              "NO_PROXY",
              "http_proxy",
              "https_proxy",
              "no_proxy",
              "NODE_EXTRA_CA_CERTS",
            ].includes(k),
        ),
      ),
    },
    ...callbacks,
    ...extra,
  });
}
export function assistantText(events: any[]): string {
  return events
    .filter((e) => e.type === "assistant/message")
    .flatMap((e) => e.message?.content ?? e.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}
