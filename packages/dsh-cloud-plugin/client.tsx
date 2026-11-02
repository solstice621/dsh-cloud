import React, { useEffect, useState, useSyncExternalStore } from "react";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-api-gateway/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-workspace/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type { ISessions } from "@deepseek-ai/dsh-api-session-controller/client";
import { remote } from "./remote.ts";

export const inject = ["remote", "slots", "sessions", "uiWorkspace", "conversation"];
const css = `.dsh-cloud-native{color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}.dsh-cloud-native button,.dsh-cloud-native input,.dsh-cloud-native select{font:inherit;color:inherit}.dsh-cloud-native button{cursor:pointer;border:0;border-radius:var(--dsw-radius-md,8px);padding:6px 9px;background:transparent}.dsh-cloud-native button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dsh-cloud-native button:disabled{opacity:.45;cursor:default}.dsh-cloud-native input,.dsh-cloud-native select{box-sizing:border-box;width:100%;border:1px solid var(--dsw-alias-border-main,#8885);border-radius:8px;background:var(--dsw-alias-bg-layer-1,transparent);padding:8px}.dsh-cloud-native label{display:grid;gap:6px;margin:12px 0}.dsh-cloud-native small{color:var(--dsw-alias-label-secondary);font-size:12px}.dsh-cloud-native p{margin:10px 0;line-height:1.6}.dsh-cloud-native .cloud-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.dsh-cloud-native .cloud-error{color:var(--dsw-alias-status-error,#c44)}.dsh-cloud-native .cloud-popover{position:absolute;bottom:calc(100% + 8px);left:0;min-width:280px;width:min(340px,80vw);max-height:65vh;overflow:auto;padding:16px;box-shadow:var(--dsw-elevation-prominent,0 8px 28px #0003);border:1px solid var(--dsw-alias-border-main,#8884);border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);z-index:80}.dsh-cloud-native .cloud-line{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-main,#8883)}.dsh-cloud-native a{color:inherit;text-decoration:underline}.dsh-cloud-native pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace;max-height:260px;overflow:auto}`;
function CloudIcon() { return <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 18a4.5 4.5 0 0 1-.8-8.9A6.5 6.5 0 0 1 17.6 8a5 5 0 0 1 .4 10H6Z"/></svg>; }
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
      function Location({ sessionId, useSession }: any) {
        const s = useCloud(), entry = s.sessions.find(v => v.sessionId === sessionId), blank = useSession((v: any) => v?.blank), [open, setOpen] = useState(false), [error, setError] = useState("");
        const fixed = entry ? !entry.draft : !blank;
        return <div className="dsh-cloud-native" style={{ position: "relative" }}><button aria-label="执行位置" aria-expanded={open} title={fixed ? "执行位置在会话开始后固定" : "选择执行位置"} onClick={() => setOpen(!open)} className="cloud-row">{entry ? <CloudIcon/> : <span aria-hidden="true">⌘</span>}{entry ? "云端" : "此计算机"}<span aria-hidden="true">⌄</span></button>{open && <div className="cloud-popover"><div className="cloud-row"><strong>执行位置</strong><button style={{ marginLeft: "auto" }} aria-label="关闭执行位置" onClick={() => setOpen(false)}>×</button></div>{fixed ? <p>{entry ? `云端 · ${entry.runnerName ?? "已绑定节点"}` : "此计算机"}<br/><small>此会话的执行位置已固定。新建会话时可选择其他位置。</small></p> : <><div className="cloud-row"><button onClick={() => void actions(async () => { if (entry) await carry(sessionId, await sessions.create()); setOpen(false); }, setError)}>此计算机</button><span>云端</span></div>{s.signedIn ? <Configuration initial={s.defaults} submitLabel="使用云端" onSubmit={async config => { const r = await invoke({ op: "native", action: "draft", data: config }); await refresh(); await sessions.refresh(); await carry(sessionId, r.sessionId); setOpen(false); }} /> : <Login/>}</>}{error && <p role="alert">{error}</p>}</div>}</div>;
      }
      function Settings() {
        const s = useCloud(), [pair, setPair] = useState<any>(), [error, setError] = useState("");
        return <div className="dsh-cloud-native"><h3>云端执行</h3>{!s.signedIn ? <Login/> : <><p><small>{s.info?.publicUrl}</small></p><div className="cloud-line"><strong>默认执行环境</strong><Configuration initial={s.defaults} submitLabel="保存默认设置" onSubmit={async data => { await invoke({ op: "native", action: "defaults", data }); }} /></div><div className="cloud-line"><strong>执行节点</strong>{s.runners.map((r: any) => <div className="cloud-row cloud-line" key={r.id}><span>{r.name} · {r.platform}</span><small>{Date.now() - r.lastSeenAt < 45000 ? "在线" : "离线"}</small><button style={{ marginLeft: "auto" }} onClick={() => { if (confirm(`撤销节点 ${r.name}？该节点上的任务将暂停。`)) void actions(() => request(`/v1/runners/${r.id}/revoke`, {}), setError); }}>撤销</button></div>)}<button onClick={() => void actions(async () => setPair(await request("/v1/runner-pairings", {})), setError)}>添加执行节点</button>{pair && <p>配对码：<code>{pair.code}</code><br/><small>在执行机器上运行 Runner 配对命令。</small></p>}</div><button onClick={() => void actions(async () => { await invoke({ op: "logout" }); set({ signedIn: false, sessions: [] }); }, setError)}>退出云端登录</button></>}{error && <p role="alert" className="cloud-error">{error}</p>}</div>;
      }
      function CloudStatus({ sessionId }: any) {
        const s = useCloud(), entry = s.sessions.find(v => v.sessionId === sessionId);
        const [detail, setDetail] = useState<any>(), [open, setOpen] = useState(false), [error, setError] = useState("");
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
            {recovering && <><p><small>{armed ? "下一条消息将作为恢复指令，在下方原生输入框发送。" : "确认恢复后，在下方输入框发送新的指令。旧的排队输入将取消。"}</small></p>
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
        ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({ name: "conversation.input.dock", id: "dsh-cloud-status", order: 10 }, CloudStatus)),
        ctx.slots.inject("settings.section", () => ctx.slots.register({ name: "settings.section", id: "dsh-cloud", order: 60, label: () => "云端执行" }, Settings)),
        ctx.slots.inject("sidebar.session.row.leading", () => ctx.slots.register({ name: "sidebar.session.row.leading", id: "dsh-cloud-badge", order: 10 }, ({ sessionId }: any) => { const s = useCloud(); return s.sessions.some(v => v.sessionId === sessionId) ? <span title="云端会话" aria-label="云端会话"><CloudIcon/></span> : null; })),
      ];
      const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);
      ctx.effect(() => () => { stopped = true; clearInterval(timer); style.remove(); registrations.forEach(dispose => dispose()); });
    });
    return async () => { await scope.dispose(); await unmount(); };
  });
}
