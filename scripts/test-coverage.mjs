import { mkdir, readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await mkdir("coverage", { recursive: true });
const tests = (await readdir("tests")).filter(name => name.endsWith(".test.ts")).sort();
if (!tests.length) throw new Error("No regression tests found");
const result = spawnSync(process.execPath, [
  "--import", "tsx", "--test", "--test-timeout=60000", "--experimental-test-coverage",
  "--test-coverage-include=apps/**/*.ts", "--test-coverage-include=packages/**/*.ts",
  "--test-coverage-include=packages/**/*.tsx",
  "--test-coverage-lines=85", "--test-coverage-branches=80", "--test-coverage-functions=75",
  "--test-reporter=spec", "--test-reporter-destination=stdout",
  "--test-reporter=lcov", "--test-reporter-destination=coverage/lcov.info",
  ...tests.map(name => `tests/${name}`),
], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
