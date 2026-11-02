import { mkdir, writeFile, rm, chmod } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { processRun } from "../packages/contracts/process.ts";
import { requireValue } from "../packages/contracts/index.ts";
const args = process.argv.slice(2),
  uninstall = args.includes("uninstall"),
  dry = args.includes("--dry-run");
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : (args[i + 1] ?? fallback);
};
const platform = option("--platform", process.platform),
  project = resolve(
    fileURLToPath(new URL("..", import.meta.url)),
    import.meta.url.includes("/dist/") ? ".." : ".",
  );
const config = resolve(option("--config", ".state/runner/config.json")),
  env = resolve(option("--env", "deploy/runner/runner.env"));
requireValue(
  ["darwin", "linux"].includes(platform),
  "PLATFORM_UNSUPPORTED",
  "Runner service supports macOS and Linux",
);
const label = "com.dsh.cloud.runner",
  name = "dsh-cloud-runner.service";
const path =
  platform === "darwin"
    ? resolve(homedir(), "Library/LaunchAgents", label + ".plist")
    : resolve(homedir(), ".config/systemd/user", name);
const xml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const q = (s: string) =>
  '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%") + '"';
const program = [
  "/bin/bash",
  resolve(project, "scripts/runner-service.sh"),
  process.execPath,
  resolve(project, "dist/apps/runner/main.js"),
  env,
  config,
];
const content =
  platform === "darwin"
    ? `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${program.map((p) => "<string>" + xml(p) + "</string>").join("")}</array><key>WorkingDirectory</key><string>${xml(project)}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(resolve(dirname(config), "service.log"))}</string><key>StandardErrorPath</key><string>${xml(resolve(dirname(config), "service.log"))}</string></dict></plist>\n`
    : `[Unit]\nDescription=DSH Cloud Runner\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${q(project)}\nExecStart=${program.map(q).join(" ")}\nEnvironment=PATH=${q(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}\nRestart=on-failure\nRestartSec=10\nKillMode=process\nTimeoutStopSec=180\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
if (dry) {
  console.log(
    JSON.stringify(
      { path, action: uninstall ? "uninstall" : "install", content },
      null,
      2,
    ),
  );
} else if (uninstall) {
  if (platform === "darwin")
    await processRun(
      "launchctl",
      ["bootout", `gui/${process.getuid!()}`, path],
      { allowFailure: true },
    );
  else {
    await processRun("systemctl", ["--user", "disable", "--now", name], {
      allowFailure: true,
    });
  }
  await rm(path, { force: true });
  if (platform === "linux")
    await processRun("systemctl", ["--user", "daemon-reload"]);
  console.log("Service removed. Task containers and data remain intact.");
} else {
  await processRun("docker", ["version", "--format", "{{.Server.Version}}"]);
  await chmod(env, 0o600);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, { mode: 0o600 });
  if (platform === "darwin") {
    await processRun(
      "launchctl",
      ["bootout", `gui/${process.getuid!()}`, path],
      { allowFailure: true },
    );
    await processRun("launchctl", [
      "bootstrap",
      `gui/${process.getuid!()}`,
      path,
    ]);
  } else {
    await processRun("systemctl", ["--user", "daemon-reload"]);
    await processRun("systemctl", ["--user", "enable", "--now", name]);
  }
  console.log("Runner service installed:", path);
}
