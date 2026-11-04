# DSH Cloud 测试指南

测试按失败后会丢失什么状态来组织，重点保证输入、答案、事件、结果和恢复屏障不会因响应丢失或重启而被错误重放。新增套件沿用 Node 自带 `node:test`，没有增加测试依赖。

## 环境与命令

- Node `24.19.0`，执行 `npm ci --no-audit --no-fund` 安装锁定依赖；需要 Git、Bash 和可用的临时目录。
- 核心套件需要监听本机回环端口，执行真实 SQLite、Git 和子进程；只允许文件访问的沙箱无法运行这些集成测试。
- SDK 套件使用固定 DSH / SDK `0.2.2-alpha.2`，启动真实 DSH，模型服务为本地 fixture，不需要 API Key。
- Docker 套件要求非 root Runner、有 Docker 访问权限、可用磁盘空间，以及包含当前构建的镜像。它会创建、停止、强制终止及删除带本次 Runner 标签的测试容器。

```sh
npm run test:ci

# 单独定位一个子系统
node --import tsx --test tests/executor-lifecycle.test.ts

# 真实 Docker 验收；镜像必须与当前源码一致
docker build -t dsh-cloud-runtime:0.1.3 -f deploy/runtime-images/Dockerfile .
npm run test:docker
```

`test:ci` 串行运行类型检查、构建、覆盖率门槛与 SDK 验收，任一失败都会返回非零退出码。核心用例限时 60 秒；SDK 文件限时 180 秒；Docker 场景限时 300 秒。`test:docker` 显式启用 Docker 测试，缺少 Docker 或镜像会失败，不会显示“跳过后成功”。旧 `test:runtime` 入口仍保留其默认跳过 Docker 的兼容行为。

## 测试分层

| 套件 | 关键断言 | 真实边界与替身 |
| --- | --- | --- |
| `control*.test.ts`、`reliability.test.ts` | 串行 Run、并发幂等、租约与代次、分页、身份、取消、发布检查、删除清理、数据库恢复 | 真实 HTTP / SQLite / 文件；模型与外部 GitHub 使用 fixture |
| `recovery-regressions.test.ts`、`delivery-regressions.test.ts` | 不确定结果的恢复屏障、旧备份隔离、答案只交付一次、HTTP 已提交后丢失回执、停止确认不依赖结果上传 | 真实 Control 与 journal；在发送边界注入错误 |
| `durability.test.ts` | journal 重开、旧 schema、事务回滚、冲突整批回滚、不可变文件并发写、UTF-8/JSON 上限 | 真实 SQLite 和文件系统；SQLite trigger 注入写失败 |
| `runner-lifecycle.test.ts` | 撤销前确认停止、心跳并发、未知容器阻止启动、容量限制、恢复协调、检查回执重启重放、暂停恢复、进程锁、启动响应丢失 | 真实 Control / HTTP / journal / Git checkout；仅 Docker 边界使用替身 |
| `docker-contract.test.ts` | 非特权隔离、固定镜像与配置、容器所有者、暂停后停止、强制终止、运行中拒绝删除 | 对 Docker CLI 边界的契约测试；由真实 Docker 套件补充运行证据 |
| `executor-lifecycle.test.ts` | 输入提交前写 journal、确认丢失不重送、原生日志收据和 turn/end、结果落盘失败、检查失败、初始化恢复屏障、分批历史先于完成状态、答案取消、停止与重复命令 | 真实 Control / HTTP / SQLite / Git / Bash / 文件；SDK 调用和检查点使用受控替身 |
| `client-*.test.ts`、`native-plugin.test.ts` | 多 Host 请求预算、缓存竞争、429 退避、离线退出、登录竞争、分页与重连、卸载后晚到响应、原生路由 | 虚拟时钟与异步控制点；Host/Remote 使用替身 |
| `transport-process.test.ts` | 禁止带凭据重定向、错误响应与取消、轮询游标和卸载清理、输出上限、超时后强制终止、Abort listener 清理 | 真实本机 HTTP 与子进程；轮询使用虚拟时钟 |
| `git.test.ts` | clone/checkout 中断、原改动保留、真实 commit/push、发布回执丢失、远端冲突、路径与 symlink | 真实本机 Git daemon；GitHub REST 替身 |
| `runtime/sdk.test.ts` | 文件写读、Shell、问答、一次授权、关闭后恢复原生 Session | 真实 DSH SDK 与工具；本地模型 fixture |
| `runtime/docker.test.ts` | Runner 与 Control 重启、原 Session/Environment/文件保留、真实问答回执丢失、任务隔离、取消、强制崩溃与显式恢复 | 真实 Docker / Runner / Executor / DSH；本地模型 fixture |

测试使用 `t.mock` 自动还原替身、临时目录和任务级清理。时序竞争优先使用可控制的 Promise 和虚拟时钟；子进程/SDK/Docker 测试使用实际等待和明确超时。避免依赖公网、现有用户会话、付费模型或用户仓库内容。

## 覆盖率与 CI

`npm run test:coverage` 使用 Node V8 覆盖率，输出 `coverage/lcov.info`。统计包含核心回归套件实际加载的 `apps/**/*.ts`、`packages/**/*.ts` 和 `.tsx`，排除依赖、测试和脚本。行、分支、函数的聚合最低门槛分别是 **85%、80%、75%**。

这是**已加载模块的覆盖率**，不是全仓库覆盖率：未导入的 CLI 入口和完整 React 页面不会自动计入；SDK 子进程、Docker 内部代码也不与核心 LCOV 合并。Host 工具注册、完整 UI 和公网 OIDC 路径仍有覆盖缺口。不能通过只导入更多模块或降低门槛代替有行为断言的测试。

`.github/workflows/tests.yml` 在 push、pull request 和手动运行时执行：

1. `ubuntu-24.04`、`macos-15`：`npm ci` → `npm run test:ci` → 上传 LCOV，保留 14 天。
2. `ubuntu-24.04`：锁定依赖构建 runtime 镜像 → `npm run test:docker`。

工作流仅有 `contents: read` 权限，不使用用户的 GitHub token、模型密钥或 OIDC 凭据。Actions 按官方发行版的完整 SHA 固定：[checkout v6.1.0](https://github.com/actions/checkout/releases/tag/v6.1.0)、[setup-node v6.5.0](https://github.com/actions/setup-node/releases/tag/v6.5.0)、[upload-artifact v6.0.0](https://github.com/actions/upload-artifact/releases/tag/v6.0.0)。Node 覆盖率选项见 [Node 24 test runner](https://nodejs.org/docs/latest-v24.x/api/test.html#collecting-code-coverage)。

## 2026-11-04 扩展

核心回归从 **43 项增至 115 项**，新增 72 项。新增测试发现并修复：

- 同一个 native interaction ID 的幂等校验原先只比较内容；现在还要求 Run 和交互类型相同，防止复用旧问题或将问题误作审批。
- 轮询停止后的晚到失败原先仍会触发断线回调；现在停止后抑制事件与状态回调，并清理等待定时器。

本次执行结果、范围和限制见 [测试证据](testing-2026-11-04/summary.json)。2026-11-03 的版本安装、原生 UI 与截图证据保持原样，见 [历史验收记录](TEST_REPORT.md)；本次补测试不代表重新部署用户桌面或公网环境。
