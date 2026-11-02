import { processRun } from "../../packages/contracts/process.ts";
import {
  requireValue,
  type ExecutorConfig,
} from "../../packages/contracts/index.ts";
export interface Container {
  id: string;
  name: string;
  taskId: string;
  epoch: number;
  incarnation: string;
  running: boolean;
  paused: boolean;
  exitCode: number;
  oomKilled: boolean;
  imageId: string;
}
export class Docker {
  constructor(readonly runnerId: string) {}
  private cmd(args: string[], timeout = 60000) {
    return processRun("docker", args, { timeout, maxBytes: 8 * 1024 * 1024 });
  }
  async available() {
    const r = await this.cmd(["version", "--format", "{{.Server.Version}}"]);
    return r.stdout.trim();
  }
  async containers(): Promise<Container[]> {
    const ids = (
      await this.cmd([
        "ps",
        "-aq",
        "--filter",
        `label=dsh.cloud.runner=${this.runnerId}`,
      ])
    ).stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    if (!ids.length) return [];
    return JSON.parse((await this.cmd(["inspect", ...ids])).stdout).map(
      (c: any) => this.parse(c),
    );
  }
  private parse(c: any): Container {
    return {
      id: c.Id,
      name: c.Name.replace(/^\//, ""),
      taskId: c.Config.Labels["dsh.cloud.task"],
      epoch: Number(c.Config.Labels["dsh.cloud.epoch"]),
      incarnation: c.Config.Labels["dsh.cloud.incarnation"],
      running: c.State.Running,
      paused: c.State.Paused,
      exitCode: c.State.ExitCode,
      oomKilled: c.State.OOMKilled,
      imageId: c.Image,
    };
  }
  async inspect(name: string) {
    const c = JSON.parse((await this.cmd(["inspect", name])).stdout)[0];
    requireValue(
      c.Config.Labels["dsh.cloud.runner"] === this.runnerId,
      "CONTAINER_OWNER",
      "Container does not belong to this Runner",
    );
    return this.parse(c);
  }
  async image(image: string) {
    try {
      return JSON.parse(
        (await this.cmd(["image", "inspect", image])).stdout,
      )[0];
    } catch {
      await this.cmd(["pull", image], 300000);
      return JSON.parse(
        (await this.cmd(["image", "inspect", image])).stdout,
      )[0];
    }
  }
  async launch(
    config: ExecutorConfig,
    paths: { workspace: string; home: string; state: string },
    imageId: string,
  ) {
    const t = config.task,
      name = `dsh-cloud-${t.environmentId}-${config.epoch}`;
    const args = [
      "run",
      "--detach",
      "--init",
      "--name",
      name,
      "--label",
      `dsh.cloud.runner=${this.runnerId}`,
      "--label",
      `dsh.cloud.task=${t.id}`,
      "--label",
      `dsh.cloud.epoch=${config.epoch}`,
      "--label",
      `dsh.cloud.incarnation=${config.incarnation}`,
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--pids-limit",
      "512",
      "--cpus",
      String(config.template.cpu),
      "--memory",
      `${config.template.memoryMb}m`,
      "--read-only",
      "--tmpfs",
      "/tmp:rw,exec,nosuid,nodev,size=512m",
      "--network",
      config.template.network,
      "--add-host",
      "host.docker.internal:host-gateway",
      "--stop-timeout",
      "20",
      "--mount",
      `type=bind,src=${paths.workspace},dst=/workspace`,
      "--mount",
      `type=bind,src=${paths.home},dst=/dsh-home`,
      "--mount",
      `type=bind,src=${paths.state},dst=/executor`,
      ...Object.entries({
        HTTP_PROXY: config.template.proxy?.http,
        HTTPS_PROXY: config.template.proxy?.https,
        NO_PROXY: config.template.proxy?.noProxy,
      })
        .filter(([, v]) => v)
        .flatMap(([k, v]) => ["--env", `${k}=${v}`]),
      "--env",
      "HOME=/dsh-home",
      "--env",
      "NPM_CONFIG_CACHE=/dsh-home/.npm",
      "--workdir",
      "/workspace",
      imageId,
      "node",
      "/app/dist/apps/executor/main.js",
      `/executor/config-${config.incarnation}.json`,
    ];
    await this.cmd(args, 120000);
    return this.inspect(name);
  }
  async stop(container: Container) {
    if (container.running) {
      if (container.paused) await this.unpause(container);
      await this.cmd(["stop", "--time", "20", container.id], 35000).catch(
        async () => {
          await this.cmd(["kill", container.id], 15000);
        },
      );
    }
    const current = await this.inspect(container.id);
    requireValue(
      !current.running,
      "STOP_UNCONFIRMED",
      "Container did not stop",
    );
    return current;
  }
  async remove(container: Container) {
    requireValue(
      !(await this.inspect(container.id)).running,
      "CONTAINER_RUNNING",
      "Stop the container before removal",
    );
    await this.cmd(["rm", container.id]);
  }
  async pause(container: Container) {
    await this.cmd(["pause", container.id]);
  }
  async unpause(container: Container) {
    await this.cmd(["unpause", container.id]);
  }
  async logs(container: Container) {
    const r = await this.cmd(["logs", "--tail", "100", container.id]);
    return r.stdout + r.stderr;
  }
}
