import type { TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { setImmediate } from "node:timers/promises";

export async function temporaryDirectory(t: TestContext, label: string) {
  const root = await mkdtemp(resolve(tmpdir(), `dsh-cloud-${label}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Drain promise continuations without sleeping or advancing mocked clocks. */
export async function settle() {
  await setImmediate();
}
