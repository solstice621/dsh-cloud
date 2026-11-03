# 部署与运维

## 控制服务

只运行一个控制实例，SQLite WAL 必须位于本地持久盘。不要放到 NFS，也不要复制多个实例共用数据库。

生产环境先创建 OIDC confidential client，回调地址为 `https://你的域名/auth/callback`，配置稳定的 owner `sub`，再填写 `.env`。不根据邮箱相似度授权其他账号。配置的 `CLOUD_PUBLIC_URL` 必须与实际 Origin 相同，浏览器写入需要匹配 Origin。

```sh
docker build -t dsh-cloud-runtime:0.1.3 -f deploy/runtime-images/Dockerfile .
docker build -t dsh-cloud-control:0.1.3 -f deploy/control/Dockerfile .
docker compose --env-file .env -f deploy/control/compose.yaml up -d
```

Compose 提供持久卷和 Caddy HTTPS 反向代理。DNS 与 80/443 端口需要已准备好。Caddy 固定为 [2.10.2](https://github.com/caddyserver/caddy/releases/tag/v2.10.2)；实际发布前可按组织基线升级并重新验证。模板中的 runtime 镜像还需安装到每个 Runner 的 Docker 后端。

`/healthz` 返回 cloud protocol 与 DSH 版本；不返回凭据。当前实现的事件补读和 Typert 轮询都有游标检查。正常事件不是逐 token 推送，而是 DSH 持久化后的批次。

## Runner 和网络

Runner 必须运行在受信任的非 root 主机用户下，该用户需要能管理其 Docker 后端；以 root 启动会被拒绝。任务容器使用非 root UID、只读根文件系统、独立工作区和 DSH home、CPU/内存/PID 限制，去除 capabilities；不挂载宿主机 home、Runner 身份目录或 Docker socket。

`/tmp` 是容器内独立 tmpfs，允许执行，因为 DSH 的原生模块需要在临时目录映射其加载文件。每个运行代次使用独立的配置文件名，避免 macOS Docker bind mount 在原子替换同名文件后的可见性问题。原生 IPC socket 位于容器 tmpfs，避免 macOS bind mount 对 socket chmod 的限制。

Executor 的持久日志使用 SQLite rollback journal 与 `synchronous=FULL`。运行期间只有 Executor 访问它；确认容器停止后，Runner 才能打开并补传未确认的事件和结果。这样避免 macOS 宿主机与 Linux 容器轮流访问同一套 WAL / SHM 文件。控制数据库仍使用本机 SQLite WAL。

服务安装器默认用户级安装。Linux 如需未登录也运行，请由机器管理员设置该用户的 linger；macOS 仍依赖 Linux 容器后端已启动。退出 DSH 客户端与 Runner 服务无关。

企业网络可在控制服务和 Runner 环境中设置 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`NODE_USE_ENV_PROXY=1`；公司 CA 使用 `NODE_EXTRA_CA_CERTS` / `GIT_SSL_CAINFO`。不关闭 TLS 校验。任务模板可以配置独立 `proxy`：

```json
{"proxy":{"http":"http://proxy.sha.sap.corp:8080","https":"http://proxy.sha.sap.corp:8080","noProxy":"localhost,127.0.0.1,host.docker.internal,cloud.example.com"}}
```

这里只能使用当前节点实际可达的合法出口。项目不会更改系统代理、VPN 或 DNS。模板不接受带用户名/密码的代理 URL。初始化、任务工具和检查所需外部访问应在目标节点分别验证。

## 备份

控制服务可以在线创建 SQLite 一致快照，再复制快照引用的不可变产物。源产物若在备份期间被删除，备份会失败，不会写入成功 manifest。备份目录必须是新路径。

```sh
node dist/scripts/maintenance.js backup /data/control.sqlite /backups/control-20261102
```

`.env` 中的上游模型、OIDC 密钥不进入这个备份。数据库包含设备 / 节点认证状态和任务内容，备份文件应保持私有，使用组织认可的加密和访问控制。

Runner 数据的备份必须先在任务页停止环境，确认已停止，然后保存整个 Runner 根目录，包括 `runner.sqlite`、`trusted/`、`tasks/` 下的工作区、DSH 原生日志和 Executor journal。单独复制仓库或控制数据库不能构成完整环境备份。MVP 不执行在线跨节点迁移。

## 恢复控制数据库

1. 停止旧控制进程，保留原数据，确认不会再启动第二个控制实例。
2. 恢复到一个全新的数据目录：

```sh
node dist/scripts/maintenance.js restore /backups/control-20261102 /data/restored-20261102
```

3. 设置 `CLOUD_DATABASE` 和 `CLOUD_ARTIFACT_ROOT` 指向恢复目录，启动控制服务。恢复标志默认阻止派发新命令和模型请求。
4. 启动所有未撤销的 Runner。它们会停止自己所属的容器，提交完整停止清单。尚未连接的节点会阻止完成核对；不要将离线理解为已停止。
5. 在界面的恢复提示中确认核对。控制服务将旧的活跃 Run 标为中断，取消旧排队输入，把未完成节点操作标为待核对；所有任务仍暂停。
6. 检查各任务工作区和外部操作结果，再编写明确的恢复输入。DSH 读取原生 Session 和持久卷，新 Run 不重放旧输入。

恢复后出现的、备份中不存在的任务会以 orphan 清单返回，并保留原节点的停止容器与数据；MVP 不自动重建这些任务记录。`GET /v1/recovery` 和 `meta.lastRecovery` 可供管理员核对。无一致备份时不承诺恢复已丢失数据。

## 常见故障

| 现象 | 处理 |
| --- | --- |
| Runner 离线 | 检查服务、Docker 后端、控制 URL、代理和证书；保留原节点所有权 |
| 容器无法访问本机控制服务 | 使用 `CLOUD_EXECUTOR_CONTROL_URL=http://host.docker.internal:端口`；控制服务需监听可达接口 |
| 初始化命令中断 | 检查工作区后，使用「重试未完成的环境初始化」；不会自动重跑已确认完成的步骤 |
| Run 不确定 / 中断 | 等待停止确认，查看原生记录与文件，提交新的恢复输入 |
| 取消一直待确认 | 节点仍离线或 Docker stop 未确认；不要另起任务覆盖同一目录 |
| 原生日志缺失或冲突 | 保留现场，恢复兼容版本和一致卷；不能删除日志后冒充原 Session |
| PR 发布 unknown | 使用「核对并重试」；会查询任务分支和 PR，复用已有结果 |
| REMOTE_BRANCH_CHANGED | 人工评审远端提交；发布组件不会强推 |
| 产物校验失败 | 检查存储和备份，不能把损坏文件作为成功结果返回 |
| 运行时被撤销 | 禁止新派发 / 模型请求；Runner 重连后停止容器并提交专用停止确认 |
| 模型预算耗尽 | 原 Run 保留失败记录；核对后创建新的恢复输入或递增模板版本 |

## 升级

0.1.3 是 Control、Runner、Executor、网页和桌面插件的配套修复。仅替换桌面插件不能修复服务端恢复屏障、问答交付或 outbox。Control 首次启动自动把 schema 1 增量迁移到 schema 2，并从历史 Run 重建未解除的恢复屏障；迁移前必须保留备份。旧 Control 不应直接读取 schema 2，回退需恢复升级前备份。

本轮提供的新默认模板为版本 3。已有任务仍固定原模板与镜像 ID，不会因重新标记 `dsh-cloud-runtime:0.1.3` 自动升级；已有任务的 runtime 迁移需另行安排并保留原 Session、工作区和执行节点。本次修复没有迁移用户已有云任务。

1. 查看 `docs/compatibility-lock.json`，固定源码与完整 npm lock。
2. 先停止 / 完成活跃任务，备份控制服务和停止后的 Runner 卷。
3. 在隔离节点使用旧任务原生日志验证新 runtime，不能只测空会话。
4. 新模板必须使用新版本号；已有任务仍固定自己的模板与 image ID。
5. 当前 cloud protocol 为 1，不兼容的 DSH 握手会拒绝连接。

### 0.1.3 恢复与输出核对

- `recoveryRequired` / `recoveryRunId` 独立于暂停和归档状态。归档重开、恢复队列、取消后续排队项或重试环境初始化，都不会解除恢复屏障；先确认原容器停止，再针对记录中的 Run 提交显式恢复输入。
- 永久交付错误会记录 `outbox.reconciliation` 事件。完整原始请求保存在原节点 `executor-state/journal.sqlite` 的 `rejected_outbox` 表；核对原因和现场后再恢复。正常运行中的 `RUN_NOT_FOUND` 仍暂停任务，仅早于已记录数据库恢复代次的未知 Run 可作为孤立证据隔离。
- 云端结果按最终 UTF-8 JSON 请求总大小限制。超过上限的 Diff、日志或回答会明确标注截断；完整结果先持久保存到原节点 `executor-state/results/<runId>.json`。删除任务前按需要导出该目录。
- Runner 给停止后的日志补传最多 2 秒网络时间，上传失败不阻止停止确认；原始日志仍留在原卷，不能将停止确认当作全部结果已上传。
- 桌面出现 429 或网络错误时保留登录态并退避。离线退出立即清除本地凭据；若远端撤销未确认，界面保留提示。本地退出不等同于服务端令牌撤销。

卸载守护进程使用 `npm run runner:service -- uninstall`。删除任务通过产品界面执行；会删除该任务环境、原生日志和上传产物并清除对应聊天内容，远程 Git 分支和 PR 保留。

## 原生桌面接入

0.1.1 的插件直接接入 DSH 原生会话 UI。安装前保存目标 profile 的 `package.json`、`cordis.patch.yml`；卸载时只移除 `dsh-cloud-plugin` 对应依赖、bundle 和配置行，保留其他条目。桌面模型配置不由插件修改。

控制服务增量添加 `native_headers` 和 `run_requests` 两张表，保存真实原生头信息及前端输入关联 ID。启动时创建缺失表，不改写已有原生日志。已有任务仍使用固定的旧 image ID；新模板使用版本 2。升级前仍需备份。

原生适配不创建本地 Agent。设备凭据旁的 `.sessions.json` 保存已知云端 Session ID、未发送草稿和本机置顶；即使暂时无法连接控制服务，也禁止这些 ID 被本地运行时接管。原生 Shell、打开本机 Finder、上传附件、会话分支和模型切换不属于云端 MVP；文件读取通过 Runner 的受限快照接口。
