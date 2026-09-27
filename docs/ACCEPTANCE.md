# 验收记录（ACCEPTANCE）

> 日期：2026-09-17｜对应 [PROD.md v1.1](./PROD.md) §5 验收条件与 [PLAN.md](./PLAN.md) §6.2 反例矩阵。
> 测试命令：`pnpm test:unit` / `pnpm test:contract:dsh` / `pnpm test:integration:ssh` / `pnpm test:integration:ops` / `pnpm test:e2e:web` / `pnpm test:acceptance`（当前全部通过：149 tests / 21 files，见 §4）。

## 1. 已验证（有自动化证据）

| PROD §5 验收条件 | 证据 | 状态 |
| --- | --- | --- |
| 5.1 SSH 验证失败不得添加服务器 | `tests/acceptance/prod5.test.ts` §5.1；`tests/unit/server-service.test.ts` | ✅ |
| 5.2 不读取系统/用户 SSH 配置完成验证与自动连接 | 私有 `-F` 配置 + `GlobalKnownHostsFile /dev/null` + `IdentitiesOnly yes`；`tests/unit/ssh.test.ts`、`tests/integration/ssh/` | ✅ |
| 5.3 三类监控含实际数据（本机/macOS 实测） | `tests/unit/probes.test.ts`（双平台解析器 fixture）；`monitoring.processes` e2e | ✅（Linux 远端见 §2） |
| 5.4 全量进程可查、身份唯一无遗漏 | `tests/acceptance/prod5.test.ts` §5.4；解析器含僵尸/睡眠态 | ✅ |
| 5.5 日志默认巡检、告警可定位证据 | `tests/unit/logs.test.ts`（excerpt 逐字校验、证据 ref） | ✅ |
| 5.6 日志路径来自动态发现（Supervisor 实测） | `tests/unit/logs.test.ts`：redirect/stderr 合并、NONE/AUTO、include | ✅ |
| 5.7 手动+定时巡检；关浏览器不停；重启恢复不补跑 | 调度器为 Host 服务（无浏览器参与）；`tests/unit/scheduler.test.ts`（错过后仅补一轮，无风暴） | ✅ |
| 5.8 仓库/分支/目标/目录准确对应 | git precheck：分支、remote URL、dirty、ahead 校验（`tests/unit/git-precheck.test.ts`、`tests/integration/ops/`） | ✅ |
| 5.9 首次 AI 部署生成候选脚本；候选≠已验证 | `tests/unit/scripts.test.ts`、e2e §6.2 反例 | ✅（真实模型驱动见 §2） |
| 5.10 `git pull --ff-only` 记录提交、健康验证 | `tests/integration/ops/deployment-git.test.ts`、`tests/acceptance/prod5.test.ts` §5.10 | ✅ |
| 5.11 组合脚本+AI 步骤；失败按上限修复 | 修复上限 2 轮 + 修复后重跑失败阶段（集成测试覆盖） | ✅ |
| 5.12 只读巡检、页内告警、30 天保留 | `tests/unit/repository.test.ts`（清理保留有效脚本/未结束任务）；巡检工具白名单 | ✅ |
| 5.13 异常/失败不呈现为成功 | `tests/acceptance/prod5.test.ts` §5.13：健康失败 → FAILED；部分分析 → partial；无模型 → unavailable | ✅ |
| 密码不出现在 AI 上下文/脚本/日志 | `tests/unit/vault.test.ts`（redaction）；任务 payload 由受控模板生成；askpass 文件协议机密不进 argv/env | ✅ |
| 菜单位置（设置上方） | `sidebar.footer.action` 源码级核对（渲染于 `sidebar.settings` 之前）+ `src/client/entry.ts` | ✅（浏览器点击见 §2） |

## 2. 反例矩阵（PLAN §6.2）—— 全部有测试证据

