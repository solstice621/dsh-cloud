import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { DeepSeekHarness } from "@deepseek-ai/dsh-sdk-client";
import { writeRuntimePatch, checkpoint } from "../apps/executor/runtime.ts";
const root = await mkdtemp(resolve(tmpdir(), "dsh-cloud-m0-"));
const sessionId = crypto.randomUUID(),
  workspace = resolve(root, "workspace"),
  stateDir = resolve(root, "state");
await mkdir(workspace);
await mkdir(stateDir);
const config = {
  patchPath: resolve(root, "patch.yml"),
  stateDir,
  dshHome: resolve(root, "home"),
  workspace,
  model: "cloud-test",
  modelBaseUrl: "http://127.0.0.1:18769",
  task: { sessionId },
} as any;
await writeRuntimePatch(config);
const options = {
  dshHome: resolve(root, "home"),
  cwd: workspace,
  processCwd: workspace,
  patches: [config.patchPath],
  initializeTimeoutMs: 120000,
  provider: "deepseek-official",
  model: "cloud-test",
  env: { ...process.env, DSH_CLOUD_MODEL_TOKEN: "m0-fixture-token" },
};
let harness = new DeepSeekHarness(options);
try {
  await harness.start();
  console.log("initialize ok");
  await harness.session(sessionId).setWorkingDirectory(workspace);
  console.log(
    "checkpoint",
    await checkpoint(resolve(stateDir, "runtime.sock"), sessionId),
  );
  await harness.close();
  harness = new DeepSeekHarness(options);
  await harness.resumeSession(sessionId);
  console.log(
    "resumed",
    await harness.session(sessionId).getWorkingDirectory(),
  );
  console.log("root", root);
} catch (error) {
  console.error((harness.client as any).stderrTail);
  throw error;
} finally {
  await harness.close();
}
