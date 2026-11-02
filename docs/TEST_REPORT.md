# MVP 验收记录

日期：2026-11-02。当前桌面插件为 0.1.2，服务保持 0.1.1；历史版本的 Runner 验收不能视为本次全部重跑。

## 0.1.2 简化界面与本机安装

- `npm run typecheck`、`npm test`（26 项）、`npm run build` 通过。新增测试覆盖本地 / 云端首条输入前、发送中、等待首轮、已开始和未知状态的选择器可见性，以及渲染后只保留一个控件。
- 插件打包为 `dsh-cloud-plugin-0.1.2.tgz`，通过桌面应用自带的 DSH CLI 安装至 `~/.dsh/profiles/desktop` 并启用 bundle。安装前备份 profile；安装后的 Host / Client 文件与本次构建逐字节一致。
- 在本机 DSH `0.2.1-rc.5` 重启后实看：新会话显示紧凑「本地」入口，弹层只有本地 / 云端两项；未连接时点云端显示登录入口；已有本地会话隐藏选择器；设置中的「云端执行」正常注册。
- 原侧栏云图标注册保留；结果、Diff、Draft PR、环境停止和恢复组件迁至设置的云端会话选择器，不再注册聊天输入区状态栏。
- 按用户要求未部署或连接云端服务，因此本次没有实测已连接云端的侧栏图标、设置内远程操作或 Docker 执行；这些不能视为本次端到端验收通过。

## 0.1.1 原生 UI 验证

- 自动套件：24 项全部通过。新增原生会话路由与输入重试去重、真实 header 身份验证、云端文件路径边界、本地文件回退、重命名 / 置顶 / 归档、旧模板默认值，以及控制断线重连和完成状态同步。
- 真实 DSH SDK：单测通过，包含 read / write / bash、问题、单次授权、原 Session 恢复；durableSeq 64，7 次本地 fixture 调用。
- 本机桌面 DSH `0.2.1-rc.5`：已装入原生插件，保留既有模型配置和会话。原侧栏、聊天区、输入框、提问卡片和右侧 Markdown 文件预览真实验证。测试 Session 没有出现在本机 DSH 的会话持久目录中。
- 原生客户端退出与重开：等待问题时退出桌面应用，远端继续保持同一问题；重开后正常显示并提交答案。任务固定为同一个 Session 和 Environment。
- 当前桌面演示用固定的 `local-demo-fixture`，没有把预设文本称为真实上游模型回答。实际 Docker / DSH / 文件工具运行。桌面任务选择了未配置 checks 的 `node@1` 模板，不能把它报告为检查通过。
- 0.1.1 的 macOS Docker 端到端套件已重跑通过：真实容器写读、守护进程和环境重启、强制崩溃、取消与恢复；最终 epoch 4、durableSeq 102，取消确认用时 379 ms。这是受控环境的单次结果，不是性能保证。
- 桌面端原生停止已确认：一轮只等待、不执行文件或外部操作的演示输入，通过原生「停止生成」进入 cancelling；Runner 确认停止后进入 cancelled。随后用原生「准备恢复会话」与原输入框创建新的 recovery Run，保留同一 Session / Environment。
- 桌面停止空闲环境后，普通追问重新启动原环境；第 6 个 Run 使用真实 `read` 工具读回原文件。最终 epoch 5、durableSeq 93，6 个 Run 中 5 个成功、1 个按测试要求取消；文件摘要与初始内容一致。
- Linux、amd64 和真实上游 HAI 模型的证据仍属于 0.1.0 执行链路基线，本次 UI 改版没有把这些项目标为重新完成。

## 0.1.0 执行链路基线

| 验证 | 结果与范围 |
| --- | --- |
| 基线 TypeScript 与构建 | `npm run typecheck`、`npm run build` 通过；构建网页和独立 Host / Client 插件包 |
| 自动化控制与 Git 套件 | 18 项通过：幂等、串行队列、持久游标、SSE 重放、身份隔离、取消、恢复屏障、答案竞争、配对响应丢失与过期、CSRF、撤销、备份恢复、产物完整性、模型预算、线路固定与未知用量、真实 Git 发布及路径边界 |
| 真实 DSH SDK | 实际 write / read / bash / ask_user_question；一次真实单次授权；7 次 fixture 模型调用；关闭后恢复原 Session，已持久前缀保持一致 |
| macOS Runner + Docker | 实际控制服务、原生 macOS Runner、Linux 任务容器、Executor 与 DSH；写文件、检查、问题、Runner 重启、控制重启、停止环境后恢复、独立任务隔离、取消与显式恢复 |
| Linux Runner + Docker | 非 root Linux Runner 进程运行在受控验收容器中，真实控制服务 / Executor / DSH / 同卷恢复 / 强制崩溃 / 取消流程通过；宿主机 Docker 后端为本机 Docker Desktop |
| 真实模型 | 复用本机 DSH 配置的 HAI Messages / Claude Opus 4.8；两轮真实文件写读、容器停止后恢复原 Session、原生事件前缀一致通过；密钥仅在 Control 进程内存中 |
| amd64 runtime | 官方 Node 多架构 manifest 和各层哈希校验；amd64 镜像构建成功；无网络、无宿主机挂载、非 root 容器内真实 SDK 初始化、原生检查点与恢复通过（本机仿真执行） |
| DSH UI 与浏览器 | Chrome 中两个独立 DSH_HOME 的 Host、各自设备凭据及浏览器 Cookie 登录同一 owner；两端先后追问，浏览器回答；第三轮读取第一轮文件；文件、Diff、检查与产物可见 |
| 客户端退出 | 第四轮等待问题时退出发起任务的第二个 DSH Host，浏览器继续回答，任务独立于该客户端运行 |
| 本地演示入口 | 使用交付构建运行 `demo`，停止并重启整个演示后继续同一任务；同 Session / Environment、两轮完成 |
| 安装材料 | systemd / LaunchAgent 配置已生成；macOS plist 通过 `plutil -lint`；未把测试服务安装为用户机器的永久启动项 |

