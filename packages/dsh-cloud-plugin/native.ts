import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-session-controller";
import type {} from "@deepseek-ai/dsh-session-projection";
import type {} from "@deepseek-ai/dsh-api-gateway";
import type {} from "@deepseek-ai/dsh-api-workspace-files";
import { RemoteError } from "@deepseek-ai/dsh-typert-protocol";
import { scopeTarget, createScope } from "@deepseek-ai/dsh-scope";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, posix } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { digest, TaskInputSchema } from "../contracts/index.ts";

type Request = <T = any>(path: string, body?: unknown, key?: string) => Promise<T>;
type Draft = { sessionId: string; createdAt: number; config: any };
type Entry = { task?: any; draft?: Draft; snapshot?: any; events: any[]; header?: any; historyLoaded?: boolean; loading?: Promise<void>; loadedAt?: number };
const activeStates = new Set(["queued", "preparing", "running", "waiting_input", "finalizing", "cancelling"]);
const fail = (message: string): never => { throw new RemoteError("gateway/bad-request", message, {}); };
const pause = (signal: AbortSignal, ms = 700) => sleep(ms, undefined, { signal }).catch(() => {});

/** Version-pinned adapter for DSH 0.2.1-rc.5 / 0.2.2-alpha.2. No local Agent or Session writer
 * is created. It routes the existing controller's cloud identities and leaves
 * all other identities to the original service. Native event storage stays exact;
 * RPC correlation is added only to detached browser projections. */
