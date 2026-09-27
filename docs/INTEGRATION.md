# DSH 接入决策记录（INTEGRATION）

> 日期：2026-09-17｜状态：S0 已完成（基于本机安装的 DSH 实物核对；运行级验证项见 §7 与 ACCEPTANCE.md）。
> 核对对象：`~/.dsh/tooling/node_modules/@deepseek-ai/*`（本机安装的 DSH v0.1.5-rc.2 一致树）与已安装第三方插件 `dshmarket@1.46.1` 的构建产物、官方开发指南（2026-09-11 整理版）。

## 1. 固定的宿主版本

| 项 | 值 | 来源 |
| --- | --- | --- |
| DSH | `@deepseek-ai/dsh@0.1.5-rc.2`（profile `~/.dsh/profiles/web`） | `~/.dsh/tooling/package.json` |
| Cordis | `@deepseek-ai/cordis@^4.0.1`（npm 最新 `4.0.2`） | dshmarket peerDependencies、npm registry |
| Schemastery | `@deepseek-ai/schemastery@^3.18.1` | 同上 |
| Node | 本机 v26.4.0，包管理器 pnpm 11.1.2 | 本机 |
| React（Client） | `react@^18.3.1`（由 client module loader 注入 require） | dshmarket client 产物 |

兼容承诺固定在上述已验证版本线；不把宿主 main 分支当作兼容目标。

## 2. 插件形态与安装