故障测试使用可重复的本地 Messages fixture，**DSH、工具、Shell、文件、SQLite、Runner 和 Docker 均为真实运行**。另有一组真实上游模型验收，复用用户授权的本机 HAI 线路；该记录和 fixture 分开保存。Git 测试实际 clone / snapshot / commit / push 到隔离 Git 服务；GitHub REST fixture 在已创建 PR 后故意丢弃响应，随后查询复用同一 PR。未在用户 GitHub 上创建外部 PR。

## 对照设计中的验收项

| 项目 | 覆盖情况 |
| --- | --- |
| A01–A04 跨客户端、追问、工作区保留 | 本机两个独立 DSH Host + 浏览器真实验证；不是两台物理设备的公网网络测试 |
| A05 隔离 | 真实 Docker 中两个 Task 的 Session / Environment / 工作区独立 |
| A06–A08 幂等、并发、游标与事件缺口 | HTTP / SQLite 集成验证，包括 SSE 补读、重复与冲突 |
| A09 flush 临界点崩溃 | 已验证持久前缀与恢复一致性；尚未对每一个 flush 指令边界做系统化崩溃注入 |
| A10–A11 控制 / Runner 重启 | 真实容器中断开并接回原环境，未重送输入 |
| A12 运行时崩溃 | Linux 和 macOS 均强制 kill 真实任务容器，先记录 interrupted，再通过新 recovery Run 恢复原 Session、文件和持久前缀 |
| A13 输入回执不确定 | 控制集成验证暂停与停止屏障；原始 SDK RPC 传输层丢包窗口未逐点注入 |
| A14 两端回答与旧答案 | 两端竞争、版本和 incarnation 检查通过；UI 跨客户端问答通过 |
| A15 取消 | 在线真实容器停止与后续队列暂停通过；离线待确认语义通过控制协议验证 |
| A16 发布响应丢失 | 真实 Git + GitHub REST fixture 验证复用、重试和远端修改冲突；未使用外部 GitHub 账号 |
| A17 权限与路径 | 错误身份、过期令牌、错误代次、路径穿越、软链接到外部与 .git 均拒绝 |
| A18 存储损坏 / 写满 | 产物篡改、native hash 冲突、SQLite 页数配额造成的 SQLITE_FULL 均不确认虚假成功；未填满真实磁盘或破坏真实用户卷 |
| A19 Linux 与 macOS Runner | 原生 macOS Runner 与非 root Linux Runner 进程均完成整条链路；Linux 进程在 Docker Desktop 的受控容器中验证，未在独立物理 Linux 服务器上运行 |
| A20 空闲停止再启动 | 真实 Docker 原卷、原 Session、同 environmentId，新运行代次通过 |
| A21 旧控制备份恢复 | 真实备份 / 恢复 CLI 和多节点确认协议通过；阻止旧输入自动派发，队列保持暂停 |
| A22 模型权限、预算与撤销 | HTTP 集成验证，包括撤销后只允许停止确认、上游错误用量记为未知 |

## 运行证据

当前构建版本、源码摘要及本机镜像 ID 见 [compatibility-lock.json](compatibility-lock.json)。当前验证状态见 [acceptance-results.json](acceptance-results.json)。0.1.0 基线原始输出保存在 [acceptance-results-0.1.0.json](acceptance-results-0.1.0.json)，源码摘要保存在 [compatibility-lock-0.1.0.json](compatibility-lock-0.1.0.json)。

当前桌面截图：[原生 DSH 桌面](native-desktop.jpg)。旧 [独立插件面板](dsh-plugin.jpg) 是被 0.1.1 替换的界面，仅保留作历史证据；[浏览器入口](web-task.jpg) 仍独立存在。

## 尚未完成的外部验收

- **公网部署与外部交付**：OIDC 身份源、GitHub token、域名 / TLS 和企业私有 Git 网络未配置。上游模型已通过本机 HAI 线路实测，但独立远程控制服务的模型网络仍需在目标环境验收。
- **服务常驻安装**：systemd / LaunchAgent 安装材料已生成，未安装为用户机器的永久服务；Linux 原生服务启动与物理主机故障仍需在实际执行节点验证。
- **长期和极端故障**：未进行长时间压力测试、物理主机休眠 / 掉电、真实磁盘故障、跨版本旧会话升级或跨节点迁移。MVP 遇到缺少原生日志或不确定结果时保持暂停，不自动伪造恢复。

本地构建期间曾触发真实磁盘余量保护。系统拒绝了新环境；清理本次下载的重复临时镜像档案后继续测试。没有清理用户原有容器、镜像或数据。

macOS 强制崩溃测试曾复现跨 macOS / Linux 共享目录中的 WAL / SHM 打开失败。Executor 日志改为单写入者 rollback journal，停止确认后才允许 Runner 读取；修复后两平台的强制崩溃恢复均通过。控制服务继续使用本地 WAL。