| 反例 | 预期 | 证据 |
| --- | --- | --- |
| 系统 SSH 配置恰好能登录，插件配置错误 | 仍失败 | e2e `tests/e2e/counterexamples.test.ts` |
| 保存前修改已验证配置/凭据 | 票据失效（含 secretHash 绑定） | 同上 + `server-service.test.ts` |
| 模型只分析部分进程 | partial + 覆盖率如实 | e2e + `inspection.test.ts` |
| 日志已读但 AI 失败 | 片段保持 pending 可重试 | `logs.test.ts` |
| Supervisor AUTO/NONE、轮转后旧文件删除 | none/缺口明确 | `logs.test.ts` |
| 本地独有提交/重试期间新提交 | 前者停止；后者不影响冻结提交 | `deployment-git.test.ts` |
| 重启命令成功但服务很快退出 | 健康检查失败（observe 窗口复检） | wrapper 脚本 `process-exited-during-observe` + 单测 |
| 用户停止后 SSH 断开 | 停止中/待核对，不释放占用 | e2e |
| 候选脚本未验证 | 保持候选不可自动执行 | e2e + `scripts.test.ts` |
| 第 31 天清理 | 有效脚本保留来源/验证摘要 | `repository.test.ts` |
| 页面关闭/插件重载/重复点击 | 后端可信、requestId 幂等、断连继续推进 | e2e |

## 3. 三条主链状态（PLAN §12 发布门槛）

| 主链 | 状态 | 说明 |
| --- | --- | --- |
| 纯插件接入 | ✅ 协议/生命周期层 | 真实 cordis 运行时加载/卸载/双实例拒绝；slot 挂载点经源码核对。**浏览器内点击验证待 DSH Web 图形环境**（见 §5） |
| 后台受限 agent | ✅ 契约层 | 真实 `ctx.agents.create` 形状对接 + 降级路径诚实报告；**真实模型驱动待已配置凭据的 DSH 实例** |
| 密码 SSH | ✅ 本机链路 | 私有配置/askpass 通道/指纹固定/身份化执行全部经真实 sh 验证；**真实 OpenSSH 网络层因本环境网络拦截无法回环运行**（见 §5.1） |

## 4. 测试统计（2026-09-17 本机最后一次全量运行）

```
pnpm vitest run
Test Files  21 passed (21)
Tests       149 passed (149)
```

- `pnpm typecheck`：0 错误（Host/Client/Tests 一个严格工程）
- `pnpm build`：Host ESM bundle + Client `window.__ModuleLoader__` 形态产物 + `dsh.bundle`/`dsh.client` 声明齐备
- `pnpm pack`：产出可安装 tarball（见 README 安装）

## 5. 环境受限项（未在本环境验证——非通过、非跳过，显式列出）

1. **真实 OpenSSH 客户端回环链路**：本环境网络层对 ssh 二进制的 localhost 连接做透明拦截（TCP 握手被代理完成、永不抵达本机监听端；github.com 等白名单不受影响）。集成测试改用高保真 `ssh` 垫片（`tests/helpers/fake-ssh.ts`）覆盖传输层可控面（私有配置语义、askpass 文件协议、指纹固定、argv 命令、断连分类）；`nohup` 分离、停止核对、PID 复用防护由真实 POSIX wrapper 在真实 sh 下验证。**在无拦截环境复验步骤**：`pnpm test:integration:ssh`（将 `tests/helpers/fake-ssh.ts` 替换为真实 sshd，或直接 `ssh -F <私有配置>` 手工验证）。
2. **DSH Web 浏览器内验证**（入口位置、三页面交互、刷新恢复、无授权访问失败）：需要图形会话下的 `dsh --profile web` 实例。复验：`dsh plugin --profile web add ./dsh-devops-0.1.0.tgz` → 打开 Web → 侧栏底部“远程运维”→ 走三页面冒烟。
3. **真实模型驱动的 AI 巡检/部署**：需要已配置模型凭据。复验：`cordis.yml` 配置 `modelRef` 后执行 `monitoring.inspect`。
4. **Linux 发行版矩阵与远端 macOS 实机**：解析器/包装器为双平台设计并有 fixture 测试；实测矩阵需对应目标机。当前实测平台：macOS（本机）。
5. **凭据密钥的系统级安全存储**（Keychain 等）：当前提供文件密钥（0600）+ 内存密钥；系统安全存储为增强项。

