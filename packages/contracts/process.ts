import { spawn } from "node:child_process";
import { CloudError } from "./index.ts";
export interface ProcessResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
}
export async function processRun(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeout?: number;
    maxBytes?: number;
    signal?: AbortSignal;
    allowFailure?: boolean;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const out: Buffer[] = [],
      err: Buffer[] = [];
    let bytes = 0,
      timedOut = false,
      overflow = false,
      killTimer: NodeJS.Timeout | undefined;
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {}
      killTimer = setTimeout(() => {
        try {
          if (child.pid && process.platform !== "win32")
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      }, 2000);
      killTimer.unref();
    };
    const onData = (list: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 8 * 1024 * 1024)) {
        if (!overflow) {
          overflow = true;
          kill();
        }
      } else list.push(chunk);
    };
    child.stdout.on("data", (c) => onData(out, c));
    child.stderr.on("data", (c) => onData(err, c));
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeout ?? 60000);
    const abort = () => kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (e) => {
      cleanup();
      reject(e);
    });
    child.on("close", (code) => {
      cleanup();
      const result = {
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
        code: code ?? -1,
        timedOut,
      };
      if (overflow)
        reject(
          new CloudError(
            413,
            "PROCESS_OUTPUT_LIMIT",
            "Command exceeded its output limit",
          ),
        );
      else if (!options.allowFailure && (result.code !== 0 || timedOut))
        reject(
          new CloudError(
            502,
            "PROCESS_FAILED",
            `${command} exited ${result.code}${timedOut ? " after timeout" : ""}: ${result.stderr.slice(-2000)}`,
          ),
        );
      else resolve(result);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
    if (options.signal?.aborted) abort();
  });
}
