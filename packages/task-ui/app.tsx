import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Transport } from "./transport.ts";
import { styles } from "./styles.ts";

const labels: Record<string, string> = {
  queued: "排队中",
  preparing: "准备环境",
  running: "执行中",
  waiting_input: "等待回答",
  finalizing: "保存结果",
  cancelling: "等待停止确认",
  cancelled: "已取消",
  succeeded: "已完成",
  failed: "失败",
  interrupted: "执行中断",
  uncertain: "需要核对",
  passed: "通过",
  unknown: "结果待核对",
  pending: "等待处理",
  ready: "可继续",
  busy: "运行中",
  stopped: "已停止",
  error: "环境错误",
  needs_stop: "正在停止旧实例",
  provisioning: "准备中",
  open: "进行中",
  archived: "已归档",
  delete_pending: "删除中",
};
const terminal = [
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
  "uncertain",
];
const when = (t: number) => new Date(t).toLocaleString();
const short = (s: string) => s?.slice(0, 8) ?? "—";
function Badge({ state }: { state: string }) {
  return (
    <span className={`badge ${state}`}>
      <span className="dot" />
      {labels[state] ?? state}
    </span>
  );
}
function ErrorBox({ error }: { error: string }) {
  return error ? (
    <div role="alert" className="error-box">
      {error}
    </div>
  ) : null;
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal"
      >
        <div className="row between">
          <h2>{title}</h2>
          <button className="ghost" aria-label="关闭" onClick={close}>
            ✕
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
function Logo() {
  return (
    <div className="brand">
      <span className="brand-icon">☁</span>
      <span className="wordmark">DSH Cloud</span>
    </div>
  );
}

export function CloudApp({
  transport,
  embedded = false,
}: {
  transport: Transport;
  embedded?: boolean;
}) {
  const [auth, setAuth] = useState<"loading" | "signed-in" | "signed-out">(
      "loading",
    ),
    [info, setInfo] = useState<any>({}),
    [tasks, setTasks] = useState<any[]>([]),
    [runners, setRunners] = useState<any[]>([]),
    [templates, setTemplates] = useState<any[]>([]),
    [error, setError] = useState(""),
    [restore, setRestore] = useState<any>(null);
  const [selected, setSelected] = useState<string | null>(
      !embedded
        ? (location.pathname.match(/^\/tasks\/([^/]+)/)?.[1] ?? null)
        : null,
    ),
    [dialog, setDialog] = useState<"create" | "runners" | null>(null),
    [showArchived, setShowArchived] = useState(false);
  const reload = useCallback(async () => {
    try {
      const [me, ts, rs, es] = await Promise.all([
        transport.request("/v1/me"),
        transport.request("/v1/tasks"),
        transport.request("/v1/runners"),
        transport.request("/v1/templates"),
      ]);
      if (me) {
        setRestore(me.recovery);
        setAuth("signed-in");
        setTasks(ts);
        setRunners(rs);
        setTemplates(es);
        setError("");
      }
    } catch (e: any) {
      if (
        e.status === 401 ||
        /sign in|unauthorized|not signed in/i.test(e.message)
      )
        setAuth("signed-out");
      else setError(e.message);
    }
  }, [transport]);
  useEffect(() => {
    void transport
      .request("/v1/info")
      .then(setInfo)
      .catch(() => {});
    void reload();
    const timer = setInterval(() => void reload(), 5000);
    return () => clearInterval(timer);
  }, [reload, transport]);
  const open = (taskId: string | null) => {
    setSelected(taskId);
    if (!embedded) history.pushState({}, "", taskId ? `/tasks/${taskId}` : "/");
  };
  useEffect(() => {
    if (embedded) return;
    const pop = () =>
      setSelected(location.pathname.match(/^\/tasks\/([^/]+)/)?.[1] ?? null);
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [embedded]);
  return (
    <div className="dsh-cloud">
      <style>{styles}</style>
      {auth === "signed-out" ? (
        <Login transport={transport} info={info} done={() => void reload()} />
      ) : (
        <>
          <header className="topbar">
            <Logo />
            <span className="badge">个人工作空间</span>
            <div className="grow" />
            <button className="ghost" onClick={() => setDialog("runners")}>
              执行节点
            </button>
            <button
              className="ghost small"
              onClick={() =>
                void transport.logout().then(() => setAuth("signed-out"))
              }
            >
              退出
            </button>
          </header>
          <div className="shell">
            <aside className="rail">
              <div className="rail-head">
                <div className="row between">
                  <span className="eyebrow">WORKSPACE</span>
                  <button
                    className="ghost"
                    aria-label="新建任务"
                    onClick={() => setDialog("create")}
                  >
                    ＋
                  </button>
                </div>
                <button className="link-button" onClick={() => open(null)}>
                  所有云任务
                </button>
              </div>
              <div>
                {tasks
                  .filter((t) => showArchived || t.lifecycle !== "archived")
                  .map((t) => (
                    <button
                      key={t.id}
                      className={`task-item ${selected === t.id ? "active" : ""}`}
                      onClick={() => open(t.id)}
                    >
                      <div className="task-title">{t.title}</div>
                      <div
                        className="row between small muted"
                        style={{ marginTop: 7 }}
                      >
                        <span>{t.runnerName}</span>
                        <span>
                          {labels[
                            t.lifecycle === "archived"
                              ? "archived"
                              : t.environmentState
                          ] ?? t.environmentState}
                        </span>
                      </div>
                    </button>
                  ))}
              </div>
              <button
                className="ghost small"
                onClick={() => setShowArchived(!showArchived)}
              >
                {showArchived ? "隐藏已归档" : "显示已归档"}
              </button>
            </aside>
            <main className="content">
              <div className="content-inner">
                <ErrorBox error={error} />
                {restore && (
                  <RecoveryBanner transport={transport} reload={reload} />
                )}{" "}
                {auth === "loading" ? (
                  <p className="muted">正在连接工作空间…</p>
                ) : selected ? (
                  <TaskDetail
                    key={selected}
                    taskId={selected}
                    transport={transport}
                    onChange={() => void reload()}
                    onDeleted={() => {
                      open(null);
                      void reload();
                    }}
                  />
                ) : (
                  <Overview
                    tasks={tasks}
                    runners={runners}
                    model={info.model}
                    create={() => setDialog("create")}
                    open={open}
                  />
                )}
              </div>
            </main>
          </div>
        </>
      )}
      {auth === "signed-in" && !embedded && (
        <DeviceApproval transport={transport} />
      )}{" "}
      {dialog === "create" && (
        <CreateTask
          transport={transport}
          model={info.model}
          runners={runners}
          templates={templates}
          close={() => setDialog(null)}
          created={(id) => {
            setDialog(null);
            open(id);
            void reload();
          }}
        />
      )}
      {dialog === "runners" && (
        <RunnerManager
          transport={transport}
          runners={runners}
          close={() => setDialog(null)}
          reload={reload}
        />
      )}
    </div>
  );
}
function Login({
  transport,
  info,
  done,
}: {
  transport: Transport;
  info: any;
  done: () => void;
}) {
  const [token, setToken] = useState(""),
    [error, setError] = useState(""),
    [device, setDevice] = useState<any>(),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!device || !transport.finishLogin) return;
    const timer = setInterval(
      () =>
        void transport.finishLogin!()
          .then((r) => {
            if (r.state === "approved") {
              clearInterval(timer);
              done();
            }
          })
          .catch((e) => setError(e.message)),
      5000,
    );
    return () => clearInterval(timer);
  }, [device, transport]);
  const login = async () => {
    setBusy(true);
    setError("");
    try {
      if (transport.beginLogin) setDevice(await transport.beginLogin());
      else {
        await transport.login?.(
          info.login === "development" ? token : undefined,
        );
        done();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card login">
      <Logo />
      <div className="divider" />
      <div className="eyebrow">PICK UP WHERE YOU LEFT OFF</div>
      <h1>回到你的云任务</h1>
      <p className="lead">从任何设备，继续同一段会话与工作环境。</p>
      <ErrorBox error={error} />
      {device ? (
        <div className="notice">
          <p>在浏览器中登录并输入此设备码：</p>
          <pre>{device.userCode}</pre>
          <a href={device.verificationUri} target="_blank" rel="noreferrer">
            打开登录页面 ↗
          </a>
          <p className="small" style={{ marginTop: 12 }}>
            此页面会自动等待授权结果。
          </p>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void login();
          }}
        >
          {info.login === "development" && !transport.beginLogin && (
            <>
              <label htmlFor="dev-token">本地开发访问令牌</label>
              <input
                id="dev-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </>
          )}
          <button
            className="primary"
            disabled={busy}
            style={{ width: "100%", marginTop: 22 }}
          >
            {busy
              ? "连接中…"
              : transport.beginLogin
                ? "连接云工作空间"
                : "登录工作空间"}
          </button>
        </form>
      )}
    </div>
  );
}
function Overview({
  tasks,
  runners,
  model,
  create,
  open,
}: {
  tasks: any[];
  runners: any[];
  model?: string;
  create: () => void;
  open: (id: string) => void;
}) {
  return (
    <>
      <div className="row between">
        <div>
          <div className="eyebrow">YOUR WORK, STILL RUNNING</div>
          <h1>工作在继续，随时回来。</h1>
          <p className="lead">
            任务在你选择的节点上运行。会话、文件和执行记录会保留在同一个任务中。
          </p>
        </div>
        <button className="primary" onClick={create}>
          ＋ 新建云任务
        </button>
      </div>
      <div className="cards">
        <div className="card">
          <p className="small muted">进行中的任务</p>
          <div className="metric">
            {tasks.filter((t) => t.currentRunId).length}
          </div>
        </div>
        <div className="card">
          <p className="small muted">在线执行节点</p>
          <div className="metric">
            {
              runners.filter(
                (r) => !r.revoked && Date.now() - r.lastSeenAt < 30000,
              ).length
            }
            <span className="small muted"> / {runners.length}</span>
          </div>
        </div>
        <div className="card">
          <p className="small muted">保存的任务</p>
          <div className="metric">{tasks.length}</div>
        </div>
      </div>
      <h2>最近任务</h2>
      {tasks.length ? (
        <div className="stack" style={{ marginTop: 16 }}>
          {tasks.slice(0, 8).map((t) => (
            <button
              className="card row between"
              key={t.id}
              onClick={() => open(t.id)}
            >
              <div style={{ textAlign: "left" }}>
                <div className="task-title">{t.title}</div>
                <p className="small muted">
                  {t.repo.replace("https://", "")} · {t.runnerName}
                </p>
              </div>
              <Badge state={t.environmentState} />
            </button>
          ))}
        </div>
      ) : (
        <div className="empty" style={{ marginTop: 16 }}>
          <h2>给一个任务，留一个持续的环境。</h2>
          <p>选择仓库、执行节点和环境模板，开始第一项工作。</p>
          <button className="primary" onClick={create}>
            创建第一个任务
          </button>
        </div>
      )}
      <p className="footer">
        模型线路：{model ?? "由控制服务配置"} ·
        运行结束后环境持续保留，直到主动删除。
      </p>
    </>
  );
}
function CreateTask({
  transport,
  model,
  runners,
  templates,
  close,
  created,
}: {
  transport: Transport;
  model: string;
  runners: any[];
  templates: any[];
  close: () => void;
  created: (id: string) => void;
}) {
  const available = runners.filter((r) => !r.revoked),
    [form, setForm] = useState({
      title: "",
      repo: "",
      ref: "main",
      baseBranch: "main",
      runnerId: available[0]?.id ?? "",
      templateKey: templates[0]
        ? `${templates[0].id}@${templates[0].version}`
        : "",
      input: "",
      deliveryPolicy: "results",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());
  const change = (field: string, value: string) => {
    key.current = crypto.randomUUID();
    setForm({ ...form, [field]: value });
  };
  return (
    <Modal title="新建云任务" close={close}>
      <p className="muted small" style={{ marginTop: 8 }}>
        每个任务独立保存会话、工作区和分支。之后的追问会回到这里。
      </p>
      <p className="muted small">模型线路：{model} · 创建后随任务固定</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const chosen = templates.find(
              (t) => `${t.id}@${t.version}` === form.templateKey,
            );
            const { templateKey, ...values } = form;
            const r = await transport.request(
              "/v1/tasks",
              {
                ...values,
                templateId: chosen.id,
                templateVersion: chosen.version,
              },
              key.current,
            );
            created(r.taskId);
          } catch (e: any) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          任务名称
          <input
            required
            maxLength={160}
            placeholder="例如：完善登录错误提示"
            value={form.title}
            onChange={(e) => change("title", e.target.value)}
          />
        </label>
        <label>
          Git 仓库
          <input
            required
            type="url"
            placeholder="https://github.com/owner/repository.git"
            value={form.repo}
            onChange={(e) => change("repo", e.target.value)}
          />
        </label>
        <div className="grid2">
          <label>
            起始引用 / commit
            <input
              required
              value={form.ref}
              onChange={(e) => change("ref", e.target.value)}
            />
          </label>
          <label>
            PR 目标分支
            <input
              required
              value={form.baseBranch}
              onChange={(e) => change("baseBranch", e.target.value)}
            />
          </label>
        </div>
        <div className="grid2">
          <label>
            执行节点
            <select
              required
              value={form.runnerId}
              onChange={(e) => change("runnerId", e.target.value)}
            >
              {available.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ·{" "}
                  {Date.now() - r.lastSeenAt < 30000 ? "在线" : "离线"} ·{" "}
                  {r.platform}
                </option>
              ))}
            </select>
          </label>
          <label>
            环境模板
            <select
              value={form.templateKey}
              onChange={(e) => change("templateKey", e.target.value)}
            >
              {templates.map((t) => (
                <option key={`${t.id}@${t.version}`}>
                  {t.id}@{t.version}
                </option>
              ))}
            </select>
          </label>
        </div>
        {templates
          .filter((t) => `${t.id}@${t.version}` === form.templateKey)
          .map((t) => (
            <p className="small muted" key={t.id}>
              上限：{Math.round(t.timeoutSeconds / 60)} 分钟有效执行 ·{" "}
              {t.maxModelCalls} 次模型调用 · 每次 {t.maxOutputTokens} 输出
              tokens
            </p>
          ))}
        <label>
          任务说明
          <textarea
            required
            placeholder="描述需要完成的工作，以及验收标准…"
            value={form.input}
            onChange={(e) => change("input", e.target.value)}
          />
        </label>
        <label>
          交付方式
          <select
            value={form.deliveryPolicy}
            onChange={(e) => change("deliveryPolicy", e.target.value)}
          >
            <option value="results">保存结果与 Diff</option>
            <option value="draft-pr">检查通过后创建 Draft PR</option>
          </select>
        </label>
        <ErrorBox error={error} />
        {!available.length && (
          <div className="notice">请先在“执行节点”中配对一个 Runner。</div>
        )}
        <div
          className="row"
          style={{ justifyContent: "flex-end", marginTop: 22 }}
        >
          <button type="button" onClick={close}>
            取消
          </button>
          <button className="primary" disabled={busy || !available.length}>
            {busy ? "保存中…" : "创建并开始"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TaskDetail({
  taskId,
  transport,
  onChange,
  onDeleted,
}: {
  taskId: string;
  transport: Transport;
  onChange: () => void;
  onDeleted: () => void;
}) {
  const [snap, setSnap] = useState<any>(),
    [native, setNative] = useState<any[]>([]),
    [connected, setConnected] = useState(false),
    [tab, setTab] = useState("conversation"),
    [error, setError] = useState(""),
    [input, setInput] = useState(""),
    [busy, setBusy] = useState(false),
    [recovery, setRecovery] = useState(false),
    [ack, setAck] = useState(false),
    [allowFailed, setAllowFailed] = useState(false),
    [deleting, setDeleting] = useState(false);
  const inputKey = useRef(crypto.randomUUID());
  const refresh = useCallback(async () => {
    const s = await transport.request(`/v1/tasks/${taskId}`);
    setSnap(s);
    if (s.task.lifecycle === "deleted") onDeleted();
  }, [taskId, transport]);
  useEffect(() => {
    let stopped = false,
      unwatch = () => {},
      cursor = 0;
    void (async () => {
      try {
        const s = await transport.request(`/v1/tasks/${taskId}`);
        if (stopped) return;
        setSnap(s);
        cursor = s.snapshotSeq;
        let after = -1,
          events: any[] = [];
        while (true) {
          const batch = await transport.request(
            `/v1/tasks/${taskId}/history?after=${after}`,
          );
          if (!batch.events.length) break;
          events.push(...batch.events);
          after = batch.events.at(-1).seq;
          if (after >= batch.durableSeq) break;
        }
        if (stopped) return;
        setNative(events);
        unwatch = transport.watch(
          taskId,
          cursor,
          (event) => {
            if (event.taskSeq <= cursor) return;
            if (event.taskSeq !== cursor + 1) {
              setError("事件序号存在缺口，请重新打开任务。");
              return;
            }
            cursor = event.taskSeq;
            if (event.kind === "session.event")
              setNative((old) => {
                const map = new Map(old.map((x) => [x.seq, x]));
                map.set(event.payload.seq, event.payload);
                return [...map.values()].sort((a, b) => a.seq - b.seq);
              });
            else void refresh().catch((e) => setError(e.message));
          },
          setConnected,
        );
      } catch (e: any) {
        setError(e.message);
      }
    })();
    const timer = setInterval(
      () => void refresh().catch(() => setConnected(false)),
      4000,
    );
    return () => {
      stopped = true;
      clearInterval(timer);
      unwatch();
    };
  }, [taskId, transport, refresh]);
  const act = async (path: string, body: unknown = {}, key?: string) => {
    setError("");
    setBusy(true);
    try {
      const result = await transport.request(path, body, key);
      await refresh();
      onChange();
      return result;
    } catch (e: any) {
      setError(e.message);
      throw e;
    } finally {
      setBusy(false);
    }
  };
  if (!snap)
    return (
      <>
        <ErrorBox error={error} />
        <p className="muted">正在读取任务…</p>
      </>
    );
  const t = snap.task,
    offline =
      Date.now() - snap.runner.lastSeenAt > 30000 || !!snap.runner.revoked,
    last = snap.runs.at(-1),
    prior = [...snap.runs]
      .reverse()
      .find((r: any) => terminal.includes(r.state)),
    resultRun = [...snap.runs]
      .reverse()
      .find((r: any) => r.result?.workspaceRevision),
    pending = snap.interactions.filter((i: any) => i.state === "pending");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await act(
        `/v1/tasks/${taskId}/inputs`,
        {
          input,
          kind: recovery ? "recovery" : "normal",
          ...(recovery
            ? { previousRunId: prior?.id, acknowledgeUncertain: ack }
            : {}),
        },
        inputKey.current,
      );
      setInput("");
      inputKey.current = crypto.randomUUID();
      setRecovery(false);
      setAck(false);
    } catch {}
  };
  return (
    <>
      <div className="row between">
        <div>
          <div className="eyebrow">CLOUD TASK</div>
          <h1>{t.title}</h1>
        </div>
        <div className="row">
          <Badge state={last?.state ?? t.environmentState} />
          <span className="small muted">
            {connected ? "● 已同步" : "○ 正在重连"}
          </span>
        </div>
      </div>
      <p className="lead small">
        {t.repo} · {snap.runner.name} · {t.templateId}@{t.templateVersion}
      </p>
      <details className="small">
        <summary>任务与环境信息</summary>
        <div className="id-strip">
          <span>
            Task <code>{t.id}</code>
          </span>
          <span>
            Session <code>{t.sessionId}</code>
          </span>
          <span>
            Environment <code>{t.environmentId}</code>
          </span>
          <span>
            运行代次 {t.epoch} · 已持久化事件 {t.durableSeq}
          </span>
        </div>
        <p className="small muted">
          模型 {snap.modelRoute?.name ?? "未绑定"} · 分支 {t.branch} · 起始
          commit {t.baseCommit ?? "解析中"} ·{" "}
          <Badge state={t.environmentState} />
        </p>
      </details>
      <ErrorBox error={error} />
      {offline && (
        <div className="notice">
          执行节点{snap.runner.revoked ? "已撤销" : "离线"}
          。这里保留已同步的历史与产物；继续执行和读取实时文件需要原节点在线。
          <div className="small">最后心跳：{when(snap.runner.lastSeenAt)}</div>
        </div>
      )}
      {t.paused === 1 && (
        <div className="notice">
          队列已暂停。
          {t.environmentState === "needs_stop"
            ? "正在等待旧执行实例确认停止。"
            : "检查上一次运行和工作区，再选择恢复方式。"}
          <div className="row" style={{ marginTop: 8 }}>
            {prior &&
              ["uncertain", "interrupted", "failed", "cancelled"].includes(
                prior.state,
              ) && (
                <button
                  disabled={
                    t.environmentState === "needs_stop" || !!t.currentRunId
                  }
                  onClick={() => {
                    setRecovery(true);
                    setTab("conversation");
                  }}
                >
                  编写恢复输入
                </button>
              )}
            {!prior || !["uncertain", "interrupted"].includes(prior.state) ? (
              <button
                onClick={() =>
                  void act(`/v1/tasks/${taskId}/queue/resume`).catch(() => {})
                }
              >
                继续排队任务
              </button>
            ) : null}
            {["error", "stopped"].includes(t.environmentState) && (
              <button
                onClick={() =>
                  void act(`/v1/tasks/${taskId}/environment/retry-setup`).catch(
                    () => {},
                  )
                }
              >
                重试未完成的环境初始化
              </button>
            )}
          </div>
        </div>
      )}
      {pending.map((i: any) => (
        <Interaction
          key={i.id}
          item={i}
          submit={(answer) =>
            act(`/v1/interactions/${i.id}/answers`, {
              version: i.version,
              answer,
            })
          }
        />
      ))}
      <nav className="tabs" aria-label="任务视图">
        {[
          ["conversation", "会话"],
          ["runs", "运行与队列"],
          ["files", "文件"],
          ["diff", "Diff"],
          ["results", "结果与交付"],
        ].map(([key, title]) => (
          <button
            className={tab === key ? "active" : ""}
            key={key}
            onClick={() => setTab(key)}
          >
            {title}
            {key === "runs" ? ` (${snap.runs.length})` : ""}
          </button>
        ))}
      </nav>
      {tab === "conversation" && (
        <>
          <Conversation events={native} runs={snap.runs} />
          {t.lifecycle === "open" && (
            <form className="composer" onSubmit={submit}>
              {recovery && (
                <div className="notice small">
                  恢复 Run #{prior?.ordinal}
                  。先核对可能已发生的文件或外部操作。提交后会取消旧的排队输入，请把仍需执行的工作写进本次输入。
                  {prior?.state === "uncertain" && (
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={ack}
                        onChange={(e) => setAck(e.target.checked)}
                      />
                      我已核对不确定的执行结果，允许发送新的恢复输入
                    </label>
                  )}
                </div>
              )}
              <textarea
                aria-label="继续任务"
                required
                placeholder={
                  recovery
                    ? "描述核对结果，以及接下来应如何继续…"
                    : "继续追问，或描述下一步工作…"
                }
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  inputKey.current = crypto.randomUUID();
                }}
              />
              <div className="row between">
                <span className="small muted">
                  {t.currentRunId
                    ? "新输入将排在当前运行之后"
                    : "继续使用同一会话与工作区"}
                </span>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    (!recovery && !!t.paused) ||
                    (recovery && prior?.state === "uncertain" && !ack)
                  }
                >
                  {busy ? "保存中…" : recovery ? "提交恢复输入" : "发送追问"}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {tab === "runs" && (
        <div>
          {snap.runs.map((r: any) => (
            <section className="run-card" key={r.id}>
              <div className="row between">
                <h3>
                  Run {r.ordinal} {r.kind === "recovery" ? "· 恢复运行" : ""}
                </h3>
                <div className="row">
                  <Badge state={r.state} />
                  {!terminal.includes(r.state) && (
                    <button
                      disabled={busy || r.state === "cancelling"}
                      className="small danger"
                      onClick={() =>
                        void act(`/v1/runs/${r.id}/cancel`).catch(() => {})
                      }
                    >
                      {r.state === "queued" ? "移出队列" : "取消运行"}
                    </button>
                  )}
                </div>
              </div>
              <p className="message-body">{r.input}</p>
              <p className="small muted" style={{ marginTop: 10 }}>
                {when(r.createdAt)} · {short(r.id)}
                {r.endedAt ? ` · 结束于 ${when(r.endedAt)}` : ""}
              </p>
              {r.result?.error && <ErrorBox error={r.result.error} />}
            </section>
          ))}
        </div>
      )}
      {tab === "files" && <Files taskId={taskId} transport={transport} />}
      {tab === "diff" && (
        <RemoteView
          key="diff"
          path={`/v1/tasks/${taskId}/diff`}
          transport={transport}
          render={(value) => (
            <>
              <div className="small muted">
                工作区版本 <code>{value.workspaceRevision}</code>
              </div>
              <pre>{value.stat || "暂无改动"}</pre>
              <pre>{value.diff || "工作区与起始 commit 一致。"}</pre>
            </>
          )}
        />
      )}
      {tab === "results" && (
        <div className="stack">
          {resultRun ? (
            <>
              <section className="card">
                <div className="row between">
                  <h2>Run {resultRun.ordinal} 的交付记录</h2>
                  <Badge state={resultRun.state} />
                </div>
                <p className="small muted">
                  工作区版本 <code>{resultRun.result.workspaceRevision}</code>
                </p>
                <p className="message-body">
                  {resultRun.result.finalResponse || "此运行未返回最终说明。"}
                </p>
                <div className="divider" />
                <h3>检查结果</h3>
                {resultRun.result.checks?.length ? (
                  resultRun.result.checks.map((c: any, index: number) => (
                    <details key={index}>
                      <summary>
                        <Badge state={c.state} /> {c.name} · exit{" "}
                        {c.exitCode ?? "未知"}
                        {c.required ? " · 必需" : ""}
                      </summary>
                      <pre>
                        {c.command}
                        {"\n\n"}
                        {c.stdout}
                        {c.stderr}
                      </pre>
                    </details>
                  ))
                ) : (
                  <p className="small muted">
                    模板未配置检查命令，本次没有检查执行记录。
                  </p>
                )}
                <div className="divider" />
                {snap.publication?.url && (
                  <p>
                    <a
                      href={snap.publication.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      查看 Draft PR ↗
                    </a>
                  </p>
                )}
                <label className="check small">
                  <input
                    type="checkbox"
                    checked={allowFailed}
                    onChange={(e) => setAllowFailed(e.target.checked)}
                  />
                  允许带未通过的必需检查创建 Draft PR
                </label>
                <button
                  className="primary"
                  disabled={
                    busy ||
                    !!t.currentRunId ||
                    offline ||
                    t.workspaceRevision !== resultRun.result.workspaceRevision
                  }
                  onClick={() =>
                    void act(`/v1/tasks/${taskId}/publications`, {
                      runId: resultRun.id,
                      workspaceRevision: resultRun.result.workspaceRevision,
                      allowFailedChecks: allowFailed,
                    }).catch(() => {})
                  }
                >
                  {snap.publication ? "更新 Draft PR" : "创建 Draft PR"}
                </button>
              </section>
            </>
          ) : (
            <div className="empty">
              <h2>尚无完整交付记录</h2>
              <p>运行完成后，Diff、检查记录和模型最终说明会显示在这里。</p>
            </div>
          )}
          <section className="card">
            <h3>保存的产物</h3>
            {snap.artifacts.map((a: any) => (
              <Artifact key={a.id} artifact={a} transport={transport} />
            ))}
            {!snap.artifacts.length && (
              <p className="small muted">尚无上传的产物。</p>
            )}
            <div className="divider" />
            <h3>模型用量</h3>
            {snap.usage.map((u: any) => (
              <p className="small muted" key={u.runId}>
                Run {short(u.runId)} · {u.calls} 次调用 · 输入{" "}
                {u.inputTokens ?? "未知"} / 输出 {u.outputTokens ?? "未知"}{" "}
                tokens
              </p>
            ))}
            {!snap.usage.length && (
              <p className="small muted">尚无模型调用。</p>
            )}
          </section>
          <section className="card">
            <h3>节点操作</h3>
            {snap.operations
              .filter((o: any) => o.kind !== "inspect")
              .map((o: any) => (
                <div className="operation" key={o.id}>
                  <div className="row">
                    <code>{o.kind}</code>
                    <Badge state={o.state} />
                    {["failed", "unknown"].includes(o.state) && (
                      <button
                        className="small"
                        onClick={() =>
                          void act(`/v1/operations/${o.id}/retry`).catch(
                            () => {},
                          )
                        }
                      >
                        核对并重试
                      </button>
                    )}
                  </div>
                  {o.result?.error && (
                    <p className="small muted">{o.result.error}</p>
                  )}
                </div>
              ))}
          </section>
        </div>
      )}
      <div className="footer row between">
        <span>创建于 {when(t.createdAt)}</span>
        <div className="row">
          <button
            className="ghost small"
            disabled={!!t.currentRunId}
            onClick={() =>
              void act(`/v1/tasks/${taskId}/environment/stop`).catch(() => {})
            }
          >
            停止空闲环境
          </button>
          <button
            className="ghost small"
            disabled={!!t.currentRunId}
            onClick={() =>
              void act(`/v1/tasks/${taskId}/lifecycle`, {
                action: t.lifecycle === "archived" ? "reopen" : "archive",
              }).catch(() => {})
            }
          >
            {t.lifecycle === "archived" ? "重新打开" : "归档任务"}
          </button>
          <button
            className="ghost small danger"
            disabled={!!t.currentRunId}
            onClick={() => setDeleting(true)}
          >
            删除
          </button>
        </div>
      </div>
      {deleting && (
        <Modal title="删除任务与环境" close={() => setDeleting(false)}>
          <p style={{ marginTop: 20 }}>
            这会删除该任务的工作区、原生会话和已上传产物。远程 Git 分支与 PR
            会保留。
          </p>
          <div
            className="row"
            style={{ justifyContent: "flex-end", marginTop: 24 }}
          >
            <button onClick={() => setDeleting(false)}>保留任务</button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void act(`/v1/tasks/${taskId}/lifecycle`, { action: "delete" })
                  .then(() => setDeleting(false))
                  .catch(() => {})
              }
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
function Conversation({ events, runs }: { events: any[]; runs: any[] }) {
  const visible = events.filter(
    (e) =>
      ["assistant/message", "tool/call", "tool/result"].includes(e.type) ||
      (e.type === "user/message" && e.data?.source?.kind === "user"),
  );
  return (
    <>
      {!visible.length &&
        runs.map((r) => (
          <div className="message user" key={r.id}>
            <div className="small muted">你 · Run {r.ordinal}</div>
            <p className="message-body">{r.input}</p>
          </div>
        ))}
      {visible.map((e) => {
        const m = e.data?.message ?? e.data,
          content = m?.content ?? [];
        if (e.type === "user/message" || e.type === "assistant/message") {
          const text = Array.isArray(content)
            ? content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text)
                .join("\n")
            : String(content);
          return text ? (
            <article
              className={`message ${e.type === "user/message" ? "user" : ""}`}
              key={e.seq}
            >
              <div className="small muted">
                {e.type === "user/message" ? "你" : "DSH"} · #{e.seq}
              </div>
              <div className="message-body">{text}</div>
            </article>
          ) : null;
        }
        return (
          <details key={e.seq}>
            <summary>
              {e.type === "tool/call" ? "↗ 工具调用" : "↳ 工具结果"} ·{" "}
              {m?.name ??
                m?.toolName ??
                m?.call?.name ??
                events.find(
                  (x) =>
                    x.type === "tool/call" &&
                    x.data?.callId === (m?.callId ?? m?.toolCallId),
                )?.data?.name ??
                "完成"}{" "}
              · #{e.seq}
            </summary>
            <pre>{JSON.stringify(e.data, null, 2)}</pre>
          </details>
        );
      })}
      {events.length > 0 && (
        <details style={{ marginTop: 20 }}>
          <summary>原生执行记录 · {events.length} 个持久化事件</summary>
          {events
            .filter((e) => !visible.includes(e))
            .map((e) => (
              <details key={e.seq}>
                <summary>
                  #{e.seq} {e.type}
                </summary>
                <pre>{JSON.stringify(e.data, null, 2)}</pre>
              </details>
            ))}
        </details>
      )}
    </>
  );
}
function Interaction({
  item,
  submit,
}: {
  item: any;
  submit: (answer: any) => Promise<any>;
}) {
  const [answers, setAnswers] = useState<
      Record<string, { selected: string[]; custom?: string }>
    >({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const send = async (answer: any) => {
    setBusy(true);
    try {
      await submit(answer);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <section className="question">
      <div className="eyebrow">WAITING FOR YOU</div>
      <h2>
        {item.kind === "approval" ? "需要单次操作授权" : "任务有问题需要你回答"}
      </h2>
      <ErrorBox error={error} />
      {item.kind === "approval" ? (
        <>
          <pre>{JSON.stringify(item.body, null, 2)}</pre>
          <div className="row">
            <button
              className="primary"
              disabled={busy}
              onClick={() => void send({ outcome: "allowed-once" })}
            >
              允许这一次
            </button>
            <button
              disabled={busy}
              onClick={() => void send({ outcome: "rejected" })}
            >
              拒绝
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send({
              answers: item.body.questions.map((q: any) => ({
                id: q.id,
                selected: answers[q.id]?.selected ?? [],
                ...(answers[q.id]?.custom
                  ? { custom: answers[q.id].custom }
                  : {}),
              })),
            });
          }}
        >
          {item.body.questions.map((q: any) => (
            <div key={q.id}>
              <label>{q.question ?? q.title}</label>
              {q.options?.map((option: any) => {
                const label =
                  typeof option === "string" ? option : option.label;
                return (
                  <label className="check" key={label}>
                    <input
                      type={
                        q.multiSelect || q.multi_select ? "checkbox" : "radio"
                      }
                      name={q.id}
                      checked={answers[q.id]?.selected.includes(label) ?? false}
                      onChange={(e) =>
                        setAnswers({
                          ...answers,
                          [q.id]: {
                            ...answers[q.id],
                            selected:
                              q.multiSelect || q.multi_select
                                ? e.target.checked
                                  ? [...(answers[q.id]?.selected ?? []), label]
                                  : (answers[q.id]?.selected ?? []).filter(
                                      (x) => x !== label,
                                    )
                                : [label],
                          },
                        })
                      }
                    />
                    {label}
                  </label>
                );
              })}
              <input
                aria-label={`${q.question ?? q.title}，补充回答`}
                placeholder="或输入补充回答"
                value={answers[q.id]?.custom ?? ""}
                onChange={(e) =>
                  setAnswers({
                    ...answers,
                    [q.id]: {
                      selected: answers[q.id]?.selected ?? [],
                      custom: e.target.value,
                    },
                  })
                }
              />
            </div>
          ))}
          <div className="row" style={{ marginTop: 16 }}>
            <button className="primary" disabled={busy}>
              提交回答
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void send({ cancelled: true })}
            >
              取消问题
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
async function resolveOperation(transport: Transport, path: string) {
  const r = await transport.request(path);
  if (r.offline) return r;
  if (!r.operationId) return r;
  for (let n = 0; n < 180; n++) {
    await new Promise((r) => setTimeout(r, 500));
    const op = await transport.request(`/v1/operations/${r.operationId}`);
    if (op.state === "succeeded") return op.result;
    if (["failed", "unknown"].includes(op.state))
      throw new Error(op.result?.error ?? "节点操作未完成");
  }
  throw new Error("节点仍在处理，请稍后刷新。");
}
function RemoteView({
  path,
  transport,
  render,
}: {
  path: string;
  transport: Transport;
  render: (value: any) => React.ReactNode;
}) {
  const [value, setValue] = useState<any>(),
    [error, setError] = useState(""),
    [version, setVersion] = useState(0);
  useEffect(() => {
    let stopped = false;
    setValue(undefined);
    setError("");
    void resolveOperation(transport, path)
      .then((r) => {
        if (!stopped) setValue(r);
      })
      .catch((e) => {
        if (!stopped) setError(e.message);
      });
    return () => {
      stopped = true;
    };
  }, [path, transport, version]);
  return (
    <>
      <div className="row between">
        <span className="small muted">从任务环境读取</span>
        <button className="small" onClick={() => setVersion((v) => v + 1)}>
          刷新
        </button>
      </div>
      <ErrorBox error={error} />
      {!value && !error ? (
        <p className="muted" style={{ marginTop: 20 }}>
          正在等待节点返回…
        </p>
      ) : value?.offline ? (
        <div className="notice">
          节点离线。请在“结果与交付”查看已保存的快照。
        </div>
      ) : value ? (
        render(value)
      ) : null}
    </>
  );
}
function Files({
  taskId,
  transport,
}: {
  taskId: string;
  transport: Transport;
}) {
  const [file, setFile] = useState<string>();
  return (
    <RemoteView
      path={`/v1/tasks/${taskId}/files`}
      transport={transport}
      render={(r) => (
        <div className="split">
          <div className="file-list">
            {r.files.map((f: any) => (
              <button
                key={f.path}
                onClick={() => setFile(f.path)}
                title={f.path}
              >
                {f.symlink ? "↗" : "▤"} {f.path}
              </button>
            ))}
            {r.truncated && <p className="small muted">文件列表已截断</p>}
          </div>
          <div>
            {file ? (
              <>
                <h3>{file}</h3>
                <RemoteView
                  key={file}
                  path={`/v1/tasks/${taskId}/files?path=${encodeURIComponent(file)}`}
                  transport={transport}
                  render={(r) =>
                    r.encoding === "utf8" ? (
                      <pre>{r.content}</pre>
                    ) : (
                      <p className="notice">二进制文件 · {r.size} bytes</p>
                    )
                  }
                />
              </>
            ) : (
              <p className="muted" style={{ marginTop: 20 }}>
                选择文件以预览内容。
              </p>
            )}
          </div>
        </div>
      )}
    />
  );
}
function Artifact({
  artifact,
  transport,
}: {
  artifact: any;
  transport: Transport;
}) {
  const [value, setValue] = useState<any>(),
    [error, setError] = useState(""),
    [download, setDownload] = useState("");
  useEffect(() => {
    if (!value) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value.body, null, 2)], {
        type: "application/json",
      }),
    );
    setDownload(url);
    return () => URL.revokeObjectURL(url);
  }, [value]);
  return (
    <details
      onToggle={(e) => {
        if (e.currentTarget.open && !value)
          void transport
            .request(`/v1/artifacts/${artifact.id}`)
            .then(setValue)
            .catch((e) => setError(e.message));
      }}
    >
      <summary>
        {artifact.kind} · {short(artifact.revision)} ·{" "}
        {when(artifact.createdAt)} · {artifact.size} bytes
      </summary>
      <ErrorBox error={error} />
      {value && (
        <>
          <a download={`${artifact.id}.json`} href={download}>
            下载产物 JSON
          </a>
          <pre>{value.body.diff ?? JSON.stringify(value.body, null, 2)}</pre>
        </>
      )}
    </details>
  );
}
function RecoveryBanner({
  transport,
  reload,
}: {
  transport: Transport;
  reload: () => Promise<void>;
}) {
  const [ack, setAck] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="notice">
      <h3>数据库恢复核对中</h3>
      <p>
        所有执行节点需要重新连接并确认容器已停止。核对结束后，各任务仍保持暂停，请检查工作区再恢复。
      </p>
      <label className="check">
        <input
          type="checkbox"
          checked={ack}
          onChange={(e) => setAck(e.target.checked)}
        />
        我将核对外部操作结果，并重新提交仍需执行的输入。
      </label>
      <ErrorBox error={error} />
      <button
        disabled={!ack}
        onClick={() =>
          void transport
            .request("/v1/recovery/complete", { acknowledgeUncertain: true })
            .then(reload)
            .catch((e) => setError(e.message))
        }
      >
        完成节点核对
      </button>
    </section>
  );
}
function RunnerManager({
  transport,
  runners,
  close,
  reload,
}: {
  transport: Transport;
  runners: any[];
  close: () => void;
  reload: () => Promise<void>;
}) {
  const [pair, setPair] = useState<any>(),
    [error, setError] = useState("");
  return (
    <Modal title="执行节点" close={close}>
      <p className="lead small">
        个人电脑和服务器使用同一个 Runner。每个任务固定使用创建时选择的节点。
      </p>
      {runners.map((r) => (
        <div className="run-card" key={r.id}>
          <div className="row between">
            <h3>{r.name}</h3>
            <span className="badge">
              {r.revoked
                ? "已撤销"
                : Date.now() - r.lastSeenAt < 30000
                  ? "● 在线"
                  : "○ 离线"}
            </span>
          </div>
          <p className="small muted">
            {r.platform} · 并发 {r.capacity} · {when(r.lastSeenAt)}
          </p>
          {!r.revoked && (
            <button
              className="ghost small danger"
              onClick={() => {
                if (confirm(`撤销 ${r.name}？该节点恢复连接时将停止任务。`))
                  void transport
                    .request(`/v1/runners/${r.id}/revoke`, {})
                    .then(reload)
                    .catch((e) => setError(e.message));
              }}
            >
              撤销节点
            </button>
          )}
        </div>
      ))}
      <ErrorBox error={error} />
      <button
        className="primary"
        onClick={() =>
          void transport
            .request("/v1/runner-pairings", {})
            .then(setPair)
            .catch((e) => setError(e.message))
        }
      >
        生成 Runner 配对码
      </button>
      {pair && (
        <div className="notice">
          <p className="small">10 分钟内在安装了本项目的节点上运行：</p>
          <pre>{`CLOUD_CONTROL_URL="${pair.controlUrl}" \\\nCLOUD_PAIR_CODE="${pair.code}" npm run runner -- pair`}</pre>
          <p className="small">
            配对后启动 Runner 守护进程。容器访问控制服务的地址按部署说明配置。
          </p>
        </div>
      )}
    </Modal>
  );
}

export function DeviceApproval({ transport }: { transport: Transport }) {
  const deviceId = new URLSearchParams(location.search).get("device"),
    [code, setCode] = useState(""),
    [done, setDone] = useState(false),
    [error, setError] = useState("");
  if (!deviceId || done) return null;
  return (
    <div className="dsh-cloud">
      <style>{styles}</style>
      <Modal
        title="连接 DSH 设备"
        close={() => {
          history.replaceState({}, "", "/");
          setDone(true);
        }}
      >
        <p className="lead">
          输入 DSH 插件显示的设备码，授权该设备访问你的云任务。
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await transport.request("/auth/device/approve", {
                deviceId,
                userCode: code,
              });
              setDone(true);
              history.replaceState({}, "", "/");
            } catch (e: any) {
              setError(e.message);
            }
          }}
        >
          <label>
            设备码
            <input
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              autoComplete="off"
            />
          </label>
          <ErrorBox error={error} />
          <button className="primary" style={{ marginTop: 15 }}>
            授权设备
          </button>
        </form>
      </Modal>
    </div>
  );
}
