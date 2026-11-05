import { Context } from "@deepseek-ai/cordis";
import { TypertRemoteService, Remote } from "@deepseek-ai/dsh-typert-protocol";
import type {} from "@deepseek-ai/dsh-typert-registry";
import { defineTool, type ParameterSchemaSpec } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { z as schema } from "zod";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { api } from "../contracts/http.ts";
import {
  CloudError,
  digest,
  requireValue,
  redact,
  TaskInputSchema,
} from "../contracts/index.ts";
import { remote } from "./remote.ts";
import { NativeCloudSessions } from "./native.ts";

export const name = "dsh-cloud-plugin";
export const inject = ["typert", "tools", "sessionController", "sessionProjections", "typertGateway", "workspaceFiles", "workspaceController", "workspaceRegistry"];
export interface Config {
  serviceUrl: string;
  credentialFile?: string;
}
export const Config = z.object({
  serviceUrl: z.string().default("http://127.0.0.1:8787"),
  credentialFile: z.string(),
});
const Payload = schema.discriminatedUnion("op", [
  schema
    .object({
      op: schema.literal("request"),
      path: schema.string().max(2000),
      body: schema.unknown().optional(),
      key: schema.string().max(200).optional(),
    })
    .strict(),
  schema
    .object({ op: schema.enum(["beginLogin", "finishLogin", "logout"]) })
    .strict(),
  schema.object({ op: schema.literal("native"), action: schema.enum(["status", "draft", "defaults", "detail", "recover"]), data: schema.unknown().optional() }).strict(),
]);
export class CloudService extends TypertRemoteService {
  native: NativeCloudSessions;
  private token = "";
  private pending: any;
  private ready: Promise<void>;
  private credentialFile: string;
  readonly url: string;
  constructor(ctx: Context, config: Config) {
    super(ctx, "cloud");
    const url = new URL(config.serviceUrl);
    requireValue(
      url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)),
      "TLS_REQUIRED",
      "Use HTTPS for a remote control service",
    );
    requireValue(
      !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === "/",
      "INVALID_URL",
      "Use the control service origin",
    );
    this.url = url.origin;
    this.credentialFile = resolve(
      config.credentialFile ??
        resolve(
          process.env.DSH_HOME ?? resolve(homedir(), ".dsh"),
          `cloud-device-${digest(this.url).slice(0, 12)}.json`,
        ),
    );
    this.ready = readFile(this.credentialFile, "utf8")
      .then((raw) => {
        const saved = JSON.parse(raw);
        if (saved.serviceUrl === this.url) this.token = saved.token;
      })
      .catch((e: any) => {
        if (e.code !== "ENOENT") throw e;
      });
    this.native = new NativeCloudSessions(ctx, this.request.bind(this) as any, this.credentialFile + ".sessions.json");
    ctx.effect(() => this.native.mount());
    ctx.effect(() =>
      ctx.typert.register({
        package: "dsh-cloud-plugin",
        face: "host",
        schemas: [],
        model: { services: [], events: [], objects: [] },
        invocations: remote.descriptors,
      }),
    );
  }
  async request(path: string, body?: unknown, key?: string) {
    await this.ready;
    const target = new URL(path, this.url);
    requireValue(
      target.origin === this.url &&
        target.pathname.startsWith("/v1/") &&
        /^\/v1\/(info|me|recovery|templates|runners|runner-pairings|tasks|runs|interactions|operations|artifacts)(?:[/?]|$)/.test(
          path,
        ),
      "API_PATH_DENIED",
      "Unsupported cloud API route",
    );
    requireValue(
      this.token || path === "/v1/info",
      "UNAUTHORIZED",
      "Sign in to the cloud workspace first",
      401,
    );
    return api(this.url, path, this.token, body, {
      headers:
        body === undefined
          ? {}
          : { "idempotency-key": key ?? crypto.randomUUID() },
    });
  }
  @Remote
  async invoke(payload: string): Promise<string> {
    try {
      requireValue(
        Buffer.byteLength(payload) < 1024 * 1024,
        "REQUEST_TOO_LARGE",
        "Cloud request too large",
        413,
      );
      const data = Payload.parse(JSON.parse(payload));
      let value: unknown;
      if (data.op === "request")
        value = await this.request(data.path, data.body, data.key);
      else if (data.op === "native") value = await this.native.invoke(data.action, data.data);
      else if (data.op === "beginLogin") {
        this.pending = await api(this.url, "/auth/device", "", {});
        value = {
          verificationUri: this.pending.verificationUri,
          userCode: this.pending.userCode,
          expiresIn: this.pending.expiresIn,
        };
      } else if (data.op === "finishLogin") {
        requireValue(
          this.pending,
          "LOGIN_REQUIRED",
          "Start device login first",
        );
        const result = await api<any>(this.url, "/auth/device/token", "", {
          deviceId: this.pending.deviceId,
          pollToken: this.pending.pollToken,
        });
        if (result.state === "approved") {
          await mkdir(dirname(this.credentialFile), {
            recursive: true,
            mode: 0o700,
          });
          await writeFile(
            this.credentialFile + ".tmp",
            JSON.stringify({ serviceUrl: this.url, token: result.token }),
            { mode: 0o600 },
          );
          await rename(this.credentialFile + ".tmp", this.credentialFile);
          this.token = result.token;
          this.pending = undefined;
        }
        value = { state: result.state };
      } else {
        await this.ready;
        if (this.token) await api(this.url, "/auth/logout", this.token, {});
        this.token = "";
        this.native.signOut();
        await rm(this.credentialFile, { force: true });
        value = { ok: true };
      }
      return JSON.stringify({ ok: true, value });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: {
          message: redact(error),
          status: error instanceof CloudError ? error.status : 500,
          code: error instanceof CloudError ? error.code : "CLOUD_ERROR",
        },
      });
    }
  }
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    cloud: CloudService;
  }
}
const taskParam = {
  type: "string" as const,
  required: true as const,
  description: "Existing cloud task UUID.",
};
export function apply(ctx: Context, config: Config) {
  const cloud = new CloudService(ctx, config);
  registerCloudTools(ctx, cloud);
}

