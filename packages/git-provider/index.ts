import {
  mkdir,
  readFile,
  writeFile,
  realpath,
  lstat,
  readdir,
  rm,
} from "node:fs/promises";
import { resolve, relative, sep, join } from "node:path";
import { existsSync } from "node:fs";
import { processRun } from "../contracts/process.ts";
import {
  requireValue,
  CloudError,
  digest,
  type Task,
} from "../contracts/index.ts";

const cleanEnv = () =>
  ({
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_LFS_SKIP_SMUDGE: "1",
  }) as NodeJS.ProcessEnv;
export function gitEnv(repo?: string, token?: string) {
  const env = cleanEnv();
  if (repo && token) {
    const origin = new URL(repo).origin;
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `http.${origin}/.extraheader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${Buffer.from("x-access-token:" + token).toString("base64")}`;
  }
  for (const k of [
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "GIT_SSL_CAINFO",
  ])
    if (process.env[k]) env[k] = process.env[k];
  return env;
}
const gitFlags = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "protocol.ext.allow=never",
  "-c",
  "protocol.file.allow=never",
];
export async function git(
  args: string[],
  options: Parameters<typeof processRun>[2] = {},
) {
  return processRun("git", [...gitFlags, ...args], {
    ...options,
    env: options.env ?? cleanEnv(),
  });
}
export async function prepareRepository(
  task: Task,
  workspace: string,
  trustedRepo: string,
  token?: string,
): Promise<string> {
  await mkdir(resolve(trustedRepo, ".."), { recursive: true });
  if (!existsSync(resolve(trustedRepo, "HEAD")))
    await git(["clone", "--bare", "--", task.repo, trustedRepo], {
      env: gitEnv(task.repo, token),
      timeout: 180000,
    });
  const commit = (
    await git([
      "--git-dir",
      trustedRepo,
      "rev-parse",
      "--verify",
      `${task.baseCommit ?? task.ref}^{commit}`,
    ])
  ).stdout.trim();
  requireValue(
    /^[a-f0-9]{40,64}$/.test(commit),
    "INVALID_COMMIT",
    "Could not resolve the task commit",
  );
  if (!existsSync(resolve(workspace, ".git"))) {
    await mkdir(workspace, { recursive: true });
    // Only this known, daemon-owned mirror may use local file transport.
    await processRun(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--no-hardlinks",
        "--",
        trustedRepo,
        workspace,
      ],
      { env: cleanEnv(), timeout: 120000 },
    );
    await git(["-C", workspace, "checkout", "-b", task.branch, commit]);
    await git(["-C", workspace, "remote", "set-url", "origin", task.repo]);
  }
  return commit;
}
export async function snapshot(
  workspace: string,
  gitDir: string,
  indexPath: string,
  baseCommit: string,
) {
  const env = { ...cleanEnv(), GIT_INDEX_FILE: indexPath };
  await mkdir(resolve(indexPath, ".."), { recursive: true });
  await rm(indexPath, { force: true });
  const flags = ["--git-dir", gitDir, "--work-tree", workspace];
  await git([...flags, "read-tree", baseCommit], { env });
  await git([...flags, "add", "-A", "--", "."], {
    env,
    cwd: workspace,
    timeout: 120000,
  });
  const tree = (await git([...flags, "write-tree"], { env })).stdout.trim();
  const diff = (
    await git(
      [
        ...flags,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        baseCommit,
        tree,
        "--",
      ],
      { env, maxBytes: 10 * 1024 * 1024 },
    )
  ).stdout;
  const stat = (
    await git(
      [
        ...flags,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--stat",
        baseCommit,
        tree,
        "--",
      ],
      { env },
    )
  ).stdout;
  const names = (
    await git([...flags, "diff", "--name-status", baseCommit, tree, "--"], {
      env,
    })
  ).stdout;
  return { workspaceRevision: tree, diff, stat, names };
}
export async function safePath(root: string, path: string) {
  requireValue(
    !path.includes("\0") && !path.split(/[\\/]/).includes(".git"),
    "INVALID_PATH",
    "Path is not allowed",
    400,
  );
  const base = await realpath(root),
    resolved = await realpath(resolve(base, path));
  const rel = relative(base, resolved);
  requireValue(
    rel !== ".." &&
      !rel.startsWith(".." + sep) &&
      !rel.split(sep).includes(".git"),
    "PATH_ESCAPE",
    "Path escapes the task workspace",
    403,
  );
  return resolved;
}
export async function readWorkspaceFile(root: string, path: string) {
  const file = await safePath(root, path),
    info = await lstat(file);
  requireValue(info.isFile(), "NOT_A_FILE", "Path is not a regular file", 400);
  requireValue(
    info.size <= 1024 * 1024,
    "FILE_TOO_LARGE",
    "File preview is limited to 1 MiB",
    413,
  );
  const data = await readFile(file);
  return {
    path,
    size: data.length,
    encoding: data.includes(0) ? "base64" : "utf8",
    content: data.includes(0) ? data.toString("base64") : data.toString("utf8"),
    hash: digest(data.toString("base64")),
  };
}
export async function listWorkspace(root: string) {
  const files: { path: string; size: number; symlink: boolean }[] = [];
  let truncated = false;
  const walk = async (dir: string, depth: number) => {
    if (depth > 20) {
      truncated = true;
      return;
    }
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (
        [".git", "node_modules", ".pnpm-store", ".cache"].includes(entry.name)
      )
        continue;
      if (files.length >= 5000) {
        truncated = true;
        return;
      }
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, depth + 1);
      else {
        const info = await lstat(path);
        files.push({
          path: relative(root, path),
          size: info.size,
          symlink: entry.isSymbolicLink(),
        });
      }
    }
  };
  await walk(root, 0);
  return { files, truncated };
}
export interface GitHubOptions {
  token: string;
  apiBase?: string;
  fetch?: typeof fetch;
}
export class GitHubProvider {
  constructor(readonly options: GitHubOptions) {}
  private async request(path: string, body?: unknown) {
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.apiBase ?? "https://api.github.com"}${path}`,
      {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
        redirect: "error",
      },
    );
    const value: any = await response.json();
    if (!response.ok)
      throw new CloudError(
        response.status,
        "GIT_API",
        `Git provider returned HTTP ${response.status}`,
      );
    return value;
  }
  async ensureDraft(task: Task, summary: string) {
    const [owner, repo] = new URL(task.repo).pathname
      .slice(1)
      .replace(/\.git$/, "")
      .split("/");
    const marker = `<!-- dsh-cloud-task:${task.id} -->`;
    const query = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&head=${encodeURIComponent(owner + ":" + task.branch)}&base=${encodeURIComponent(task.baseBranch)}`;
    const find = async () => {
      const prs = await this.request(query);
      return prs.find((p: any) => p.body?.includes(marker));
    };
    let pr = await find();
    if (pr) {
      requireValue(
        pr.state === "open",
        "PR_CLOSED",
        "The task PR is closed; choose a new task for additional work",
      );
      return { prId: pr.number, url: pr.html_url };
    }
    try {
      pr = await this.request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`,
        {
          title: task.title,
          head: task.branch,
          base: task.baseBranch,
          draft: true,
          body: `${summary}\n\n${marker}`,
        },
      );
    } catch (error) {
      pr = await find();
      if (!pr) throw error;
    }
    return { prId: pr.number, url: pr.html_url };
  }
}
export async function publish(
  task: Task,
  workspace: string,
  trustedRepo: string,
  stateRoot: string,
  request: { workspaceRevision: string; runId: string },
  lastCommit: string | null,
  provider: GitHubProvider,
  token: string,
) {
  requireValue(
    task.baseCommit,
    "BASE_COMMIT_REQUIRED",
    "Task base commit missing",
  );
  const snap = await snapshot(
    workspace,
    trustedRepo,
    resolve(stateRoot, "publish.index"),
    task.baseCommit,
  );
  requireValue(
    snap.workspaceRevision === request.workspaceRevision,
    "STALE_WORKSPACE",
    "Workspace changed after the saved result",
  );
  const remoteRef = `refs/heads/${task.branch}`,
    env = gitEnv(task.repo, token);
  const remote =
    (
      await git(
        ["--git-dir", trustedRepo, "ls-remote", "--heads", "origin", remoteRef],
        { env },
      )
    ).stdout.split(/\s/)[0] || null;
  let commit: string;
  if (remote) {
    await git(
      ["--git-dir", trustedRepo, "fetch", "--no-tags", "origin", remoteRef],
      { env, timeout: 120000 },
    );
    const remoteTree = (
      await git(["--git-dir", trustedRepo, "rev-parse", `${remote}^{tree}`])
    ).stdout.trim();
    if (remoteTree === snap.workspaceRevision) {
      commit = remote;
    } else {
      requireValue(
        remote === lastCommit,
        "REMOTE_BRANCH_CHANGED",
        "The remote task branch has changes outside this publication",
      );
      commit = await makeCommit(
        trustedRepo,
        snap.workspaceRevision,
        remote,
        task,
        request.runId,
      );
    }
  } else {
    requireValue(
      !lastCommit,
      "REMOTE_BRANCH_MISSING",
      "Published task branch was removed",
    );
    commit = await makeCommit(
      trustedRepo,
      snap.workspaceRevision,
      task.baseCommit,
      task,
      request.runId,
    );
  }
  // Journal before pushing. A timeout is reconciled by querying the exact branch/tree.
  await writeFile(
    resolve(stateRoot, `publication-${request.runId}.json`),
    JSON.stringify({
      commit,
      tree: snap.workspaceRevision,
      branch: task.branch,
    }),
    { mode: 0o600 },
  );
  if (commit !== remote)
    await git(
      ["--git-dir", trustedRepo, "push", "origin", `${commit}:${remoteRef}`],
      { env, timeout: 120000 },
    );
  const pr = await provider.ensureDraft(
    task,
    `Implements ${task.title}.\n\nRun: ${request.runId}\nWorkspace: ${snap.workspaceRevision}\n\nReview the task's check results before merging.`,
  );
  return { ...pr, commit, workspaceRevision: snap.workspaceRevision };
}
async function makeCommit(
  gitDir: string,
  tree: string,
  parent: string,
  task: Task,
  runId: string,
) {
  return (
    await git(["--git-dir", gitDir, "commit-tree", tree, "-p", parent], {
      env: {
        ...cleanEnv(),
        GIT_AUTHOR_NAME: "DSH Cloud",
        GIT_AUTHOR_EMAIL: "dsh-cloud@localhost",
        GIT_COMMITTER_NAME: "DSH Cloud",
        GIT_COMMITTER_EMAIL: "dsh-cloud@localhost",
        GIT_AUTHOR_DATE: new Date(task.createdAt).toISOString(),
        GIT_COMMITTER_DATE: new Date(task.createdAt).toISOString(),
      },
      input: `${task.title}\n\nDSH-Task: ${task.id}\nDSH-Run: ${runId}\n`,
    })
  ).stdout.trim();
}
