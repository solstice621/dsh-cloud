/** Test-only trusted supervisor. Requires explicit Docker socket access. */
import { mkdtemp, rm, realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { processRun } from "../packages/contracts/process.ts";
const root = await realpath(await mkdtemp("/tmp/dsh-cloud-linux-"));
const name = `dsh-cloud-linux-${crypto.randomUUID().slice(0, 8)}`;
const socket =
  process.env.CLOUD_TEST_DOCKER_SOCKET ??
  (process.platform === "linux"
    ? "/var/run/docker.sock"
    : resolve(process.env.HOME!, ".docker/run/docker.sock"));
const socketGroup = String((await stat(socket)).gid);
let created = false;
try {
  await processRun("docker", [
    "network",
    "create",
    "--label",
    "dsh.cloud.acceptance=true",
    name,
  ]);
  created = true;
  const result = await processRun(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      "--label",
      "dsh.cloud.acceptance=true",
      "--network",
      name,
      "--user",
      `${process.getuid!()}:${process.getgid!()}`,
      "--group-add",
      "0",
      "--group-add",
      socketGroup,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--mount",
      `type=bind,src=${socket},dst=/var/run/docker.sock`,
      "--mount",
      `type=bind,src=${root},dst=${root}`,
      "-e",
      `TMPDIR=${root}`,
      "-e",
      `HOME=${root}`,
      "-e",
      "CLOUD_DOCKER_TEST=1",
      "-e",
      `CLOUD_TEST_NETWORK=${name}`,
      "-e",
      `CLOUD_TEST_EXECUTOR_HOST=${name}`,
      "dsh-cloud-linux-acceptance:0.1.1",
    ],
    { timeout: 600000, maxBytes: 2 * 1024 * 1024, allowFailure: true },
  );
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.code !== 0) process.exitCode = result.code ?? 1;
} finally {
  await processRun("docker", ["rm", "-f", name]).catch(() => {});
  if (created)
    await processRun("docker", ["network", "rm", name]).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
