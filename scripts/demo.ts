/** Local protocol demo: actual Control/Runner/Docker/DSH, deterministic model replies. */
import { mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ControlService } from "../apps/control/server.ts";
import { Runner, type RunnerConfig } from "../apps/runner/runner.ts";
import { modelFixture } from "../packages/testing/model-fixture.ts";
import { api } from "../packages/contracts/http.ts";
import { processRun } from "../packages/contracts/process.ts";
import { durableWrite } from "../packages/contracts/storage.ts";
import {
  id,
  secret,
  DSH_VERSION,
  PROTOCOL,
  TemplateSchema,
} from "../packages/contracts/index.ts";
const requestedRoot = resolve(process.env.CLOUD_DEMO_ROOT ?? ".state/demo");
await mkdir(requestedRoot, { recursive: true, mode: 0o700 });
const root = await realpath(requestedRoot),
  port = Number(process.env.CLOUD_PORT ?? 8787);
const tokenPath = resolve(root, "development-token");
const token = existsSync(tokenPath)
  ? (await readFile(tokenPath, "utf8")).trim()
  : secret();
await writeFile(tokenPath, token, { mode: 0o600 });
const modelPortPath = resolve(root, "model-port");
const modelPort = existsSync(modelPortPath)
  ? Number(await readFile(modelPortPath, "utf8"))
  : 0;
const model = await modelFixture(async (body) => {
  const last = body.messages.at(-1),
    content = last.content ?? [];
  if (
    Array.isArray(content) &&
    content.some((c: any) => c.type === "tool_result")
  )
    return {
      text: "已完成这一步工作，工作区文件已保留。可从原生文件预览和「云端结果」查看。\n\n这是本地协议演示：工具由真实 DSH 运行，模型响应来自固定测试脚本。",
    };
  const prompt = typeof content === "string" ? content : content.filter((c: any) => c.type === "text").at(-1)?.text ?? "";
  // A harmless slow reply makes the native stop control observable in the demo.
  if (/WAIT_FOR_CANCEL/.test(prompt)) {
    await delay(30000);
    return { text: "演示等待结束；本轮没有执行文件或外部操作。" };
  }
  if (/提问|问我|ASK_AND_WAIT/.test(prompt))
    return {
      tool: "ask_user_question",
      input: {
        questions: [
          {
            id: "direction",
            question: "下一步怎样处理这项任务？",
            options: [
              {
                label: "保留结果并继续",
                description: "继续在同一会话与环境中工作。",
              },
              {
                label: "先检查文件",
                description: "保留当前文件，稍后再决定。",
              },
            ],
          },
        ],
      },
    };
  if (/读取|READ_MARKER/.test(prompt))
    return { tool: "read", input: { file_path: "task-notes.md" } };
  return {
    tool: "write",
    input: {
      file_path: "task-notes.md",
      content:
        "# 持续的云任务\n\n此文件由真实 DSH 工具创建。\n\n- 会话与工作区随任务保留\n- 从浏览器或 DSH 插件继续追问\n- 环境停止后可以从原卷恢复\n",
    },
  };
}, modelPort);
await durableWrite(modelPortPath, String(model.port));
const template = TemplateSchema.parse({
  id: "demo",
  version: "2",
  image: "dsh-cloud-runtime:0.1.1",
  platforms: ["linux/arm64", "linux/amd64"],
  checks: [
    {
      name: "工作区文件已创建",
      command: "test -s task-notes.md",
      required: true,
    },
  ],
  timeoutSeconds: 120,
  maxOutputTokens: 1024,
});
const service = new ControlService({
  host: "0.0.0.0",
  port,
  publicUrl: `http://127.0.0.1:${port}`,
  database: resolve(root, "control.sqlite"),
  webRoot: resolve("dist/web"),
  ownerId: "owner",
  development: true,
  devToken: token,
  model: {
    baseUrl: model.url,
    apiKey: "local-fixture",
    name: "local-demo-fixture",
  },
  templates: [template],
  allowedRepoHosts: ["github.com"],
});
await service.listen();
const user = (path: string, body?: unknown) =>
  api<any>(service.config.publicUrl, path, token, body, {
    headers: { "idempotency-key": id() },
  });
