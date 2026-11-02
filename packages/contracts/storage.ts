import { open, rename, link, rm, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { id, requireValue, digest } from "./index.ts";

/** Commit bytes before acknowledging them. Immutable files never replace prior data. */
export async function durableWrite(
  path: string,
  content: string,
  immutable = false,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + id() + ".tmp",
    handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (immutable) {
      try {
        await link(temporary, path);
      } catch (error: any) {
        if (error.code !== "EEXIST") throw error;
        requireValue(
          digest(await readFile(path, "utf8")) === digest(content),
          "ARTIFACT_CONFLICT",
          "Saved artifact differs",
        );
      }
    } else await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}
