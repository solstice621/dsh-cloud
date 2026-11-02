import React, { useEffect, useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-gateway/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import { remote } from "./remote.ts";
import { canChooseLocation, CloudIcon, LocationPicker } from "./location.tsx";

export const inject = ["remote", "slots", "sessions", "uiWorkspace", "conversation"];
const css = `.dsh-cloud-native{color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.dsh-cloud-native button,.dsh-cloud-native input,.dsh-cloud-native select{font:inherit;color:inherit}.dsh-cloud-native button{cursor:pointer;border:0;border-radius:var(--dsw-radius-md,8px);padding:6px 9px;background:transparent}.dsh-cloud-native button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-cloud-native button:disabled{opacity:.45;cursor:default}.dsh-cloud-native input,.dsh-cloud-native select{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-main,#8885);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);padding:8px}.dsh-cloud-native label{display:grid;gap:6px;margin:12px 0}.dsh-cloud-native small{color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-cloud-native p{margin:10px 0;line-height:1.6}.dsh-cloud-native .cloud-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-cloud-native .cloud-error{color:var(--dsw-alias-status-error,#c44)}.dsh-cloud-native .cloud-popover{position:absolute;bottom:calc(100% + 8px);left:0;min-width:160px;width:max-content;max-width:min(340px,80vw);max-height:65vh;overflow:auto;padding:6px;box-shadow:var(--dsw-elevation-prominent,0 8px 28px #0003);border:1px solid var(--dsw-alias-border-main,#8884);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);z-index:80}.dsh-cloud-native.cloud-location{position:relative}.dsh-cloud-native .cloud-location-trigger{display:inline-flex;align-items:center;gap:6px;height:28px;padding:4px 7px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}.dsh-cloud-native button:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.dsh-cloud-native .cloud-location-options{display:grid;gap:2px}.dsh-cloud-native .cloud-location-options button{display:flex;align-items:center;gap:8px;text-align:left;padding:8px}.dsh-cloud-native .cloud-location-options button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover)}.dsh-cloud-native .cloud-location-check{margin-left:auto;font-size:12px}.dsh-cloud-native .cloud-location-setup{width:min(300px,70vw);padding:8px;border-top:1px solid var(--dsw-alias-border-main,#8883);margin-top:6px}.dsh-cloud-native .cloud-line{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-main,#8883)}.dsh-cloud-native a{color:inherit;text-decoration:underline}.dsh-cloud-native pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace;max-height:260px;overflow:auto}`;
type Api = (payload: any) => Promise<any>;
type State = { sessions: any[]; defaults: any; runners: any[]; templates: any[]; signedIn: boolean; error?: string; info?: any };

export function apply(ctx: Context) {
  ctx.effect(async () => {
    const unmount = await ctx.remote.$mount(remote);
    const scope = await ctx.inject(["remote.cloud"], ctx => {
      const sessions = ctx.sessions as unknown as ISessions;
      const invoke: Api = async payload => { const wire = await ctx.remote.cloud.invoke(JSON.stringify(payload)); if (!wire.ok) throw new Error(wire.error.message); const r = JSON.parse(wire.value); if (!r.ok) throw Object.assign(new Error(r.error.message), r.error); return r.value; };
      const request = (path: string, body?: any) => invoke({ op: "request", path, ...(body === undefined ? {} : { body }) });
      let state: State = { sessions: [], defaults: {}, runners: [], templates: [], signedIn: false };
      const listeners = new Set<() => void>();
      let stopped = false, refreshing = false;
      const set = (update: Partial<State>) => { state = { ...state, ...update }; listeners.forEach(fn => fn()); };
      const useCloud = () => useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => state);
      const refresh = async () => {
        if (refreshing || stopped) return; refreshing = true;
        try {
          const [native, runners, templates, info] = await Promise.all([invoke({ op: "native", action: "status" }), request("/v1/runners"), request("/v1/templates"), request("/v1/info")]);
          if (JSON.stringify(info.model) !== JSON.stringify(state.info?.model)) (ctx.get("modelDirectories" as any) as any)?.catalog?.refresh();
          set({ ...native, runners: runners.filter((r: any) => !r.revoked), templates, info, signedIn: true, error: undefined });
        } catch (e: any) { set({ signedIn: false, error: e.message }); }
        finally { refreshing = false; }
      };
      void refresh(); const timer = setInterval(() => void refresh(), 2000);
      const actions = async (fn: () => Promise<any>, setError: (text: string) => void) => { setError(""); try { await fn(); await refresh(); } catch (e: any) { setError(e.message); } };
      const carry = async (from: any, to: any) => {
        const current = sessions.scope(from), input = current ? ctx.conversation.input.for(current).state.getSnapshot() : undefined;
        if (input?.attachmentIds.length) throw new Error("切换执行位置前请移除附件；云端 MVP 支持文本输入。");
        const ref = sessions.retain(to, { source: "workspaceOperation" });
        try { const binding = await ref.ready; ctx.conversation.input.requestDraftInitialization(binding, { prompt: input?.draft, whenDraftExists: "replace" }); ctx.uiWorkspace.openSession(to); } finally { ref.release(); }
      };
      function Configuration({ initial, onSubmit, submitLabel }: { initial: any; onSubmit: (config: any) => Promise<void>; submitLabel: string }) {
        const s = useCloud(), [form, setForm] = useState({ runnerId: initial.runnerId ?? s.runners[0]?.id ?? "", template: initial.templateId ? `${initial.templateId}@${initial.templateVersion}` : (s.templates[0] ? `${s.templates[0].id}@${s.templates[0].version}` : ""), repo: initial.repo ?? "", ref: initial.ref ?? "main", baseBranch: initial.baseBranch ?? "main" }), [error, setError] = useState(""), [busy, setBusy] = useState(false);
        return <form onSubmit={e => { e.preventDefault(); setBusy(true); void actions(async () => { const t = s.templates.find((t: any) => `${t.id}@${t.version}` === form.template); if (!t) throw new Error("请选择执行环境"); await onSubmit({ runnerId: form.runnerId, templateId: t.id, templateVersion: t.version, repo: form.repo, ref: form.ref, baseBranch: form.baseBranch, deliveryPolicy: "results" }); }, setError).finally(() => setBusy(false)); }}>
          <label>执行节点<select value={form.runnerId} onChange={e => setForm({ ...form, runnerId: e.target.value })} required><option value="" disabled>选择节点</option>{s.runners.map((r: any) => <option key={r.id} value={r.id}>{r.name} · {Date.now() - r.lastSeenAt < 45000 ? "在线" : "离线"}</option>)}</select></label>
          <label>执行环境<select value={form.template} onChange={e => setForm({ ...form, template: e.target.value })} required>{s.templates.map((t: any) => <option key={`${t.id}@${t.version}`}>{t.id}@{t.version}</option>)}</select></label>
          <label>Git 仓库<input value={form.repo} placeholder="https://github.com/owner/repo.git" onChange={e => setForm({ ...form, repo: e.target.value })} required /></label>
          <div className="cloud-row"><label style={{ flex: 1 }}>分支 / Ref<input value={form.ref} onChange={e => setForm({ ...form, ref: e.target.value })} required /></label><label style={{ flex: 1 }}>PR 基准分支<input value={form.baseBranch} onChange={e => setForm({ ...form, baseBranch: e.target.value })} required /></label></div>
          <small>模型：{s.info?.model?.name ?? (typeof s.info?.model === "string" ? s.info.model : "由云端配置固定")}</small>
          {error && <p className="cloud-error" role="alert">{error}</p>}<p><button type="submit" disabled={busy || !s.runners.length}>{busy ? "保存中…" : submitLabel}</button></p>
        </form>;
      }
      function Login() {
        const [login, setLogin] = useState<any>(), [error, setError] = useState("");
        useEffect(() => { if (!login) return; const timer = setInterval(() => void invoke({ op: "finishLogin" }).then(r => { if (r.state === "approved") { setLogin(undefined); void refresh(); void sessions.refresh(); } }).catch(e => setError(e.message)), 2000); return () => clearInterval(timer); }, [login]);
        return <><p>连接云端后，在原生会话中选择执行位置。</p>{login ? <><p>授权码：<strong>{login.userCode}</strong></p><a href={login.verificationUri} target="_blank" rel="noreferrer">在浏览器中登录并授权</a><p><small>完成授权后自动连接。</small></p></> : <button onClick={() => void actions(async () => setLogin(await invoke({ op: "beginLogin" })), setError)}>登录云端</button>}{error && <p role="alert" className="cloud-error">{error}</p>}</>;
      }
      function Location({ sessionId, useSession, useInput }: any) {
        const s = useCloud(), entry = s.sessions.find(v => v.sessionId === sessionId);
        const inputPhase = useInput((v: any) => v?.phase);
        const [setup, setSetup] = useState(false);
        const available = useSession((v: any) => canChooseLocation(v, entry, inputPhase));
        const startCloud = async (config: any) => {
          const r = await invoke({ op: "native", action: "draft", data: config });
          await refresh(); await sessions.refresh(); await carry(sessionId, r.sessionId);
          setSetup(false);
        };
        return <LocationPicker key={sessionId} available={available} cloud={!!entry} onSelect={async cloud => {
          if (!cloud) { if (entry) await carry(sessionId, await sessions.create()); setSetup(false); return true; }
          if (entry) return true;
          if (s.signedIn && s.defaults.runnerId && s.defaults.repo && s.templates.some((t: any) => t.id === s.defaults.templateId && t.version === s.defaults.templateVersion) && s.runners.some((r: any) => r.id === s.defaults.runnerId)) {
            await startCloud(s.defaults); return true;
          }
          setSetup(true); return false;
        }}>
          {setup && (s.signedIn ? <Configuration initial={s.defaults} submitLabel="使用云端" onSubmit={startCloud}/> : <Login/>)}
        </LocationPicker>;
      }
      function Settings() {
        const s = useCloud(), [pair, setPair] = useState<any>(), [error, setError] = useState(""), [selected, setSelected] = useState("");
        const tasks = s.sessions.filter(v => !v.draft && v.taskId), selectedId = tasks.some(v => v.sessionId === selected) ? selected : tasks[0]?.sessionId;
        return <div className="dsh-cloud-native"><h3>云端执行</h3>{!s.signedIn ? <Login/> : <><p><small>{s.info?.publicUrl}</small></p><div className="cloud-line"><strong>云端会话</strong>{tasks.length ? <><label>选择会话<select value={selectedId} onChange={e => setSelected(e.target.value)}>{tasks.map(v => <option key={v.sessionId} value={v.sessionId}>{v.title || "未命名会话"}{v.paused ? " · 已暂停" : ""}</option>)}</select></label><CloudStatus key={selectedId} sessionId={selectedId}/></> : <p><small>新建会话时选择云端，发送消息后会在此显示。</small></p>}</div><div className="cloud-line"><strong>默认执行环境</strong><Configuration initial={s.defaults} submitLabel="保存默认设置" onSubmit={async data => { await invoke({ op: "native", action: "defaults", data }); }} /></div><div className="cloud-line"><strong>执行节点</strong>{s.runners.map((r: any) => <div className="cloud-row cloud-line" key={r.id}><span>{r.name} · {r.platform}</span><small>{Date.now() - r.lastSeenAt < 45000 ? "在线" : "离线"}</small><button style={{ marginLeft: "auto" }} onClick={() => { if (confirm(`撤销节点 ${r.name}？该节点上的任务将暂停。`)) void actions(() => request(`/v1/runners/${r.id}/revoke`, {}), setError); }}>撤销</button></div>)}<button onClick={() => void actions(async () => setPair(await request("/v1/runner-pairings", {})), setError)}>添加执行节点</button>{pair && <p>配对码：<code>{pair.code}</code><br/><small>在执行机器上运行 Runner 配对命令。</small></p>}</div><button onClick={() => void actions(async () => { await invoke({ op: "logout" }); set({ signedIn: false, sessions: [] }); }, setError)}>退出云端登录</button></>}{error && <p role="alert" className="cloud-error">{error}</p>}</div>;
      }
      function CloudStatus({ sessionId }: any) {
        const s = useCloud(), entry = s.sessions.find(v => v.sessionId === sessionId);
        const [detail, setDetail] = useState<any>(), [open, setOpen] = useState(true), [error, setError] = useState("");
        const [ack, setAck] = useState(false), [armed, setArmed] = useState(false), [diff, setDiff] = useState<string>();
        useEffect(() => {
          setArmed(false); setAck(false); setDiff(undefined);
          if (!entry?.taskId) { setDetail(undefined); return; }
          let live = true;
          const update = () => invoke({ op: "native", action: "detail", data: { sessionId } }).then(v => { if (live) { setDetail(v); if (!v.task.paused) setArmed(false); } }).catch(e => { if (live) setError(e.message); });
          void update(); const timer = setInterval(update, 2000);
          return () => { live = false; clearInterval(timer); };
        }, [entry?.taskId, sessionId]);
        if (!entry || entry.draft || !detail) return null;
        const t = detail.task, last = detail.runs.at(-1), result = [...detail.runs].reverse().find((r: any) => r.result?.workspaceRevision);
        const run = detail.runs.find((r: any) => r.id === t.currentRunId), prior = [...detail.runs].reverse().find((r: any) => ["interrupted", "uncertain", "cancelled", "failed"].includes(r.state));
        const recovering = !!t.paused && !run && t.environmentState !== "needs_stop" && prior;
        const operation = async (path: string, body?: any) => {
          const op = await request(path, body);
          if (op.offline) throw new Error("执行节点离线，请稍后重试。");
          for (let n = 0; n < 90; n++) {
            const v = await request(`/v1/operations/${op.operationId}`);
            if (v.state === "succeeded") return v.result;
            if (["failed", "unknown"].includes(v.state)) throw new Error(v.result?.error ?? "操作未成功，请重试。");
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          throw new Error("操作超时，请稍后查看结果。");
        };
        return <div className="dsh-cloud-native" style={{ padding: "4px 0" }}>
          <div className="cloud-row"><CloudIcon/><small>{detail.runner?.name} · {run ? ({ preparing: "准备环境", running: "执行中", waiting_input: "等待回答", finalizing: "整理结果", cancelling: "正在停止" } as any)[run.state] ?? run.state : t.paused ? "已暂停" : t.environmentState === "stopped" ? "环境已停止 · 文件保留" : "已同步"}</small>
            <button onClick={() => setOpen(!open)}>云端结果{result?.result.checks?.length ? ` · ${result.result.checks.filter((c: any) => c.state === "passed").length}/${result.result.checks.length} 项检查通过` : ""}</button>
            {detail.publication?.url && <a href={detail.publication.url} target="_blank" rel="noreferrer">Draft PR ↗</a>}
          </div>
          {(open || !!t.paused) && <div className="cloud-line">
            {last?.result?.error && <p role="alert">{last.result.error === "cancel_requested" ? "本轮已停止。" : last.result.error}</p>}
            {recovering && <><p><small>{armed ? "已准备好恢复。返回会话发送新的指令。" : "确认恢复后，返回会话发送新的指令。旧的排队输入将取消。"}</small></p>
              {prior.state === "uncertain" && <label className="cloud-row"><input style={{ width: "auto" }} type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)}/>我已检查外部操作可能产生的结果</label>}
              <button disabled={armed || (prior.state === "uncertain" && !ack)} onClick={() => void actions(async () => { await invoke({ op: "native", action: "recover", data: { sessionId, previousRunId: prior.id, acknowledgeUncertain: ack } }); setArmed(true); }, setError)}>{armed ? "等待恢复指令" : "准备恢复会话"}</button>
            </>}
            {!!t.paused && !run && !prior && t.environmentState !== "needs_stop" && <button onClick={() => void actions(() => request(`/v1/tasks/${t.id}/queue/resume`, {}), setError)}>继续待执行输入</button>}
            {t.environmentState === "needs_stop" && <p><small>正在等待节点确认原执行已停止。</small></p>}
            {open && <>
              {result?.result.checks?.map((c: any) => <details key={c.name}><summary>{c.name} · {c.state}</summary><pre>{c.stdout}{c.stderr}</pre></details>)}
              <div className="cloud-row"><button onClick={() => void actions(async () => setDiff((await operation(`/v1/tasks/${t.id}/diff`)).diff || "当前没有文件改动。"), setError)}>查看变更</button>
                {result && !run && <button onClick={() => void actions(() => operation(`/v1/tasks/${t.id}/publications`, { runId: result.id, workspaceRevision: result.result.workspaceRevision, allowFailedChecks: false }), setError)}>创建 / 更新 Draft PR</button>}
                {!run && !t.paused && t.environmentState !== "stopped" && <button onClick={() => void actions(() => operation(`/v1/tasks/${t.id}/environment/stop`, {}), setError)}>停止空闲环境</button>}
                {!!t.paused && !run && <button onClick={() => void actions(() => operation(`/v1/tasks/${t.id}/environment/retry-setup`, {}), setError)}>重试环境准备</button>}
              </div>{diff && <details open><summary>工作区变更</summary><pre>{diff}</pre></details>}
            </>}
            {error && <p className="cloud-error" role="alert">{error}</p>}
          </div>}
        </div>;
      }
      const registrations = [
        ctx.slots.inject("conversation.input.left", () => ctx.slots.register({ name: "conversation.input.left", id: "dsh-cloud-location", order: -100 }, Location)),
        ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "dsh-cloud", order: 60, label: () => "云端执行" }, Settings)),
        ctx.slots.inject("sidebar.session.row.leading", () => ctx.slots.register({ name: "sidebar.session.row.leading", id: "dsh-cloud-badge", order: 10 }, ({ sessionId }: any) => { const s = useCloud(); return s.sessions.some(v => v.sessionId === sessionId) ? <span title="云端会话" aria-label="云端会话"><CloudIcon/></span> : null; })),
      ];
      const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);
      ctx.effect(() => () => { stopped = true; clearInterval(timer); style.remove(); registrations.forEach(dispose => dispose()); });
    });
    return async () => { await scope.dispose(); await unmount(); };
  });
}