const configPath = resolve(root, "runner-config.json");
let config: RunnerConfig;
if (existsSync(configPath))
  config = JSON.parse(await readFile(configPath, "utf8"));
else {
  const pairing = await user("/v1/runner-pairings", {}),
    pair = await api<any>(
      service.config.publicUrl,
      "/v1/runner-pairings/complete",
      "",
      {
        code: pairing.code,
        name: `${process.platform === "darwin" ? "macOS" : "Linux"} · 本地演示节点`,
        platform: `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`,
        protocol: PROTOCOL,
        dshVersion: DSH_VERSION,
      },
    );
  config = {
    ...pair,
    root: resolve(root, "runner"),
    controlUrl: service.config.publicUrl,
    executorControlUrl: `http://host.docker.internal:${port}`,
    capacity: 1,
    gitTokenEnv: "CLOUD_DEMO_NO_GIT_CREDENTIAL",
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
}
const runner = new Runner(config);
await runner.start();
let taskId = service.store.one<any>(
  "SELECT t.id FROM tasks t JOIN task_models m ON m.taskId=t.id WHERE t.runnerId=? AND t.lifecycle!='deleted' AND m.name='local-demo-fixture' ORDER BY t.createdAt LIMIT 1",
  config.runnerId,
)?.id;
if (!taskId) {
  const result = await user("/v1/tasks", {
    title: "跨设备继续同一个云任务",
    runnerId: config.runnerId,
    templateId: template.id,
    templateVersion: template.version,
    repo: "https://github.com/dsh-cloud/local-demo.git",
    ref: "main",
    baseBranch: "main",
    input: "创建一份任务说明，记录当前工作区将持续保留，并执行文件检查。",
  });
  taskId = result.taskId;
  const seed = resolve(root, "seed"),
    mirror = resolve(config.root, "trusted", taskId + ".git");
  await mkdir(seed, { recursive: true });
  await mkdir(resolve(config.root, "trusted"), { recursive: true });
  await processRun("git", ["init", "-b", "main", seed]);
  await writeFile(
    resolve(seed, "README.md"),
    "# DSH Cloud local protocol demo\n",
  );
  await processRun("git", ["-C", seed, "add", "."]);
  await processRun("git", [
    "-C",
    seed,
    "-c",
    "user.name=DSH Demo",
    "-c",
    "user.email=demo@localhost",
    "commit",
    "-m",
    "Initial demo",
  ]);
  await processRun("git", ["clone", "--bare", seed, mirror]);
}
console.log(
  JSON.stringify(
    {
      url: service.config.publicUrl + "/tasks/" + taskId,
      developmentTokenFile: tokenPath,
      model: "deterministic local fixture; real DSH tools",
      stop: "Ctrl+C stops only demo containers; task data remains in " + root,
    },
    null,
    2,
  ),
);
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => runner.abort.abort());
try {
  // The reserved demo repository is provisioned locally for every UI-created
  // demo task. Real repositories keep the ordinary authenticated Git path.
  while (!runner.abort.signal.aborted) {
    for (const task of service.store.all<any>("SELECT id FROM tasks WHERE runnerId=? AND repo=? AND lifecycle='open'", config.runnerId, "https://github.com/dsh-cloud/local-demo.git")) {
      const mirror = resolve(config.root, "trusted", task.id + ".git");
      if (!existsSync(mirror)) await processRun("git", ["clone", "--bare", resolve(root, "seed"), mirror]);
    }
    await runner.tick().catch(error => console.error(JSON.stringify({ level: "warn", error: error.message })));
    await delay(1500, undefined, { signal: runner.abort.signal }).catch(() => {});
  }
} finally {
  for (const c of await runner.docker.containers())
    if (c.running) await runner.docker.stop(c);
  await runner.close();
  await service.close();
  await model.close();
}
