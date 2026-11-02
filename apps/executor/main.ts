import { readFile } from "node:fs/promises";
import { Executor } from "./executor.ts";
const config = JSON.parse(
  await readFile(process.argv[2] ?? "/executor/config.json", "utf8"),
);
const executor = new Executor(config);
let stop: Promise<void> | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    stop ??= executor.stop(signal).finally(() => process.exit(0));
  });
try {
  await executor.start();
  await executor.loop();
} catch (e) {
  console.error(e instanceof Error ? e.message : "Executor failed");
  console.error(executor.diagnostics());
  process.exitCode = 1;
} finally {
  await executor.close();
}
