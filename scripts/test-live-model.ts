/** Opt-in real model acceptance. Credentials stay in the Control process. */
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import { ControlService } from "../apps/control/server.ts";
import { Runner, type RunnerConfig } from "../apps/runner/runner.ts";
import { api, delay } from "../packages/contracts/http.ts";
import { processRun } from "../packages/contracts/process.ts";
import {
  id,
  secret,
  DSH_VERSION,
  PROTOCOL,
  TemplateSchema,
  digest,
} from "../packages/contracts/index.ts";

let model = {
  baseUrl: process.env.CLOUD_MODEL_BASE_URL ?? "",
  apiKey: process.env.CLOUD_MODEL_API_KEY ?? "",
  name: process.env.CLOUD_MODEL_NAME ?? "",
};
const dshHome = process.env.CLOUD_TEST_DSH_HOME;
if (dshHome) {
  const rows = parse(
    await readFile(
      resolve(dshHome, "profiles/desktop/cordis.patch.yml"),
      "utf8",
    ),
  );
  const providers =
    rows.find((row: any) => row.id === "llm-pi-ai")?.config?.providers ?? {};
  const provider: any = Object.values(providers).find(
    (p: any) => p.api === "anthropic-messages",
  );
  assert.ok(provider, "The selected DSH profile has no Messages provider");
  const credentials = parse(
    await readFile(resolve(dshHome, ".credentials.yaml"), "utf8"),
  );
  model = {
    baseUrl: provider.baseURL,
    apiKey: credentials.refs?.[provider.apiKeyEnv],
    name: provider.models[0].id,
  };
}
assert.ok(
  model.baseUrl && model.apiKey && model.name,
  "Set CLOUD_MODEL_* or explicitly choose CLOUD_TEST_DSH_HOME",
);
const root = await realpath(
  await mkdtemp(resolve(tmpdir(), "dsh-cloud-live-")),
);
const token = secret(),
  marker = `cloud-live-${id()}`;