## 6. 真实 DSH Web 实例安装验证（2026-09-17/18）

### 6.0 真实宿主拒载问题与修复（重要）

首版安装到真实 DSH 后启动报 `cannot get property "connection" without inject`，宿主插件树拒绝加载。根因：**Cordis 上下文是带注入保护的代理**——未经 `inject` 声明读取服务属性（`ctx.connection`）会直接抛错，而仓内测试用普通对象模拟 ctx 无法暴露此语义。三层修复（v0.1.1）：

1. 全部可选服务探测（`storageDomain`/`agents`/`connection`）包裹异常防护——抛错即降级标记，绝不冒泡；
2. `safeLogger` 守卫宿主 logger 读取（含 cordis LoggerService 的 this 绑定问题），不可用时回退 console；
3. apply 顶层兜底：任何初始化错误 = 插件自禁用（记录错误、释放控制器锁），**宿主永远能启动**。

回归测试：`tests/integration/contract-dsh/plugin-lifecycle.test.ts`（真实 `@deepseek-ai/cordis` 运行时上的严格 `internal/get` 拒绝策略模拟 + 初始化失败锁释放）。

### 6.1 安装验证

- 安装：`dsh plugin --profile web add ./dist/dsh-devops-0.1.1.tgz` → profile `bundles` 追加、组合配置出现 `# == dsh-devops` 层。
- 真实宿主完整初始化验证（带打点的构建）：`apply` 全部 14 个阶段走完（域存储打开于宿主 `storageDomain`、三服务探测零降级、RPC 通道注册、effect 注册），零错误。
- 热加载生效证据：运行中实例经 `patchReload: live` 自动加载插件，`~/.dsh-devops/controller.lock` 心跳每 10s 推进。
- 单控制器排他真实生效：第二实例检测到锁后插件自禁用（宿主树 0 致命错误），第一实例所有权不受影响。
- **版本注意**：`dsh plugin add` 对同名同版本 tarball 存在 pnpm 缓存歧义——更新插件时务必升版本号或先 `remove` 再 `add`，并核对 `node_modules/dsh-devops/package.json` 的 version。

- 安装方式：`dsh plugin --profile web add ./dist/dsh-devops-0.1.0.tgz` → profile `bundles` 追加 `dsh-devops`，组合配置出现 `# == dsh-devops` 层（`--dump-config` 核对）。
- **运行实例热加载生效**：`patchReload: live` 的运行中实例自动加载插件——`~/.dsh-devops/controller.lock` 由该实例持有且心跳每 10s 推进，`~/.dsh-devops/ssh/` 私有目录由传输层初始化。
- **单控制器排他在真实环境生效**：第二个 `dsh --profile web` 实例启动时检测到控制器锁，插件自禁用（`DISABLED: another controller …`）而宿主插件树正常加载（0 个致命错误，HTTP 服务正常响应）——多实例场景不再破坏宿主。
- 浏览器内 UI 冒烟（入口点击、三页面交互）仍需图形会话下的浏览器登录，属 §5 环境受限项。

## 7. 兼容矩阵（实测）

| 目标平台 | 硬件采集 | 进程采集 | 日志读取 | 部署执行 | 验证方式 |
| --- | --- | --- | --- | --- | --- |
| macOS（本机，arm64，OpenSSH 10.3） | ✅ top/vm_stat/df 解析+实链路 | ✅ ps(lstart) 实链路 | ✅ 游标/片段实链路 | ✅ git/脚本/健康实链路 | 自动化测试 |
| Linux（容器/虚拟机） | 解析器 fixture ✅ | 解析器 fixture ✅ | 逻辑 ✅ | 状态机 ✅ | **待实机复验** |
| Windows | 不支持（PROD 范围外） | — | — | — | — |
