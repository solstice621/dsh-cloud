import { readFile, access, statfs } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { processRun } from "../packages/contracts/process.ts";
import { DSH_VERSION, PROTOCOL } from "../packages/contracts/index.ts";
const results: any[] = [];
async function check(name: string, fn: () => Promise<unknown>) {
  try {
    results.push({ name, ok: true, value: await fn() });
  } catch (e: any) {
    results.push({ name, ok: false, error: e.code ?? e.message });
  }
}
await check("Node 24.19+", async () => {
  if (
    Number(process.versions.node.split(".")[0]) !== 24 ||
    Number(process.versions.node.split(".")[1]) < 19
  )
    throw new Error("Node 24.19 or later in the 24.x line is required");
  return process.version;
});
await check("Docker backend", async () =>
  (
    await processRun("docker", ["version", "--format", "{{.Server.Version}}"])
  ).stdout.trim(),
);
await check("Git", async () =>
  (await processRun("git", ["--version"])).stdout.trim(),
);
await check("Runner configuration", async () => {
  const path = resolve(
      process.env.CLOUD_RUNNER_CONFIG ?? ".state/runner/config.json",
    ),
    c = JSON.parse(await readFile(path, "utf8"));
  const disk = await statfs(dirname(path));
  const response = await fetch(c.controlUrl + "/healthz", {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Control service is unreachable");
  const remote: any = await response.json();
  if (remote.protocol !== PROTOCOL || remote.dshVersion !== DSH_VERSION)
    throw new Error("Control service compatibility mismatch");
  return {
    runnerId: c.runnerId,
    controlUrl: c.controlUrl,
    executorControlUrl: c.executorControlUrl,
    root: c.root,
    freeGiB: Math.round(
      (Number(disk.bavail) * Number(disk.bsize)) / 1073741824,
    ),
  };
});
console.log(
  JSON.stringify(
    {
      platform: process.platform,
      arch: process.arch,
      protocol: PROTOCOL,
      dshVersion: DSH_VERSION,
      checks: results,
    },
    null,
    2,
  ),
);
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
