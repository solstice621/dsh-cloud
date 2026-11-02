import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ControlService } from "../apps/control/server.ts";
import {
  TemplateSchema,
  DSH_VERSION,
  PROTOCOL,
  id,
} from "../packages/contracts/index.ts";

export const template = TemplateSchema.parse({
  id: "test",
  version: "1",
  image: "dsh-cloud-runtime:0.1.1",
  platforms: ["linux/amd64", "linux/arm64"],
  timeoutSeconds: 120,
  maxModelCalls: 12,
  maxOutputTokens: 1024,
});
export async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "dsh-cloud-test-"));
  const owner = "test-owner-key-abcdefghijklmnopqrstuvwxyz";
  const service = new ControlService({
    host: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1:0",
    database: resolve(root, "control.sqlite"),
    webRoot: resolve("dist/web"),
    ownerId: "owner",
    development: true,
    devToken: owner,
    model: {
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test-model",
      name: "fixture",
    },
    templates: [template],
    allowedRepoHosts: ["github.com"],
  });
  await service.listen();
  const address = service.server.address() as { port: number };
  service.config.port = address.port;
  service.config.publicUrl = `http://127.0.0.1:${address.port}`;
  const request = async (
    path: string,
    body?: unknown,
    token = owner,
    key: string = id(),
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(service.config.publicUrl + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined
          ? {}
          : { "content-type": "application/json", "idempotency-key": key }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()) as any };
  };
  const pair = await request("/v1/runner-pairings", {});
  const pairing = {
    code: pair.data.code,
    name: "Fixture Runner",
    platform: "linux/arm64",
    protocol: PROTOCOL,
    dshVersion: DSH_VERSION,
  };
  const registered = await request("/v1/runner-pairings/complete", pairing, "");
  const runner = registered.data;
  const create = (input = "Create a marker", key = id()) =>
    request(
      "/v1/tasks",
      {
        title: "Persistent task",
        runnerId: runner.runnerId,
        templateId: template.id,
        templateVersion: template.version,
        repo: "https://github.com/example/project.git",
        ref: "main",
        baseBranch: "main",
        input,
        deliveryPolicy: "results",
      },
      owner,
      key,
    );
  const start = async (taskId: string) => {
    const lease = await request(
      `/v1/runner/environments/${taskId}/start`,
      {
        operationId: id(),
        previousEpoch: service.store.task(taskId).epoch,
        previousContainerStopped: true,
      },
      runner.token,
    );
    const e = lease.data;
    await request(
      "/v1/executor/hello",
      {
        protocol: PROTOCOL,
        dshVersion: DSH_VERSION,
        journalRunId: null,
        phase: "idle",
      },
      e.token,
    );
    return e;
  };
  return {
    root,
    service,
    owner,
    request,
    runner,
    pairing,
    create,
    start,
    close: async () => {
      await service.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
