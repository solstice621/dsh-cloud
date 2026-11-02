import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { processRun } from "../packages/contracts/process.ts";
import { delay } from "../packages/contracts/http.ts";
import { id, type Task } from "../packages/contracts/index.ts";
import {
  publish,
  snapshot,
  readWorkspaceFile,
  GitHubProvider,
  git,
  prepareRepository,
} from "../packages/git-provider/index.ts";

test("real Git publication reconciles lost PR response, reuses commits, updates one PR and refuses remote changes", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-cloud-git-")),
    seed = resolve(root, "seed"),
    remote = resolve(root, "remote.git"),
    trusted = resolve(root, "trusted.git"),
    workspace = resolve(root, "workspace");
  const reserve = createServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  const port = (reserve.address() as { port: number }).port;
  await new Promise<void>((r) => reserve.close(() => r()));
  let daemon: ReturnType<typeof spawn> | undefined;
  try {
    await mkdir(seed);
    await processRun("git", ["init", "-b", "main", seed]);
    await writeFile(resolve(seed, "README.md"), "initial\n");
    await processRun("git", ["-C", seed, "add", "."]);
    await processRun("git", [
      "-C",
      seed,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@local",
      "commit",
      "-m",
      "Initial",
    ]);
    await processRun("git", ["clone", "--bare", seed, remote]);
    await processRun("git", ["clone", "--bare", seed, trusted]);
    daemon = spawn(
      "git",
      [
        "daemon",
        "--reuseaddr",
        "--export-all",
        "--enable=receive-pack",
        `--base-path=${root}`,
        `--listen=127.0.0.1`,
        `--port=${port}`,
        root,
      ],
      { stdio: "ignore" },
    );
    await delay(150);
    const remoteUrl = `git://127.0.0.1:${port}/remote.git`;
    await git(["--git-dir", trusted, "remote", "set-url", "origin", remoteUrl]);
    const task = {
      id: id(),
      title: "Improve fixture",
      repo: "https://github.com/test/fixture.git",
      ref: "main",
      baseBranch: "main",
      branch: "dsh/task/" + id(),
      createdAt: Date.now(),
      baseCommit: null,
    } as Task;
    task.baseCommit = await prepareRepository(task, workspace, trusted);
    await writeFile(resolve(workspace, "new.txt"), "version one\n");
    // These untrusted workspace Git settings must never execute on the Runner host.
    const trap = resolve(root, "hook-ran");
    await writeFile(
      resolve(workspace, ".git/hooks/pre-commit"),
      `#!/bin/sh\ntouch '${trap}'\n`,
      { mode: 0o755 },
    );
    let creates = 0;
    const prs: any[] = [];
    const provider = new GitHubProvider({
      token: "fixture",
      fetch: async (_url, options) => {
        if (options?.method === "POST") {
          creates++;
          prs.push({
            number: 7,
            html_url: "https://github.com/test/fixture/pull/7",
            state: "open",
            ...JSON.parse(options.body as string),
          });
          throw new Error("Response lost after GitHub created the PR");
        }
        return new Response(JSON.stringify(prs), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    let snap = await snapshot(
        workspace,
        trusted,
        resolve(root, "index"),
        task.baseCommit,
      ),
      request = { workspaceRevision: snap.workspaceRevision, runId: id() };
    const first = await publish(
      task,
      workspace,
      trusted,
      root,
      request,
      null,
      provider,
      "fixture",
    );
    const again = await publish(
      task,
      workspace,
      trusted,
      root,
      request,
      null,
      provider,
      "fixture",
    );
    assert.equal(first.commit, again.commit);
    assert.equal(first.prId, 7);
    assert.equal(creates, 1);
    await writeFile(resolve(workspace, "new.txt"), "version two\n");
    snap = await snapshot(
      workspace,
      trusted,
      resolve(root, "index"),
      task.baseCommit,
    );
    request = { workspaceRevision: snap.workspaceRevision, runId: id() };
    const next = await publish(
      task,
      workspace,
      trusted,
      root,
      request,
      first.commit,
      provider,
      "fixture",
    );
    assert.equal(next.prId, 7);
    assert.notEqual(next.commit, first.commit);
    assert.equal(creates, 1);
    await writeFile(resolve(workspace, "new.txt"), "third unpublished\n");
    snap = await snapshot(
      workspace,
      trusted,
      resolve(root, "index"),
      task.baseCommit,
    );
    const outsider = (
      await processRun(
        "git",
        [
          "--git-dir",
          remote,
          "-c",
          "user.name=Other",
          "-c",
          "user.email=other@local",
          "commit-tree",
          first.workspaceRevision,
          "-p",
          next.commit,
        ],
        { input: "User change\n" },
      )
    ).stdout.trim();
    await processRun("git", [
      "--git-dir",
      remote,
      "update-ref",
      "refs/heads/" + task.branch,
      outsider,
    ]);
    await assert.rejects(
      publish(
        task,
        workspace,
        trusted,
        root,
        { workspaceRevision: snap.workspaceRevision, runId: id() },
        next.commit,
        provider,
        "fixture",
      ),
      /changes outside/,
    );
    await assert.rejects(
      publish(
        task,
        workspace,
        trusted,
        root,
        { workspaceRevision: first.workspaceRevision, runId: id() },
        next.commit,
        provider,
        "fixture",
      ),
      /Workspace changed/,
    );
    await assert.rejects(readFile(trap));
  } finally {
    if (daemon) {
      daemon.kill();
      await once(daemon, "exit");
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("file preview rejects traversal and symlinks outside the workspace or into Git metadata", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-cloud-path-"));
  try {
    const workspace = resolve(root, "workspace");
    await mkdir(resolve(workspace, ".git"), { recursive: true });
    await writeFile(resolve(root, "private"), "secret");
    await writeFile(resolve(workspace, ".git/config"), "private config");
    await symlink("../private", resolve(workspace, "outside"));
    await symlink(".git/config", resolve(workspace, "metadata"));
    await writeFile(resolve(workspace, "ok.txt"), "ok");
    assert.equal((await readWorkspaceFile(workspace, "ok.txt")).content, "ok");
    for (const path of ["../private", "outside", "metadata", ".git/config"])
      await assert.rejects(readWorkspaceFile(workspace, path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