export function registerCloudTools(
  ctx: Pick<Context, "effect" | "tools">,
  cloud: Pick<CloudService, "url" | "request">,
) {
  const register = (
    name: string,
    description: string,
    parameters: ParameterSchemaSpec,
    execute: (args: any, key: string) => Promise<unknown>,
  ) =>
    ctx.effect(() =>
      // The author-facing parameter map must be compiled before registration.
      // Passing it directly leaks required:true and omits the JSON Schema root.
      ctx.tools.register(defineTool({
        name,
        description,
        parameters,
        output: {
          schema: {
            type: "object",
            properties: { summary: { type: "string", required: true } },
            additionalProperties: false,
          },
          render: (_args, value) => [
            { type: "text", text: value.summary },
          ],
        },
        execute: async (args, exec) => ({
          summary: JSON.stringify(await execute(args, String(exec.callId))),
        }),
      })),
    );
  const link = (taskId: string) => `${cloud.url}/tasks/${taskId}`;
  register(
    "cloud_start",
    "Create a persistent task on a registered Runner. Returns a cloud task reference; work continues remotely.",
    {
      title: { type: "string", required: true },
      runnerId: { type: "string", required: true },
      templateId: { type: "string", required: true },
      templateVersion: { type: "string", required: true },
      repo: { type: "string", required: true },
      ref: { type: "string", required: true },
      baseBranch: { type: "string" },
      input: { type: "string", required: true },
      deliveryPolicy: { type: "string", enum: ["results", "draft-pr"] },
    },
    async (args, key) => {
      const result: any = await cloud.request(
        "/v1/tasks",
        TaskInputSchema.parse(args),
        key,
      );
      return { ...result, url: link(result.taskId), state: "queued" };
    },
  );
  register(
    "cloud_list",
    "List cloud tasks, registered Runners and environment templates.",
    {},
    async () => {
      const [tasks, runners, templates] = await Promise.all([
        cloud.request("/v1/tasks"),
        cloud.request("/v1/runners"),
        cloud.request("/v1/templates"),
      ]);
      return {
        tasks: (tasks as any[]).map((t) => ({
          taskId: t.id,
          title: t.title,
          state: t.environmentState,
          url: link(t.id),
        })),
        runners,
        templates,
      };
    },
  );
  register(
    "cloud_get",
    "Inspect a cloud task, its queue, questions and saved results without starting execution.",
    { taskId: taskParam },
    async (args) => {
      const s: any = await cloud.request(
        `/v1/tasks/${schema.string().uuid().parse(args.taskId)}`,
      );
      return {
        task: s.task,
        runs: s.runs,
        interactions: s.interactions,
        publication: s.publication,
        url: link(s.task.id),
      };
    },
  );
  register(
    "cloud_followup",
    "Queue another input on the same cloud session and workspace.",
    { taskId: taskParam, input: { type: "string", required: true } },
    async (args, key) => {
      const taskId = schema.string().uuid().parse(args.taskId);
      return {
        ...((await cloud.request(
          `/v1/tasks/${taskId}/inputs`,
          { input: args.input },
          key,
        )) as any),
        url: link(taskId),
      };
    },
  );
  register(
    "cloud_cancel",
    "Request cancellation of a cloud Run. Cancellation completes only after its Runner confirms all task processes stopped.",
    { runId: { type: "string", required: true } },
    async (args, key) =>
      cloud.request(
        `/v1/runs/${schema.string().uuid().parse(args.runId)}/cancel`,
        {},
        key,
      ),
  );
  register(
    "cloud_publish",
    "Create or update the task Draft PR from a specific saved result and workspace revision.",
    {
      taskId: taskParam,
      runId: { type: "string", required: true },
      workspaceRevision: { type: "string", required: true },
      allowFailedChecks: { type: "boolean" },
    },
    async (args, key) => {
      const taskId = schema.string().uuid().parse(args.taskId);
      return cloud.request(
        `/v1/tasks/${taskId}/publications`,
        {
          runId: args.runId,
          workspaceRevision: args.workspaceRevision,
          allowFailedChecks: args.allowFailedChecks ?? false,
        },
        key,
      );
    },
  );
}
