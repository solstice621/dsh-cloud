import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { hostname, arch } from "node:os";
import { Runner, type RunnerConfig } from "./runner.ts";
import { api } from "../../packages/contracts/http.ts";
import { DSH_VERSION, PROTOCOL } from "../../packages/contracts/index.ts";
const configPath = resolve(
  process.env.CLOUD_RUNNER_CONFIG ?? ".state/runner/config.json",
);
if (process.argv[2] === "pair") {
  const url = process.env.CLOUD_CONTROL_URL ?? "http://127.0.0.1:8787",
    code = process.env.CLOUD_PAIR_CODE;
  if (!code)
    throw new Error(
      "Set CLOUD_PAIR_CODE to a one-time code from the task dashboard",
    );
  const pair = await api<any>(url, "/v1/runner-pairings/complete", "", {
    code,
    name: process.env.CLOUD_RUNNER_NAME ?? hostname(),
    platform: `linux/${arch() === "arm64" ? "arm64" : "amd64"}`,
    protocol: PROTOCOL,
    dshVersion: DSH_VERSION,
  });
  const config: RunnerConfig = {
    ...pair,
    controlUrl: url,
    executorControlUrl: process.env.CLOUD_EXECUTOR_CONTROL_URL ?? url,
    root: resolve(process.env.CLOUD_RUNNER_ROOT ?? ".state/runner"),
    capacity: Number(process.env.CLOUD_RUNNER_CAPACITY ?? 1),
    gitTokenEnv: process.env.CLOUD_GIT_TOKEN_ENV ?? "CLOUD_GITHUB_TOKEN",
    gitApiBase: process.env.CLOUD_GITHUB_API_BASE,
  };
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  await writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  console.log(`Runner paired. Configuration saved to ${configPath}`);
} else {
  const config = JSON.parse(await readFile(configPath, "utf8")) as RunnerConfig,
    runner = new Runner(config);
  let closing = false;
  const stop = async () => {
    if (!closing) {
      closing = true;
      runner.abort.abort();
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => void stop());
  try {
    await runner.start();
    console.log(
      `Runner ${config.runnerId} connected. Existing task containers outlive this daemon.`,
    );
    await runner.loop();
  } finally {
    await runner.close();
  }
}