export class NativeCloudSessions {
  readonly entries = new Map<string, Entry>();
  private known = new Set<string>();
  private drafts = new Map<string, Draft>();
  private defaults: any = {};
  private pins = new Set<string>();
  private inspections = new Map<string, { at: number; promise: Promise<any> }>();
  private recovery = new Map<string, { previousRunId: string; acknowledgeUncertain: boolean }>();
  private modelName = "";
  private abort = new AbortController();
  private pending = new Map<string, AbortController>();
  private refreshPromise?: Promise<void>;
  private ready: Promise<void>;
  private lastList = 0;
  private lastInfo = 0;
  private generation = 0;
  private disposePatches: (() => void)[] = [];
  private writes = Promise.resolve();
  constructor(readonly ctx: Context, readonly request: Request, readonly file: string) {
    this.ready = readFile(file, "utf8").then(raw => {
      const data = JSON.parse(raw);
      this.defaults = data.defaults ?? {};
      this.pins = new Set(data.pins ?? []);
      for (const d of data.drafts ?? []) { this.drafts.set(d.sessionId, d); this.known.add(d.sessionId); this.entries.set(d.sessionId, { draft: d, events: [] }); }
      for (const id of data.known ?? []) this.known.add(id);
    }).catch((e: any) => { if (e.code !== "ENOENT") throw e; });
  }
  private save() {
    const body = JSON.stringify({ defaults: this.defaults, pins: [...this.pins], drafts: [...this.drafts.values()], known: [...this.known] });
    this.writes = this.writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(this.file + ".tmp", body, { mode: 0o600 });
      await rename(this.file + ".tmp", this.file);
    });
    return this.writes;
  }
  async owns(id: string) { await this.ready; if (this.known.has(id)) return true; await this.refresh().catch(() => {}); return this.known.has(id); }
  async refresh(force = false) {
    await this.ready;
    if (!force && Date.now() - this.lastList < 3000) return;
    const generation = this.generation;
    return this.refreshPromise ??= (async () => {
      const tasks = await this.request<any[]>("/v1/tasks");
      if (Date.now() - this.lastInfo >= 60000) {
        const info = await this.request<any>("/v1/info");
        if (generation !== this.generation || this.abort.signal.aborted) return;
        const modelName = typeof info.model === "string" ? info.model : info.model?.name ?? "";
        if (modelName !== this.modelName) {
          this.modelName = modelName;
          (this.ctx.emit as any)("llm/adapters-updated");
        }
        this.lastInfo = Date.now();
      }
      if (generation !== this.generation || this.abort.signal.aborted) return;
      this.lastList = Date.now();
      let changed = false;
      const visible = new Set<string>();
      for (const t of tasks) {
        visible.add(t.sessionId);
        const e = this.entries.get(t.sessionId) ?? { events: [] };
        const before = e.task && digest(e.task);
        e.task = t;
        if (e.draft) { this.drafts.delete(t.sessionId); e.draft = undefined; changed = true; }
        this.entries.set(t.sessionId, e);
        if (!this.known.has(t.sessionId)) { this.known.add(t.sessionId); changed = true; }
        if (before !== digest(t)) (this.ctx.emit as any)("api-session/added", this.summary(t.sessionId));
        // A Client may have opened its control stream before this plugin was
        // mounted. Running state therefore also follows the independent poll.
        (this.ctx.emit as any)("api-session/status", t.sessionId, !!t.currentRunId);
      }
      for (const [id, e] of this.entries) if (e.task && !visible.has(id)) { this.entries.delete(id); (this.ctx.emit as any)("api-session/removed", id); }
      if (changed) await this.save();
    })().finally(() => { this.refreshPromise = undefined; });
  }
  private async load(id: string, force = false): Promise<Entry> {
    await this.refresh();
    const e = this.entries.get(id);
    if (!e) fail("云端会话暂不可用，请在设置中检查登录和连接。");
    if (e!.draft) return e!;
    const unchanged = e!.snapshot?.task.version === e!.task.version && e!.snapshot?.task.durableSeq === e!.task.durableSeq;
    if (!force && e!.loadedAt && (Date.now() - e!.loadedAt < 2000 || unchanged)) {
      this.presentInteractions(id, e!);
      return e!;
    }
    const generation = this.generation;
    await (e!.loading ??= (async () => {
      const snapshot = await this.request(`/v1/tasks/${e!.task.id}`);
      if (generation !== this.generation || this.abort.signal.aborted) return;
      e!.snapshot = snapshot;
      e!.task = e!.snapshot.task;
      while (!e!.historyLoaded || (e!.events.at(-1)?.seq ?? -1) < e!.task.durableSeq) {
        const h = await this.request(`/v1/tasks/${e!.task.id}/history?after=${e!.events.at(-1)?.seq ?? -1}`);
        if (generation !== this.generation || this.abort.signal.aborted) return;
        if (h.header) e!.header = h.header;
        e!.historyLoaded = true;
        for (const event of h.events) {
          if (event.seq !== e!.events.length) fail("云端原生日志不连续，已停止同步。");
          e!.events.push(event);
        }
        if (!h.events.length || e!.events.length > h.durableSeq) break;
        if (this.abort.signal.aborted) break;
      }
      e!.loadedAt = Date.now();
      this.presentInteractions(id, e!);
    })().finally(() => { e!.loading = undefined; }));
    return e!;
  }
  private header(id: string, e: Entry) {
    return e.header ?? { version: 4, id, createdAt: e.draft?.createdAt ?? e.task.createdAt, cwd: "/workspace", isSeeded: false, delegationDepth: 0 };
  }
  private wireEvents(e: Entry) {
    const ids = new Map((e.snapshot?.runs ?? []).filter((r: any) => r.messageId && r.requestId).map((r: any) => [r.messageId, r.requestId]));
    const message = (m: any) => ids.has(m?.id) ? { ...m, source: { ...m.source, kind: "user", rpcId: ids.get(m.id) } } : m;
    return e.events.map(event => event.type === "user/message" ? { ...event, data: message(event.data) } : event.type === "agent/inbox/spliced" ? { ...event, data: { ...event.data, inserted: event.data.inserted.map(message) } } : event);
  }
  private projection(id: string, e: Entry) {
    const events = this.wireEvents(e);
    const restored = this.ctx.sessionProjections.restore({}, events as any, 0 as any, this.header(id, e), 0 as any).snapshot;
    const values: any = { ...restored.values, title: e.task?.title ?? "新云端会话", workingDirectory: "/workspace" };
    const model = e.snapshot?.modelRoute?.name ?? this.modelName;
    if (model) values.modelSelection = { lastUsed: values.modelSelection?.lastUsed ?? null, next: { provider: "dsh-cloud", model } };
    values.sessionListMetadata = { blank: !!e.draft, lastPromptAt: e.task?.updatedAt ?? null };
    // The UI inbox also includes control-plane inputs not yet admitted by DSH.
    const admitted = new Set(events.filter(v => v.type === "user/message").map(v => v.data.id));
    const queued = (e.snapshot?.runs ?? []).filter((r: any) => activeStates.has(r.state) && !admitted.has(r.messageId));
    values.inbox = { "next-turn": queued.map((r: any) => ({ id: r.messageId ?? r.id, role: "user", source: { kind: "user", ...(r.requestId ? { rpcId: r.requestId } : {}) }, content: [{ type: "text", text: r.input }] })), "next-step": [] };
    return { asOfSeq: events.length - 1, values };
  }
  private summary(id: string) {
    const e = this.entries.get(id)!;
    return { sessionId: id, agentAvailable: false, formatStatus: "current", updatedAt: e.task?.updatedAt ?? e.draft!.createdAt, running: e.task?.currentRunId != null, blank: !!e.draft, cwd: "/workspace", projections: { kind: "sequenced", ...this.projection(id, e) } };
  }
  async status() {
    await this.refresh(true);
    return { defaults: this.defaults, sessions: [...this.entries].map(([sessionId, e]) => ({ sessionId, taskId: e.task?.id, draft: !!e.draft, title: e.task?.title, runnerId: e.task?.runnerId ?? e.draft?.config.runnerId, runnerName: e.task?.runnerName, paused: !!e.task?.paused, environmentState: e.task?.environmentState, lifecycle: e.task?.lifecycle })) };
  }
  signOut() {
    this.generation++;
    for (const abort of this.pending.values()) abort.abort();
    this.pending.clear();
    for (const id of this.entries.keys()) (this.ctx.emit as any)("api-session/removed", id);
    this.entries.clear(); this.recovery.clear(); this.inspections.clear(); this.lastList = 0; this.lastInfo = 0;
  }
  async invoke(action: string, data: any = {}) {
    await this.ready;
    if (action === "status") return this.status();
    if (action === "defaults") { this.defaults = data; await this.save(); return { ok: true }; }
    if (action === "draft") {
      const config = TaskInputSchema.omit({ title: true, input: true, sessionId: true, requestId: true }).parse(data);
      const draft = { sessionId: crypto.randomUUID(), createdAt: Date.now(), config };
      this.defaults = config; this.drafts.set(draft.sessionId, draft); this.known.add(draft.sessionId);
      this.entries.set(draft.sessionId, { draft, events: [] });
      await this.save();
      (this.ctx.emit as any)("api-session/added", this.summary(draft.sessionId));
      return { sessionId: draft.sessionId };
    }
    if (action === "detail") { const e = await this.load(data.sessionId, true); return e.snapshot ?? { draft: e.draft }; }
    if (action === "recover") {
      const e = await this.load(data.sessionId, true);
      if (!e.task) fail("云端会话尚未开始。");
      if (e.task.currentRunId || e.task.environmentState === "needs_stop") fail("等待原执行停止后再恢复。");
      const prior = e.snapshot.runs.find((r: any) => r.id === e.task.recoveryRunId) ?? [...e.snapshot.runs].reverse().find((r: any) => ["interrupted", "uncertain", "cancelled", "failed"].includes(r.state));
      if (!prior || prior.id !== data.previousRunId) fail("请重新检查待恢复的执行记录。");
      if ((prior.state === "uncertain" || e.task.recoveryReason === "database_restore") && !data.acknowledgeUncertain) fail("请先确认外部操作结果可能不确定。");
      this.recovery.set(data.sessionId, { previousRunId: prior.id, acknowledgeUncertain: !!data.acknowledgeUncertain });
      return { armed: true };
    }
    fail("Unsupported native cloud operation");
  }
  async prompt(request: any) {
    const e = await this.load(request.sessionId);
    if (request.mode !== "queue") fail("云端按顺序执行输入；请用发送排队，或先停止当前执行。");
    if (request.content.some((part: any) => part.type !== "text")) fail("云端 MVP 目前支持文本输入。");
    const input = request.content.map((p: any) => p.text).join("\n");
    const accepted = e.snapshot?.runs.find((run: any) => run.requestId === request.requestId);
    if (accepted) { if (accepted.input !== input.trim()) fail("同一条输入的标识不能用于不同内容。"); return { accepted: true }; }
    if (e.draft) {
      await this.request("/v1/tasks", { ...e.draft.config, title: input.trim().slice(0, 120), input, sessionId: request.sessionId, requestId: request.requestId }, `native-create:${request.sessionId}`);
      await this.refresh(true);
    } else {
      const recovery = this.recovery.get(request.sessionId);
      await this.request(`/v1/tasks/${e.task.id}/inputs`, { input, requestId: request.requestId, ...(recovery ? { kind: "recovery", ...recovery } : {}) }, request.requestId);
      this.recovery.delete(request.sessionId);
    }
    await this.load(request.sessionId, true);
    return { accepted: true };
  }
  async cancel(id: string) {
    const e = await this.load(id, true);
    const run = e.snapshot?.runs.find((r: any) => r.id === e.task.currentRunId) ?? e.snapshot?.runs.find((r: any) => r.state === "queued");
    if (run) await this.request(`/v1/runs/${run.id}/cancel`, {}, `native-cancel:${run.id}`);
    return { accepted: true };
  }
  /** Owner file reads go through the Runner's confined snapshot operation. */
  async inspect(id: string, action: "files" | "diff", path?: string, signal = this.abort.signal) {
    const e = await this.load(id);
    if (!e.task) return { files: [], truncated: false };
    const key = id + ":" + action + ":" + (path ?? "");
    const old = this.inspections.get(key);
    if (old && Date.now() - old.at < 1200) return old.promise;
    const promise = (async () => {
      const op = await this.request(`/v1/tasks/${e.task.id}/${action}${path === undefined ? "" : "?path=" + encodeURIComponent(path)}`);
      if (op.offline) fail("执行节点离线，文件预览暂不可用。");
      for (let n = 0; n < 90; n++) {
        signal.throwIfAborted();
        const result = await this.request(`/v1/operations/${op.operationId}`);
        if (result.state === "succeeded") return result.result;
        if (["failed", "unknown"].includes(result.state)) fail(result.result?.error ?? "云端文件读取失败。");
        await pause(signal, 500);
      }
      fail("云端文件读取超时，请重试。");
    })();
    this.inspections.set(key, { at: Date.now(), promise });
    promise.catch(() => { if (this.inspections.get(key)?.promise === promise) this.inspections.delete(key); });
    return promise;
  }
  private cloudPath(path: string, base?: string) {
    if (path.includes("\0") || path.includes("\\") || /^[a-z][a-z\d+.-]*:/i.test(path)) fail("Invalid cloud workspace path");
    const absolute = posix.resolve(base ? posix.dirname(posix.resolve("/workspace", base)) : "/workspace", path);
    if (absolute !== "/workspace" && !absolute.startsWith("/workspace/")) fail("Path escapes the cloud workspace");
    return absolute.slice("/workspace/".length);
  }
  private patch(service: any, name: string, make: (original: any) => any) {
    const original = service?.[name];
    if (typeof original !== "function") return;
    const wrapped = make(original.bind(service)); service[name] = wrapped;
    this.disposePatches.push(() => { if (service[name] === wrapped) service[name] = original; });
  }
  private mountFiles() {
    const service = this.ctx.get?.("workspaceFiles" as any) as any;
    const lookup = this.ctx.typert?.lookups.get("workspaceFileScope");
    if (!service || !lookup) return;
    this.disposePatches.push(this.ctx.typert.lookups.configure("workspaceFileScope", async (id: any) => await this.owns(id) ? { sessionId: id, workspaceRoot: "/workspace" } : await lookup.resolve(id) as any));
    for (const method of ["read", "readBytes", "stat", "list"]) this.patch(service, method, original => async (scope: any, path: string, ...args: any[]) => {
      if (!await this.owns(scope.sessionId)) return original(scope, path, ...args);
      const relative = this.cloudPath(path, method === "readBytes" ? args[0]?.baseFile : undefined);
      if (method === "list") {
        const result = await this.inspect(scope.sessionId, "files");
        const entries = new Map<string, any>(), prefix = relative ? relative + "/" : "";
        for (const file of result.files) {
          if (!file.path.startsWith(prefix)) continue;
          const remainder = file.path.slice(prefix.length), parts = remainder.split("/");
          entries.set(parts[0], parts.length > 1 ? { name: parts[0], type: "directory" } : { name: parts[0], type: file.symlink ? "other" : "file", size: file.size });
        }
        return { path: relative, entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)), truncated: result.truncated };
      }
      const file = await this.inspect(scope.sessionId, "files", relative), stat = { absolutePath: "/workspace/" + relative, version: file.hash, bytes: file.size };
      if (method === "stat") return stat;
      if (method === "readBytes") {
        const data = Buffer.from(file.content, file.encoding === "base64" ? "base64" : "utf8"), range = args[0]?.range, offset = range?.offset ?? 0, length = range?.length ?? data.length;
        if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1) fail("Invalid byte range");
        return { ...stat, offset, data: new Uint8Array(data.subarray(offset, offset + length)), eof: offset + length >= data.length };
      }
      if (file.encoding !== "utf8") fail("此文件不是文本，不能显示文本预览。");
      const offset = args[0]?.offset ?? 1, limit = args[0]?.limit ?? 1000;
      if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10000) fail("Invalid line range");
      const lines = file.content.split("\n"); if (lines.at(-1) === "") lines.pop();
      const page = lines.slice(offset - 1, offset - 1 + limit);
      return { ...stat, offset, text: page.join("\n"), lines: page.length, eof: offset - 1 + limit >= lines.length };
    });
    const self = this;
    this.patch(service, "changes", original => async function*(scope: any, path: string, signal: AbortSignal) {
      if (!await self.owns(scope.sessionId)) { yield* original(scope, path, signal); return; }
      const relative = self.cloudPath(path); let revision: string | null | undefined;
      yield { kind: "ready" };
      while (!signal.aborted && !self.abort.signal.aborted) {
        const e = await self.load(scope.sessionId);
        if (revision !== e.task?.workspaceRevision) { revision = e.task?.workspaceRevision; if (revision) yield { kind: "change", change: { absolutePath: "/workspace/" + relative, version: revision } }; }
        await pause(signal, 2000);
      }
    });
  }
  private workspaceSets(value: any) {
    return { ...value, archivedSessionIds: [...new Set([...(value.archivedSessionIds ?? []).filter((id: string) => !this.known.has(id)), ...[...this.entries].filter(([, e]) => e.task?.lifecycle === "archived").map(([id]) => id)])], pinnedSessionIds: [...new Set([...this.pins].filter(id => this.entries.has(id) && this.entries.get(id)?.task?.lifecycle !== "archived").concat((value.pinnedSessionIds ?? []).filter((id: string) => !this.known.has(id))))] };
  }
  private mountWorkspace() {
    const service = this.ctx.get?.("workspaceController" as any) as any;
    if (!service) return;
    for (const method of ["archiveSession", "unarchiveSession", "pinSession", "unpinSession"]) this.patch(service, method, original => async (r: any) => {
      if (!await this.owns(r.sessionId)) return original(r);
      const e = await this.load(r.sessionId, true);
      if (method === "pinSession") this.pins.add(r.sessionId);
      else if (method === "unpinSession") this.pins.delete(r.sessionId);
      else if (e.task) {
        if (e.task.currentRunId) fail("请先停止云端执行，再归档会话。");
        await this.request(`/v1/tasks/${e.task.id}/lifecycle`, { action: method === "archiveSession" ? "archive" : "reopen" });
        if (method === "archiveSession") this.pins.delete(r.sessionId);
        await this.refresh(true);
      } else if (method === "archiveSession") { this.drafts.delete(r.sessionId); this.entries.delete(r.sessionId); (this.ctx.emit as any)("api-session/removed", r.sessionId); }
      await this.save();
      const registry: any = this.ctx.get("workspaceRegistry" as any);
      const value = this.workspaceSets({ archivedSessionIds: registry.archivedSessionIds, pinnedSessionIds: registry.pinnedSessionIds });
      return method.includes("pin") || method === "pinSession" ? { pinnedSessionIds: value.pinnedSessionIds } : { archivedSessionIds: value.archivedSessionIds };
    });
    const self = this;
    this.patch(service, "follow", original => async function*(signal: AbortSignal) {
      const iterator = original(signal)[Symbol.asyncIterator](); let next = iterator.next().then((value: any) => ({ value })), latest: any = {}, old = "";
      try {
        while (!signal.aborted && !self.abort.signal.aborted) {
          const r: any = await Promise.race([next, pause(signal, 1000).then(() => ({ tick: true }))]);
          if (r.value) {
            if (r.value.done) return;
            const frame = r.value.value;
            if (["baseline", "replace"].includes(frame.type)) { await self.refresh().catch(() => {}); latest = frame.value; yield { ...frame, value: self.workspaceSets(latest) }; }
            else if (["archived", "pinned"].includes(frame.type)) { latest = { ...latest, ...frame }; const v = self.workspaceSets(latest); yield frame.type === "archived" ? { type: "archived", archivedSessionIds: v.archivedSessionIds } : { type: "pinned", pinnedSessionIds: v.pinnedSessionIds }; }
            else yield frame;
            next = iterator.next().then((value: any) => ({ value }));
          } else {
            const v = self.workspaceSets(latest), hash = digest([v.archivedSessionIds, v.pinnedSessionIds]);
            if (old !== hash) { old = hash; yield { type: "archived", archivedSessionIds: v.archivedSessionIds }; yield { type: "pinned", pinnedSessionIds: v.pinnedSessionIds }; }
          }
        }
      } finally { void iterator.return?.(); }
    });
  }
  private page(e: Entry, request: any) {
    const events = this.wireEvents(e), cursor = request.throughSeq ?? events.length - 1;
    if (cursor > events.length - 1) fail("History cursor is ahead of the cloud checkpoint");
    const end = Math.min(cursor + 1, request.beforeSeq ?? cursor + 1);
    let start = 0, count = 0, turns = 0;
    for (let i = end - 1; i >= 0; i--) {
      const v = events[i];
      if (v.type === "turn/start" && request.turnWindow && ++turns >= request.turnWindow.minTurns && count >= request.turnWindow.minMessages) { start = i; break; }
      if ((v.type === "user/message" || v.type === "assistant/message") && v.surfaceOp === "append" && ++count >= (request.maxMessages ?? 50)) { start = Math.min(i, ...(v.sourceEventSeqs ?? [i])); break; }
    }
    return { cursor, records: events.slice(start, end).map(event => ({ type: "event", event })), hasMore: start > 0 };
  }
  async *follow(request: any, signal: AbortSignal) {
    const id = request.address.sessionId, e = await this.load(id, true), page = this.page(e, request);
    let cursor = page.cursor;
    yield { type: "snapshot", header: this.header(id, e), ...page, projections: this.projection(id, e), ...(request.assistantStream ? { assistantStream: { revision: 0 } } : {}) };
    while (!signal.aborted && !this.abort.signal.aborted) {
      await pause(signal, 2000);
      if (signal.aborted) return;
      // A control-service outage does not tear down the local DSH connection.
      // Retain the cursor and retry; never reconstruct or replay a prompt.
      let latest: Entry;
      try { latest = await this.load(id); } catch { continue; }
      for (const event of this.wireEvents(latest).filter(v => v.seq > cursor)) { yield { type: "event", event }; cursor = event.seq; }
    }
  }
  async *control(original: AsyncIterable<any>, signal: AbortSignal) {
    const iterator = original[Symbol.asyncIterator]();
    let next = iterator.next().then(value => ({ value })), old = new Map<string, string>();
    try {
      while (!signal.aborted && !this.abort.signal.aborted) {
        const result: any = await Promise.race([next, pause(signal).then(() => ({ tick: true }))]);
        if (result.value) {
          if (result.value.done) return;
          const frame = result.value.value;
          if (frame.type === "baseline") {
            await this.refresh().catch(() => {});
            const projections = { ...frame.value.projections };
            for (const [id, e] of this.entries) projections[id] = this.projection(id, e);
            yield { ...frame, value: { projections } };
          } else yield frame;
          next = iterator.next().then(value => ({ value }));
        } else {
          await this.pollActive();
          for (const [id, e] of this.entries) {
            const p = this.projection(id, e);
            for (const [key, value] of Object.entries(p.values)) {
              const index = id + ":" + key, hash = digest(value);
              if (old.get(index) !== hash) { old.set(index, hash); yield { type: "projection", sessionId: id, key, value, seq: p.asOfSeq }; }
            }
            (this.ctx.emit as any)("api-session/status", id, !!e.task?.currentRunId);
          }
        }
      }
    } finally { void iterator.return?.(); }
  }
  private async pollActive() {
    await this.refresh().catch(() => {});
    for (const [id, e] of this.entries) {
      if (e.task?.currentRunId || (e.snapshot && (e.snapshot.task.version !== e.task?.version || e.snapshot.task.durableSeq !== e.task?.durableSeq)))
        await this.load(id).catch(() => {});
    }
  }
  private presentInteractions(id: string, e: Entry) {
    const live = new Set((e.snapshot?.interactions ?? []).filter((i: any) => i.state === "pending").map((i: any) => i.id));
    for (const [key, abort] of this.pending) if (key.startsWith(id + ":") && !live.has(key.slice(id.length + 1))) { abort.abort(); this.pending.delete(key); }
    if (!this.ctx.typertGateway.hasLiveClient()) return;
    for (const item of e.snapshot?.interactions ?? []) {
      const key = id + ":" + item.id;
      if (item.state !== "pending" || this.pending.has(key)) continue;
      const abort = new AbortController(); this.pending.set(key, abort);
      // Routing-only identity for the existing Remote Event carrier. This is
      // never registered as an Agent and has no model, runtime or Session writer.
      const reference: any = { id };
      const scope = createScope(this.ctx, reference); reference.ctx = scope.ctx;
      const request = { agent: reference, signal: abort.signal, ...(item.kind === "question" ? { questions: item.body.questions } : { toolName: item.body.toolName, callId: item.body.callId, reason: item.body.reason }) };
      void (async () => {
        try {
          const answer = await (this.ctx.waterfall as any)(scopeTarget(reference, reference), item.kind === "question" ? "user-questions/request" : "approval/request", request, async () => { throw new Error("No answering client"); });
          if (!abort.signal.aborted) await this.request(`/v1/interactions/${item.id}/answers`, { version: item.version, answer: item.kind === "question" ? answer : { outcome: answer } }, `native-answer:${item.id}:${item.version}`);
        } catch { /* Disconnected/stale answers never become grants. Re-present on reconnect. */ }
        finally { abort.abort(); await scope.dispose(); this.pending.delete(key); }
      })();
    }
  }
  mount() {
    this.mountFiles(); this.mountWorkspace();
    const controller: any = this.ctx.sessionController;
    const patch = (name: string, make: (original: any) => any) => {
      const original = controller[name];
      if (typeof original !== "function") return; // rc.5 has page, but no events/state aliases.
      const wrapped = make(original.bind(controller)); controller[name] = wrapped;
      this.disposePatches.push(() => { if (controller[name] === wrapped) controller[name] = original; });
    };
    patch("list", original => async (...args: any[]) => { const local = await original(...args); await this.refresh().catch(() => {}); return { ...local, items: [...local.items, ...[...this.entries.keys()].map(id => this.summary(id))] }; });
    patch("create", original => async (r: any) => { if (r.sessionId && await this.owns(r.sessionId)) return { sessionId: r.sessionId }; return original(r); });
    patch("modelCatalog", original => async () => {
      const local = await original();
      await this.refresh().catch(() => {});
      const names = [...new Set([this.modelName, ...[...this.entries.values()].map(e => e.snapshot?.modelRoute?.name)].filter(Boolean))];
      return names.length ? { ...local, routableProviders: [...local.routableProviders, "dsh-cloud"], groups: [...local.groups, { id: "dsh-cloud", name: "云端固定模型", models: names.map(id => ({ id, name: id, description: "仅用于云端会话；模型在创建后固定。" })) }] } : local;
    });
    for (const method of ["prompt", "cancel", "events", "page", "projections", "state", "updateQueue", "rename", "fork", "selectModel", "attachment", "resolveAgent"]) patch(method, original => async (...args: any[]) => {
      const r = args[0], id = typeof r === "string" ? r : r.sessionId ?? r.address?.sessionId;
      if (!id || !await this.owns(id)) { if (method === "selectModel" && r.provider === "dsh-cloud") fail("请在输入框的执行位置中选择云端，不能为本机会话选择云端模型。"); return original(...args); }
      if (method === "prompt") return this.prompt(r);
      if (method === "cancel") return this.cancel(id);
      const e = await this.load(id);
      if (method === "rename") {
        if (e.draft) fail("发送第一条消息后可重命名云端会话。");
        await this.request(`/v1/tasks/${e.task.id}/title`, { title: r.title }); await this.refresh(true); return { title: r.title };
      }
      if (method === "events" || method === "page") return this.page(e, r);
      if (method === "projections") return { kind: "sequenced", ...this.projection(id, e) };
      if (method === "state") return { cursor: e.events.length - 1, active: !!e.task?.currentRunId, running: !!e.task?.currentRunId, queue: [], pendingInput: (e.snapshot?.interactions ?? []).filter((i: any) => i.state === "pending").map((i: any) => i.kind) };
      if (method === "updateQueue" && r.action.kind === "remove") { const run = e.snapshot.runs.find((v: any) => v.id === r.itemId || v.messageId === r.itemId); if (run?.state === "queued") { await this.request(`/v1/runs/${run.id}/cancel`, {}, `native-cancel:${run.id}`); return { accepted: true }; } }
      fail("此操作暂不适用于云端会话。会话的模型、执行位置和工作区在创建后固定。");
    });
    patch("follow", original => async function*(this: NativeCloudSessions, r: any, signal: AbortSignal) { if (await this.owns(r.address.sessionId)) yield* this.follow(r, signal); else yield* original(r, signal); }.bind(this));
    patch("control", original => (signal: AbortSignal) => this.control(original(signal), signal));
    // Retained Host identities must never fall through to local activation, even
    // while the cloud service is offline or after device-token revocation.
    const tick = async () => { while (!this.abort.signal.aborted) { await this.refresh().catch(() => {}); await pause(this.abort.signal, 1500); } };
    void tick();
    return () => { this.abort.abort(); for (const a of this.pending.values()) a.abort(); for (const dispose of this.disposePatches.reverse()) dispose(); };
  }
}
