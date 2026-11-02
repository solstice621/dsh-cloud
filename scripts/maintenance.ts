import { mkdir, cp, readFile, writeFile, stat, chmod } from "node:fs/promises";
import { resolve } from "node:path";
import { Store } from "../apps/control/db.ts";
import { beginRecovery } from "../apps/control/recovery.ts";
import { digest, requireValue } from "../packages/contracts/index.ts";
import { durableWrite } from "../packages/contracts/storage.ts";
const [command, sourceArg, destinationArg] = process.argv.slice(2);
requireValue(
  ["backup", "restore"].includes(command ?? "") && sourceArg && destinationArg,
  "USAGE",
  "Usage: node dist/scripts/maintenance.js backup <control.sqlite> <new-backup-dir> | restore <backup-dir> <new-data-dir>",
  400,
);
const source = resolve(sourceArg!),
  destination = resolve(destinationArg!);
await mkdir(destination, { mode: 0o700 }); // Refuse overwrite; never replace a running database.
if (command === "backup") {
  const store = new Store(source);
  try {
    store.db
      .prepare("VACUUM INTO ?")
      .run(resolve(destination, "control.sqlite"));
    await chmod(resolve(destination, "control.sqlite"), 0o600);
    const snapshot = new Store(resolve(destination, "control.sqlite"));
    const artifacts = snapshot.all<any>("SELECT id,hash,body FROM artifacts");
    snapshot.close();
    await mkdir(resolve(destination, "artifacts"), { mode: 0o700 });
    const artifactRoot = resolve(
      process.env.CLOUD_ARTIFACT_ROOT ?? resolve(source, "..", "artifacts"),
    );
    for (const a of artifacts)
      if (a.body === "@file") {
        const content = await readFile(
          resolve(artifactRoot, a.id + ".json"),
          "utf8",
        );
        requireValue(
          digest(content) === a.hash,
          "CORRUPT_BACKUP",
          "Artifact checksum differs",
        );
        await durableWrite(
          resolve(destination, "artifacts", a.id + ".json"),
          content,
          true,
        );
      }
    await durableWrite(
      resolve(destination, "manifest.json"),
      JSON.stringify(
        {
          version: 1,
          createdAt: new Date().toISOString(),
          databaseHash: digest(
            (await readFile(resolve(destination, "control.sqlite"))).toString(
              "base64",
            ),
          ),
          artifactCount: artifacts.length,
        },
        null,
        2,
      ),
      true,
    );
    console.log("Backup complete:", destination);
  } finally {
    store.close();
  }
} else {
  const manifest = JSON.parse(
    await readFile(resolve(source, "manifest.json"), "utf8"),
  );
  requireValue(
    manifest.version === 1 &&
      digest(
        (await readFile(resolve(source, "control.sqlite"))).toString("base64"),
      ) === manifest.databaseHash,
    "CORRUPT_BACKUP",
    "Database backup checksum differs",
  );
  await cp(
    resolve(source, "control.sqlite"),
    resolve(destination, "control.sqlite"),
  );
  await cp(resolve(source, "artifacts"), resolve(destination, "artifacts"), {
    recursive: true,
  });
  const store = new Store(resolve(destination, "control.sqlite"));
  try {
    for (const a of store.all<any>(
      "SELECT * FROM artifacts WHERE body='@file'",
    ))
      requireValue(
        digest(
          await readFile(
            resolve(destination, "artifacts", a.id + ".json"),
            "utf8",
          ),
        ) === a.hash,
        "CORRUPT_BACKUP",
        "Artifact backup checksum differs",
      );
    console.log(
      JSON.stringify(
        {
          restored: destination,
          recovery: beginRecovery(store),
          next: "Start control with this data directory. Every Runner must reconcile before POST /v1/recovery/complete. Queues stay paused.",
        },
        null,
        2,
      ),
    );
  } finally {
    store.close();
  }
}
