import { test } from "node:test";
import assert from "node:assert/strict";
import { Docker, type Container } from "../apps/runner/docker.ts";
import type { ExecutorConfig } from "../packages/contracts/index.ts";
import { template } from "./helpers.ts";

const container: Container = { id: "container-id", name: "runtime", taskId: "task",
  epoch: 3, incarnation: "incarnation", running: true, paused: false,
  exitCode: 0, oomKilled: false, imageId: "sha256:pinned" };
const result = (stdout = "") => ({ stdout, stderr: "", code: 0, timedOut: false });

test("Docker launch isolates the runtime and uses an immutable image and incarnation config", async t => {
  const docker = new Docker("runner");
  const commands: string[][] = [];
  t.mock.method(docker as any, "cmd", async (args: string[]) => { commands.push(args); return result(); });
  t.mock.method(docker, "inspect", async () => container);
  const config = { token: "must-not-appear-in-docker-args", task: { id: "task", environmentId: "environment" },
    epoch: 3, incarnation: "incarnation", template } as ExecutorConfig;
  await docker.launch(config, { workspace: "/test/work", home: "/test/home", state: "/test/state" }, "sha256:pinned");
  const args = commands[0]!;
  for (const flag of ["--read-only", "--init"]) assert.ok(args.includes(flag), flag);
  for (const [flag, expected] of [["--cap-drop", "ALL"], ["--security-opt", "no-new-privileges"],
    ["--pids-limit", "512"], ["--memory", `${template.memoryMb}m`], ["--network", template.network]])
    assert.equal(args[args.indexOf(flag!) + 1], expected);
  const mounts = args.flatMap((a, i) => a === "--mount" ? [args[i + 1]] : []);
  assert.deepEqual(mounts, ["type=bind,src=/test/work,dst=/workspace", "type=bind,src=/test/home,dst=/dsh-home", "type=bind,src=/test/state,dst=/executor"]);
  assert.equal(args.includes("--privileged"), false);
  assert.equal(args.join(" ").includes(config.token), false);
  assert.deepEqual(args.slice(-4), ["sha256:pinned", "node", "/app/dist/apps/executor/main.js", "/executor/config-incarnation.json"]);
});

test("Docker inspect rejects containers belonging to another Runner", async t => {
  const docker = new Docker("runner");
  t.mock.method(docker as any, "cmd", async () => result(JSON.stringify([{ Config: { Labels: { "dsh.cloud.runner": "someone-else" } } }])));
  await assert.rejects(docker.inspect("foreign"), (e: any) => e.code === "CONTAINER_OWNER");
});

test("paused container is unpaused before graceful stop; timeout escalates and verifies exit", async t => {
  const docker = new Docker("runner"), operations: string[] = [];
  t.mock.method(docker as any, "cmd", async (args: string[]) => {
    operations.push(args[0]!);
    if (args[0] === "stop") throw new Error("stop timed out");
    return result();
  });
  t.mock.method(docker, "inspect", async () => { operations.push("inspect"); return { ...container, running: false }; });
  assert.equal((await docker.stop({ ...container, paused: true })).running, false);
  assert.deepEqual(operations, ["unpause", "stop", "kill", "inspect"]);
});

test("Docker cannot confirm or remove a container that still reports running", async t => {
  const docker = new Docker("runner");
  const cmd = t.mock.method(docker as any, "cmd", async () => result());
  t.mock.method(docker, "inspect", async () => container);
  await assert.rejects(docker.stop(container), (e: any) => e.code === "STOP_UNCONFIRMED");
  await assert.rejects(docker.remove(container), (e: any) => e.code === "CONTAINER_RUNNING");
  assert.equal(cmd.mock.calls.some((c: any) => c.arguments[0][0] === "rm"), false);
});

test("missing runtime image is pulled once and its resolved identity is returned", async t => {
  const docker = new Docker("runner"), calls: string[][] = [];
  t.mock.method(docker as any, "cmd", async (args: string[]) => {
    calls.push(args);
    if (calls.length === 1) throw new Error("image missing");
    return result(JSON.stringify([{ Id: "sha256:resolved" }]));
  });
  assert.equal((await docker.image("runtime:version")).Id, "sha256:resolved");
  assert.deepEqual(calls, [["image", "inspect", "runtime:version"], ["pull", "runtime:version"], ["image", "inspect", "runtime:version"]]);
});