const template = TemplateSchema.parse({
  id: "live",
  version: "1",
  image: "dsh-cloud-runtime:0.1.1",
  platforms: ["linux/amd64", "linux/arm64"],
  minFreeDiskMb: 512,
  timeoutSeconds: 300,
  maxModelCalls: 8,
  maxOutputTokens: 2048,
  checks: [
    {
      name: "Live marker content",
      command: `test "$(cat marker.txt)" = '${marker}'`,
      required: true,
    },
  ],
});
const service = new ControlService({
  host: "0.0.0.0",
  port: 0,
  publicUrl: "http://127.0.0.1:0",
  database: resolve(root, "control.sqlite"),
  webRoot: resolve("dist/web"),
  ownerId: "owner",
  development: true,
  devToken: token,
  model,
  templates: [template],
  allowedRepoHosts: ["github.com"],
});
let runner: Runner | undefined;
try {
  await service.listen();
  const port = (service.server.address() as any).port;
  service.config.publicUrl = `http://127.0.0.1:${port}`;
  const user = (path: string, body?: unknown) =>
    api<any>(service.config.publicUrl, path, token, body, {
      headers: { "idempotency-key": id() },
    });
  const code = await user("/v1/runner-pairings", {});
  const pair = await api<any>(
    service.config.publicUrl,
    "/v1/runner-pairings/complete",
    "",
    {
      code: code.code,
      name: "Live model acceptance",
      platform: process.arch === "arm64" ? "linux/arm64" : "linux/amd64",
      protocol: PROTOCOL,
      dshVersion: DSH_VERSION,
    },
  );
  const config: RunnerConfig = {
    ...pair,
    root: resolve(root, "runner"),
    controlUrl: service.config.publicUrl,
    executorControlUrl: `http://${process.env.CLOUD_TEST_EXECUTOR_HOST ?? "host.docker.internal"}:${port}`,
    capacity: 1,
    gitTokenEnv: "CLOUD_FIXTURE_UNUSED_GIT_TOKEN",
  };
  runner = new Runner(config);
  await runner.start();
  const created = await user("/v1/tasks", {
    title: "Live provider acceptance",
    runnerId: pair.runnerId,
    templateId: "live",
    templateVersion: "1",
    repo: "https://github.com/dsh-cloud/fixture.git",
    ref: "main",
    baseBranch: "main",
    input: `Use the file tool to write marker.txt containing exactly ${marker} followed by a newline. Then read it with the file tool and report the value. Do not change any other files. No plan, no question, and no shell command is needed.`,
  });
  const taskId = created.taskId,
    initial = service.store.task(taskId);
  const seed = resolve(root, "seed"),
    mirror = resolve(config.root, "trusted", taskId + ".git");
  await mkdir(seed);
  await mkdir(resolve(config.root, "trusted"), { recursive: true });
  await processRun("git", ["init", "-b", "main", seed]);
  await writeFile(
    resolve(seed, "README.md"),
    "Isolated live model acceptance repository.\n",
  );
  await processRun("git", ["-C", seed, "add", "."]);
  await processRun("git", [
    "-C",
    seed,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@localhost",
    "commit",
    "-m",
    "Initial fixture",
  ]);
  await processRun("git", ["clone", "--bare", seed, mirror]);
  async function waitFor(check: () => boolean, label: string) {
    const until = Date.now() + 360000;
    while (Date.now() < until) {
      await runner!.tick();
      if (check()) return;
      const active = service.store.one<any>(
        "SELECT state,result FROM runs WHERE taskId=? AND state IN ('failed','interrupted','uncertain','cancelled')",
        taskId,
      );
      assert.ok(!active, `${label}: ${JSON.stringify(active)}`);
      assert.notEqual(
        service.store.task(taskId).environmentState,
        "error",
        label + " environment error",
      );
      await delay(750);
    }
    throw new Error("Timeout: " + label);
  }
  await waitFor(
    () =>
      service.store.one<any>("SELECT state FROM runs WHERE id=?", created.runId)
        ?.state === "succeeded",
    "live write",
  );
  const file = resolve(config.root, "tasks", taskId, "workspace/marker.txt");
  assert.equal((await readFile(file, "utf8")).trim(), marker);
  const prefix = service.store.all(
    "SELECT nativeSeq,hash FROM native_events WHERE taskId=? ORDER BY nativeSeq",
    taskId,
  );
  await user(`/v1/tasks/${taskId}/environment/stop`, {});
  await waitFor(
    () => service.store.task(taskId).environmentState === "stopped",
    "stop environment",
  );
  const second = await user(`/v1/tasks/${taskId}/inputs`, {
    input:
      "Read marker.txt with the file tool. Report its exact value and confirm it is the value you wrote earlier. Do not rewrite it or use shell commands.",
  });
  await waitFor(
    () =>
      service.store.one<any>("SELECT state FROM runs WHERE id=?", second.runId)
        ?.state === "succeeded",
    "live resume",
  );
  const final = service.store.task(taskId);
  assert.equal(final.sessionId, initial.sessionId);
  assert.equal(final.environmentId, initial.environmentId);
  assert.equal(final.epoch, 2);
  assert.equal((await readFile(file, "utf8")).trim(), marker);
  assert.deepEqual(
    service.store.all(
      "SELECT nativeSeq,hash FROM native_events WHERE taskId=? AND nativeSeq<? ORDER BY nativeSeq",
      taskId,
      prefix.length,
    ),
    prefix,
  );
  const result = service.store.one<any>(
    "SELECT result FROM runs WHERE id=?",
    second.runId,
  );
  assert.ok(
    result.result.includes(marker),
    "Resumed model must report the actual original marker",
  );
  const evidence = {
    realModel: true,
    model: model.name,
    providerOrigin: new URL(model.baseUrl).origin,
    runnerOS: process.platform,
    taskId,
    sessionId: final.sessionId,
    environmentId: final.environmentId,
    epoch: final.epoch,
    durableSeq: final.durableSeq,
    nativePrefixHash: digest(prefix),
    markerHash: digest(marker),
    usage: service.store.all(
      "SELECT calls,inputTokens,outputTokens FROM model_usage WHERE runId IN (?,?)",
      created.runId,
      second.runId,
    ),
    verified: [
      "real model file write/read",
      "same session and environment after container stop",
      "native prefix unchanged",
      "second model turn read original file",
    ],
  };
  if (process.env.CLOUD_LIVE_REPORT)
    await writeFile(
      process.env.CLOUD_LIVE_REPORT,
      JSON.stringify(evidence, null, 2) + "\n",
    );
  console.log(JSON.stringify(evidence));
} finally {
  if (runner) {
    for (const c of await runner.docker.containers()) {
      await runner.docker.remove(await runner.docker.stop(c));
    }
    await runner.close();
  }
  await service.close();
  await rm(root, { recursive: true, force: true });
}
