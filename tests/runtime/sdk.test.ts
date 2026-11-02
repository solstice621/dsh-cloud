import { parse, stringify } from "yaml";
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  realpath,
} from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  writeRuntimePatch,
  makeHarness,
  checkpoint,
} from "../../apps/executor/runtime.ts";
import { modelFixture } from "../model-fixture.ts";
import { template } from "../helpers.ts";
import { id, type ExecutorConfig } from "../../packages/contracts/index.ts";

test(
  "real DSH writes and reads the same workspace, asks a question, then resumes its native session",
  { timeout: 180000 },
  async () => {
    const root = await mkdtemp(resolve(tmpdir(), "dsh-cloud-sdk-")),
      marker = "marker-" + id();
    let questions = 0,
      approvals = 0;
    const model = await modelFixture((body, n) => {
      const replies = [
        {
          tool: "write",
          input: {
            file_path: "marker.txt",
            content: marker,
            sandbox_permissions: "workspace-write",
            justification:
              "Create the requested marker in this temporary test workspace.",
          },
        },
        { tool: "read", input: { file_path: "marker.txt" } },
        {
          tool: "bash",
          input: {
            description: "Verify the test marker through the real shell tool",
            command: "test -s marker.txt && printf shell-ok",
          },
        },
        {
          tool: "ask_user_question",
          input: {
            questions: [
              {
                id: "choice",
                question: "Keep this marker?",
                options: [{ label: "Keep" }],
              },
            ],
          },
        },
        { text: "Marker persisted and question answered." },
        { tool: "read", input: { file_path: "marker.txt" } },
        { text: "The original marker is still present." },
      ];
      assert.ok(
        n < replies.length,
        "Unexpected model loop: " + JSON.stringify(body.messages.at(-1)),
      );
      if (n === 2 || n === 6)
        assert.match(JSON.stringify(body.messages), new RegExp(marker));
      return replies[n]! as any;
    });
    const config: ExecutorConfig = {
      controlUrl: model.url,
      token: "fixture-token",
      task: { sessionId: id() } as any,
      template,
      epoch: 1,
      incarnation: id(),
      workspace: resolve(root, "workspace"),
      dshHome: resolve(root, "home"),
      stateDir: resolve(root, "state"),
      model: "fixture",
      modelBaseUrl: model.url,
      patchPath: resolve(root, "runtime.yml"),
    };
    await mkdir(config.workspace);
    await mkdir(config.stateDir);
    await writeRuntimePatch(config);
    const patch = parse(await readFile(config.patchPath, "utf8"));
    patch.find((p: any) => p.id === "permission").config.presets.cloud.sandbox =
      "read-only";
    patch.find((p: any) => p.id === "sandbox-policy").config.mode = "read-only";
    await writeFile(config.patchPath, stringify(patch));
    const create = () => {
      const h = makeHarness(config, {
        onUserQuestion: async (q) => {
          questions++;
          return {
            answers: q.questions.map((x) => ({ id: x.id, selected: ["Keep"] })),
          };
        },
      });
      h.client.start();
      h.client.onRequest(async (method) => {
        assert.equal(method, "approval/request");
        approvals++;
        return { outcome: "allowed-once" };
      });
      return h;
    };
    let h = create();
    try {
      await h.start();
      await h
        .session(config.task.sessionId)
        .setWorkingDirectory(config.workspace);
      await h.client.prompt(config.task.sessionId, [
        { type: "text", text: "Create a marker and ask whether to keep it." },
      ]);
      await h.client.request("session/wait", {
        sessionId: config.task.sessionId,
      });
      const first = await checkpoint(
        resolve(config.stateDir, "runtime.sock"),
        config.task.sessionId,
      );
      assert.equal(
        await readFile(resolve(config.workspace, "marker.txt"), "utf8"),
        marker,
      );
      assert.equal(questions, 1);
      assert.equal(approvals, 1);
      assert.match(JSON.stringify(first.events), /shell-ok/);
      assert.ok(
        first.events.some(
          (e) => e.type === "turn/end" && e.data.reason.kind === "completed",
        ),
      );
      await h.close();
      h = create();
      await h.start();
      await h.resumeSession(config.task.sessionId);
      assert.equal(
        await realpath(
          await h.session(config.task.sessionId).getWorkingDirectory(),
        ),
        await realpath(config.workspace),
      );
      await h.client.prompt(config.task.sessionId, [
        { type: "text", text: "Read the original marker again." },
      ]);
      await h.client.request("session/wait", {
        sessionId: config.task.sessionId,
      });
      const next = await checkpoint(
        resolve(config.stateDir, "runtime.sock"),
        config.task.sessionId,
      );
      assert.deepEqual(next.events.slice(0, first.events.length), first.events);
      assert.ok(next.durableSeq > first.durableSeq);
      assert.equal(model.requests.length, 7);
      console.log(
        JSON.stringify({
          realRuntime: true,
          sessionId: config.task.sessionId,
          durableSeq: next.durableSeq,
          questions,
          approvals,
          modelCalls: model.requests.length,
        }),
      );
    } catch (error) {
      console.error("Runtime stderr:", (h.client as any).stderrTail);
      throw error;
    } finally {
      await h.close();
      await model.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
