# DSH Cloud MVP

把一个任务固定到同一个 **DSH 原生 Session、持久工作区和执行节点**，从 DSH 插件或浏览器继续访问。客户端退出不会停止任务。这个仓库包含可运行的控制服务、Runner、Executor、网页、DSH 插件、GitHub Draft PR 发布和部署脚本。

服务与桌面插件版本：`0.1.3`。本轮在桌面发行版自带的 DSH `0.2.1-rc.5` Host 中安装插件，并通过 Chrome 验证原生会话 UI；Electron 桌面窗口本轮未重跑。适配器支持固定的 `0.2.1-rc.5` / `0.2.2-alpha.2` 接口；远端 DSH / SDK 固定为 `0.2.2-alpha.2`、Node `24.19.0`。适用于本人管理的单用户服务。当前验收结果与尚未实测的环境见 [验收记录](docs/TEST_REPORT.md)；原始设计见 [设计方案](docs/DESIGN.md)。

## 先运行本地演示

需要 Node 24.19.x、npm、Git 和可用的 Linux Docker 后端。macOS 使用已配置的 Docker Desktop 或兼容后端；Linux 安装方法见 [Docker 官方文档](https://docs.docker.com/engine/install/)。

```sh
npm ci
npm run build
docker build -t dsh-cloud-runtime:0.1.3 -f deploy/runtime-images/Dockerfile .
npm run demo
```

打开终端输出的本地 URL。开发登录令牌位于输出中指定的 `development-token` 文件，权限为 `0600`。演示使用**固定的本地模型响应**，实际执行 Control → Runner → Docker → DSH SDK → 文件工具 → 检查 → 持久化的完整链路，无需上游 API Key。

可在任务中输入「读取当前任务说明」继续读取原文件，或输入「提问让我选择下一步」测试跨客户端回答。在桌面原生文件预览、云端结果或浏览器任务页查看真实工作区与检查记录。输入 `WAIT_FOR_CANCEL` 会等待 30 秒且不执行工具，可用于测试停止按钮。演示不连接外部 GitHub 仓库，不创建外部 PR。`Ctrl+C` 停止该演示所属容器并保留 `.state/demo` 数据；再次启动继续使用它们。

## 组件

| 目录 | 职责 |
| --- | --- |
| `apps/control` | 单 owner OIDC / 开发登录、设备授权、节点配对、SQLite 队列、持久事件、模型转发、备份恢复门禁 |
| `apps/runner` | 常驻节点进程、Docker 核对、工作区和镜像管理、停止确认、受限 Git 发布 |
| `apps/executor` | 容器内真实 SDK、原生 Session 恢复、durable outbox、问题与单次授权、检查和结果清单 |
| `apps/web`、`packages/task-ui` | 独立浏览器入口，用于任务访问、设备授权及运维 |
| `packages/dsh-cloud-plugin` | 原生会话、文件与工作区路由；原有输入框的位置选择、结果入口和设置；Host 保存设备凭据 |
| `packages/dsh-cloud-runtime` | 通过 DSH `sessionPersistence.flush/open(read)` 读取原生持久前缀 |
| `packages/git-provider` | 可信 bare mirror、固定工作区版本、GitHub Draft PR 幂等发布 |

每个 Task 只有一个 Session 和 Environment，多次 Run 按服务端顺序串行执行。只有原 Runner 确认旧容器已停止，才能增加运行代次。恢复时不会通过总结重新创建会话，也不会自动重新发送结果不确定的输入。

首版控制服务配置一条 Messages 模型线路。创建任务时显示模型及模板预算，并保存模型名称和上游地址摘要。更换上游地址或模型后，旧任务会拒绝继续，直到恢复原线路；密钥轮换不改变绑定。

## 接入真实模型与仓库

1. 复制 `.env.example` 为 `.env`，设置权限 `chmod 600 .env`。填入模型 Key、允许的 Git 主机，以及公网部署所需的 OIDC 信息。DSH 当前适配的是 **Messages 协议**，模型地址默认 `https://api.deepseek.com/anthropic`。
2. 修改 `deploy/templates.json`，设置实际镜像、初始化命令和检查命令。模板创建后不可原地修改；更改配置时递增 `version`。首次解析镜像后，每个任务记录具体 image ID。跨机器部署应使用自己的镜像仓库与不可变 digest。
3. 本地开发可显式启用 `CLOUD_DEVELOPMENT=1`、loopback `CLOUD_PUBLIC_URL` 和至少 32 字符的随机 `CLOUD_DEV_TOKEN`，然后启动控制服务：

```sh
node --env-file=.env dist/apps/control/main.js
```

生产部署请使用 OIDC 与 HTTPS，见 [部署与运维](docs/OPERATIONS.md)。浏览器使用 HttpOnly Cookie，DSH Host 通过设备授权保存独立设备凭据，Client 不持有长期访问令牌。

### 注册 Runner

在网页「执行节点」中生成配对码，然后在实际执行机器上运行：

```sh
CLOUD_CONTROL_URL=https://cloud.example.com \
CLOUD_PAIR_CODE='<网页生成的一次性配对码>' \
CLOUD_RUNNER_ROOT=/absolute/path/to/runner-data \
CLOUD_RUNNER_CONFIG=/absolute/path/to/runner-config.json \
node dist/apps/runner/main.js pair

CLOUD_RUNNER_CONFIG=/absolute/path/to/runner-config.json \
node --env-file=deploy/runner/runner.env dist/apps/runner/main.js
```

`runner.env` 从同目录的示例复制，权限设为 `0600`。只读仓库也可以不配置 Git token；私有 checkout 和 Draft PR 需要相应仓库权限。GitHub 发布使用 Runner 上的 `CLOUD_GITHUB_TOKEN`；长期 Git 凭据不进入任务容器。模型 Key 只存在控制服务。

本地控制服务监听时，容器不能使用宿主机的 `127.0.0.1`；配对时另设 `CLOUD_EXECUTOR_CONTROL_URL=http://host.docker.internal:8787`。远程部署通常与 `CLOUD_CONTROL_URL` 相同。Runner 和 Executor 都需要访问控制服务。

```sh
CLOUD_RUNNER_CONFIG=/absolute/path/to/runner-config.json npm run doctor
npm run runner:service -- --dry-run --config /absolute/path/to/runner-config.json --env /absolute/path/to/runner.env
npm run runner:service -- install --config /absolute/path/to/runner-config.json --env /absolute/path/to/runner.env
```

安装器在 Linux 创建用户级 systemd service，在 macOS 创建 LaunchAgent。`uninstall` 只卸载服务，保留任务容器和数据。不要把 Runner 或 Docker socket 挂载进任务容器。

### 安装 DSH 插件

```sh
npm run build
npm pack ./dist/plugin --pack-destination .
dsh plugin --profile desktop add /absolute/path/to/dsh-cloud-plugin-0.1.3.tgz
```

在目标 profile 的 `package.json` 中，将 `dsh-cloud-plugin` 加入 `dsh.profile.bundles` 数组，保留原有 bundle。在该 profile 的 `cordis.patch.yml` 追加：

```yaml
- id: dsh-cloud-plugin
  config:
    serviceUrl: https://cloud.example.com
```

桌面端使用 `desktop` profile；独立 Web Host 使用 `web` profile。重启对应 DSH 后：

1. 在原有设置的「云端执行」登录，或在新会话输入框旁的「本地」→「云端」中登录。浏览器确认设备授权后，Host 保存设备凭据。
2. 新建原生会话，输入框只显示一个紧凑的「本地 / 云端」选择器。首次选择云端时配置执行节点、模板及 Git 仓库；已有默认配置时直接切换，再用原来的输入框发送第一条消息。
3. 云端会话出现在原有侧栏，用云图标区分；消息、工具、提问、授权和文件预览都使用 DSH 原有组件。
4. 发送首条消息后隐藏位置选择器，对话框不再显示执行位置、节点状态或云端结果条；只有侧栏历史条目保留云图标。追问继续原 Session / Environment。
5. 设置 →「云端执行」→「云端会话」提供检查、Diff、Draft PR、空闲环境停止及恢复操作。停止后需恢复时，在这里选择会话并点「准备恢复会话」，再返回原会话输入新指令。待答时仍使用 DSH 原生卡片。

插件不再注册独立的云任务主面板。打开云端历史不会创建本地 Agent 或本地 Session 文件。已识别的云端 ID 在断线、退出登录或凭据失效后也不会回退到本地执行。每台设备各自登录同一 owner。

该实现适配固定版本的原生服务；DSH 当前没有公开的远程会话 Provider 注册接口，因此升级 DSH 前需重新核对服务契约。文本、原生问答、文件、重命名、置顶及归档已接入；附件、分支会话、切换模型及本地终端等操作未对云端开放。云端模型由控制服务固定。

Host 提供 `cloud_start`、`cloud_list`、`cloud_get`、`cloud_followup`、`cloud_cancel`、`cloud_publish` 六个工具。创建任务返回 task ID 和网页链接；远端的完整历史保存在云任务中。

## 测试与构建

```sh
npm run typecheck
npm test                         # 控制、恢复、存储、模型转发、真实 Git
npm run test:runtime              # 真实 DSH SDK；默认跳过 Docker E2E
CLOUD_DOCKER_TEST=1 npm run test:runtime  # 真实 Docker / Runner / Executor E2E
npm run build
```

测试使用隔离的临时目录和带本次 Runner 标签的容器，只清理它们。运行 Docker E2E 前需保证本地存在 `dsh-cloud-runtime:0.1.3`。模型 fixture 只替代上游模型响应，未替代 DSH、文件工具、Shell、Runner 或 Docker。Git 测试实际使用 Git daemon 和 push；GitHub REST 用受控 fixture 注入响应丢失。

真实模型验收是可选的独立命令，会消耗实际模型额度。可以使用 `CLOUD_MODEL_BASE_URL`、`CLOUD_MODEL_API_KEY`、`CLOUD_MODEL_NAME`，或显式选择本机 DSH 中已配置的 Messages provider：

```sh
CLOUD_TEST_DSH_HOME="$HOME/.dsh" node --import tsx scripts/test-live-model.ts
```

脚本只读取配置，不修改 DSH；长期模型凭据仅保存在控制进程内存中。验收执行真实文件写读、停止容器、恢复原 Session，再次读取原文件，结束后回收自己的临时环境。当前 DSH 配置导入仅支持 `llm-pi-ai` 的 `anthropic-messages` provider；其他 provider 使用其兼容 Messages 入口配置。

在 macOS 上额外验证 Linux Runner 时，可以构建受控 supervisor 测试镜像：

```sh
docker build -t dsh-cloud-linux-acceptance:0.1.1 -f deploy/runner/Dockerfile.acceptance .
node --import tsx scripts/test-linux-runner.ts
```

此命令仅用于受信任的验收代码：测试 supervisor 会挂载 Docker socket，因此能够管理整个 Docker 后端。任务容器始终不挂载该 socket。脚本使用独立测试网络和目录并在完成后回收。可用 `CLOUD_TEST_DOCKER_SOCKET` 指定后端 socket。小型验收模板预留 512 MiB；默认产品模板仍要求至少 2048 MiB。

多架构构建可在对应机器上执行同一 Dockerfile，或使用：

```sh
docker buildx build --platform linux/amd64 -t dsh-cloud-runtime:0.1.3-amd64 --load -f deploy/runtime-images/Dockerfile .
docker buildx build --platform linux/arm64 -t dsh-cloud-runtime:0.1.3-arm64 --load -f deploy/runtime-images/Dockerfile .
```

本次实际平台与镜像 ID 记录在 `docs/compatibility-lock.json`，没有验证的平台不会标记为已通过。

## 使用边界

- 首版支持文本输入、单仓库、单 owner、GitHub Draft PR，合并由用户后续评审。
- 环境使用 Linux 容器，macOS Runner 不提供原生 macOS / GUI 工具链。
- 节点离线不会被当作停止，也不会自动迁移任务。历史和已有产物可离线查看。
- 原生格式损坏、日志缺失、检查点冲突、SDK 回执不确定时暂停，不生成新的空 Session 冒充恢复。
- 取消完成必须有容器停止证明。恢复输入会取消旧的待执行输入，避免恢复后执行过时命令。
- 必需检查失败时可交付结果；创建 Draft PR 需要明确允许。外部 Git 分支变化会中止发布，不强推覆盖。
- 卷持续保留到用户删除。磁盘不足拒绝新环境；运行中的空间耗尽以存储错误处理。
- 交付配置不包含真实模型 Key、OIDC 身份源、GitHub token、域名或公网部署。代码中的标准接口已实现，实际账号和企业网络接入需要在目标环境验收。

## 本机桌面演示记录

此次已将 0.1.1 插件装入本机 DSH `0.2.1-rc.5` 的 desktop profile；原模型配置保持一致。当前本地服务连接固定模型 fixture，只用于界面和执行协议演示。桌面侧栏中的「桌面端云任务验收」保留了问答、停止、恢复和读文件记录。当前演示服务退出后，可运行交付目录旁的 `启动桌面云端演示.command` 继续同一测试数据；该脚本适用于本机交付目录，不属于远程部署步骤。服务未安装为登录自启项。