- Host 插件 = 导出 `apply(ctx, config)` 的 ESM 模块；配置经 Schemastery `Config` 导出校验。
- 分发 = npm 包 + `package.json` 中 `dsh.bundle: { patch: "./cordis.patch.yml" }`；patch 为 `- insert: [{id, name}]`。
- Client 声明 = `dsh.client: { inject: [...], platform: "web" }` + `exports['./client']` 指向构建产物。实物核对（dshmarket）：
  - Client 产物是单文件 IIFE，首部为 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`；
  - `factory(require)` 内通过 `require('react')`、`require('@deepseek-ai/dsh-client-ui-primitives')` 等取宿主注入模块（`dsh.client.inject` 声明）；
  - 模块导出 `{ name, inject, apply }`，`apply(ctx)` 内使用 `ctx.slots.inject/register`。
- 构建：tsdown/esbuild 均可产出该形态；本项目用 esbuild，外部依赖全部走宿主注入。

## 3. UI 扩展点（已核对源码，非推断）

`dsh-client-ui-sidebar` 的 `sidebar` 条目声明了这些 slot（`lib/client.js`、`lib/types/client/contract/slots.d.ts`）：

| slot | kind | 用途 |
| --- | --- | --- |
| `sidebar.brand.mark` / `sidebar.brand.name` | single | 品牌区 |
| `sidebar.panellist` | list | 全局面板行；每个条目 `id` 对应主面板 key |
| `sidebar.workspaces` | single | 会话浏览区（ui-workspace 占用） |
| `sidebar.settings` | single | “设置”座位 |
| `sidebar.footer.action` | list | **页脚动作区，渲染在 `sidebar.settings` 之前（源码行 296→299）**，即“设置上方” |

- 入口选择：注册 `sidebar.footer.action`（owner props `{ wide }`），渲染“远程运维”按钮；不替换整个 sidebar。
- 主内容区：`dsh-client-ui-layout` 声明 keyed slot `main`（“The reserved `conversation` key hosts the Conversation; other keys receive no Session binding”）。本项目以 `dsh-devops` 为 key 注册 `main` 面板组件 + 同 id 的 `sidebar.panellist` 行；进入用 `ctx.layout.selectPanel(<MainPanelId>)`，退出用 `ctx.layout.selectPanel(null)`（文档原文 “null displays the current Conversation”）——满足“关闭运维页恢复聊天”，不无条件替换主视图。
- 主面板 id 为 branded 类型，注册后由宿主布局表持有；卸载本插件时 slot 注册随 effect 自动撤销，无重复菜单。

## 4. Host↔Client 通信：决策与依据

- 宿主原生 Remote（Typert）链路 = `@Remote` 服务 → **生成器产出严格 `./typert` / `/remote` 产物** → `dsh-typert-loader` 注册 → Client `ctx.remote.$mount()`。
- **关键约束（实物核对）**：npm 上只有 `dsh-typert-{protocol,registry,loader}`；**生成器（dsh-typert-generator）未随宿主发布**，且 Gateway 文档明确 “Only strict generated contributions can mount on the Client face. SRC markers have no Client codec or type projection.”。树外包当前无法用官方工具生成严格产物。
- **决策**：使用宿主公开的带认证 RPC 通道扩展点 `ctx.connection.rpc.handle(channel, handler)`（`dsh-client-connection` 文档原文 “Register one authenticated absolute channel prefix”，经 `/api` 传输的 Host/Origin 检查与浏览器认证）；客户端用 `ctx.connection.rpc.call(channel, endpoint, payload, signal)` 调用。
  - 通道：`/dsh-devops`（Connection 通道约束为单个绝对路径段，`/api` 为保留通道；早期设计稿中的 `/rpc/dsh-devops` 不合法）；endpoint→zod 请求/响应 Schema 全量校验（对齐 Typert 的“带校验服务调用”语义）；
  - 响应形状对齐 Remote 词汇：`{ ok: true, value } | { ok: false, error: { code, message, scope, retryable, details } }`；**`details` 在线上恒为记录**——浏览器端 `parseConnectionResponse` 要求 `error.details` 存在，缺失会把真实错误吞成 `carrier: invalid server-response result`；
  - 浏览器取消请求不取消已接受任务：所有任务创建接口在 Host 持久化任务后立即返回任务 ID（S11 契约）；
  - 实时刷新首版用短轮询（分页查询），事件按 sequence 补读；不引入未经验证的自定义推送协议。
- **已知宿主缺陷与插件侧兜底（2026-09-19 实机排查）**：`dsh-client-connection@0.1.5-rc.2` 的 `rpc.handle → register()` 内部以严格属性读取 `owner.webServer`；在真实 Web 组合（插件 loader 在场）下该读取从消费者插件的 shadow 上下文出发，被 Cordis 的注入声明强制拒绝（`cannot get property "webServer" without inject`），注册在回调内抛出且无日志——通道路由从未挂载，浏览器所有 RPC POST 落到 SPA 兜底（`dsh-host-frontend-static` 对非 GET/HEAD 回 **HTTP 405**），即“点击验证连接报 405”。插件现在于嵌套 `ctx.plugin({ inject: ['connection','webServer'] })` 内调用 `rpc.handle`，捕获该错误后按同一线上协议把通道直接挂到 `webServer`（围栏复用 connection 公开的 `requestRejection`，见 `src/host/adapters/dsh/rpc-route.ts`），未打补丁的宿主上照常工作。已在真实 `dsh web` 进程上双路径验证（含 `servers.verify` 真实 SSH）；上游修复为 register() 改用 `owner.get('webServer')` 受保护读取。
- 该决策在 typert 生成器公开发布后可平滑升级为原生 Remote：API 层 endpoint 注册表与 DTO Schema 即 Remote 服务的单一来源。

## 5. 存储、凭据、Agent、工具

- **存储**：`ctx.storageDomain.open(spec)`；spec 由 `defineDomain({ name, version, tables: { …zod } })` 声明。读同步、写 durable-first、`table().update()` 为写链上的原子读改写（并发不交错）——满足“单活动控制器下串行更新版本化聚合”。跨表事务不存在，多记录流程按可恢复顺序写。`domain/changed` 事件仅用于提交后通知；恢复一律从持久记录读取。
- **凭据**：宿主凭据服务面向模型凭据；**SSH/Git/提权凭据按 PROD 由插件私有 Vault 管理**（AES-256-GCM 封装 + 独立 KeyProvider；密钥文件权限 0600，明文不落库、不进日志/模型/脚本）。
- **Agent**：`ctx.agents.create({ sessionId, agentOptions, setup })` → `AgentHandle { agent, dispose() }`；`setup(agentCtx)` 在发布前组合作用域（注册受限工具、prompt），不继承通用 shell/文件写工具的确认方式 = 只在 agentCtx 上注册白名单只读工具并依赖宿主作用域隔离（S5 以契约测试验证工具集）。后台任务由 Host 服务端创建 agent，不绑定当前聊天；结束后 `handle.dispose()` 释放。
- **工具**：`ctx.tools.register(defineTool({...}))`（`@deepseek-ai/dsh-tools`）；巡检工具只读，部署工具仅在用户手动创建的任务作用域内注册。
- **生命周期**：全部连接/定时器经 `ctx.effect()` 或自带 disposer 的注册 API；异步 disposer 有顺序依赖时并入同一 disposer 串行（Cordis 并发清理语义）。

## 6. SSH 执行

- 首选宿主与目标机均具备的系统 OpenSSH：本地进程参数数组启动 `ssh -F <私有配置> ...`，不经过 shell 拼接；私有配置显式关闭 UserKnownHostsFile/GlobalKnownHostsFile/IdentitiesOnly 等系统回落（逐项 `-o` 覆盖，S2 测试证明系统配置不影响）。
- 密码经受控 askpass 辅助进程 + 私有 IPC 管道交付；不进 argv、不进共享环境变量。
- 远程任务用最小 POSIX sh 包装器（Linux/macOS 通用子集）：身份标记、PID、启动标识、阶段结果文件原子发布；停止核对在独立连接上进行。

## 7. 运行级验证状态（诚实清单）

以下已在**代码与测试层**证明（见 tests/ 与 ACCEPTANCE.md）：

- Cordis 生命周期（apply/effect/inject/卸载清理、双实例拒绝、配置校验失败即 FAILED）——用 npm 上的真实 `@deepseek-ai/cordis` 运行。
- 私有 SSH：真实 sshd（内存 ssh2 服务端）上的密码认证、指纹绑定与变化阻断、执行身份、停止与断连未知态。
- Git/部署状态机、日志游标、调度合并、脚本失效等业务不变式。

以下依赖**真实 DSH Web 进程/真实模型/真实目标机**，按计划要求显式标注为未在本环境完成，交付包附带复验步骤：

- 浏览器中真实点击 `sidebar.footer.action` 入口与三页面（需图形会话下的 DSH Web）。
- 真实模型驱动的 AI 巡检/部署（需已配置的模型凭据）。
- Linux 发行版/远端 macOS 实机矩阵（需对应环境）。

以上不阻塞交付物（可安装包、契约测试、单元/集成/e2e 测试）的完整性与通过状态；复验步骤写入 ACCEPTANCE.md §“未验证平台/环境”。
