import { test } from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import ToolsService, {
  assertObjectJsonSchema,
  validateJsonSchemaValue,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { registerCloudTools } from "../packages/dsh-cloud-plugin/index.ts";

const taskId = "00000000-0000-4000-8000-000000000001";
const runId = "00000000-0000-4000-8000-000000000002";
const validArgs: Record<string, Record<string, unknown>> = {
  cloud_start: {
    title: "Schema regression", runnerId: taskId, templateId: "test",
    templateVersion: "1", repo: "https://github.com/example/project.git",
    ref: "main", input: "Check the workspace",
  },
  cloud_list: {},
  cloud_get: { taskId },
  cloud_followup: { taskId, input: "Continue" },
  cloud_cancel: { runId },
  cloud_publish: { taskId, runId, workspaceRevision: "revision" },
};

function registry() {
  const ctx = new Context();
  ctx.provide("systemPrompt", { tools: () => () => {} });
  const tools = new ToolsService(ctx);
  const requests: Array<{ path: string; body?: unknown; key?: string }> = [];
  registerCloudTools(ctx, {
    url: "https://cloud.example",
    async request(path, body, key) {
      requests.push({ path, body, key });
      if (path === "/v1/tasks" && body) return { taskId };
      if (["/v1/tasks", "/v1/runners", "/v1/templates"].includes(path)) return [];
      if (path === `/v1/tasks/${taskId}`) return { task: { id: taskId }, runs: [], interactions: [], publication: null };
      return { ok: true };
    },
  });
  return { ctx, tools, requests };
}

test("all six registered Cloud tools expose valid object-rooted JSON Schema", async () => {
  const { ctx, tools } = registry();
  try {
    const schemas = tools.schemas();
    assert.deepEqual(schemas.map(tool => tool.name).sort(), Object.keys(validArgs).sort());
    for (const tool of schemas) {
      assertObjectJsonSchema(tool.parameters);
      assert.deepEqual(validateJsonSchemaValue(tool.parameters, validArgs[tool.name]), [], tool.name);
      assert.ok(tool.parameters.properties, `${tool.name}: even a no-argument tool needs an object schema`);
      for (const name of (tool.parameters.required ?? []) as string[]) {
        const args = { ...validArgs[tool.name] };
        delete args[name];
        assert.ok(validateJsonSchemaValue(tool.parameters, args).length > 0, `${tool.name}.${name}`);
      }
    }
  } finally { await ctx.fiber.dispose(); }
});

test("invalid Cloud arguments are rejected before any remote request", async () => {
  const { ctx, tools, requests } = registry();
  try {
    const invalid = [
      ["cloud_start", { ...validArgs.cloud_start, deliveryPolicy: "publish-immediately" }],
      ["cloud_list", "not an object"],
      ["cloud_get", {}],
      ["cloud_followup", { taskId, input: 7 }],
      ["cloud_cancel", {}],
      ["cloud_publish", { ...validArgs.cloud_publish, allowFailedChecks: "yes" }],
    ] as const;
    for (const [name, args] of invalid) {
      await assert.rejects(
        tools.get(name)!.execute(args, { callId: "schema-test" } as ToolRunContext),
        error => error instanceof Error && error.name === "ToolArgsError",
        name,
      );
    }
    assert.equal(requests.length, 0);
  } finally { await ctx.fiber.dispose(); }
});

test("compiled tools preserve valid operations, output rendering and effect cleanup", async () => {
  const { ctx, tools, requests } = registry();
  try {
    for (const [name, args] of Object.entries(validArgs)) {
      const tool = tools.get(name)!;
      const value = await tool.execute(args, { callId: "schema-test" } as ToolRunContext);
      assert.deepEqual(validateJsonSchemaValue(tool.output.schema, value), [], name);
      const result = value as { summary: string };
      assert.deepEqual(tool.output.render(args, result), [{ type: "text", text: result.summary }]);
    }
    assert.deepEqual(requests.map(request => request.path), [
      "/v1/tasks", "/v1/tasks", "/v1/runners", "/v1/templates",
      `/v1/tasks/${taskId}`, `/v1/tasks/${taskId}/inputs`,
      `/v1/runs/${runId}/cancel`, `/v1/tasks/${taskId}/publications`,
    ]);
    assert.ok(requests.filter(request => request.body !== undefined).every(request => request.key === "schema-test"));
  } finally { await ctx.fiber.dispose(); }
  assert.equal(tools.schemas().length, 0);
});
