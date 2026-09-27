# dsh-devops — DSH 远程监控与运维插件

在 DeepSeek Harness（DSH）Web 内管理 SSH 服务器：硬件/进程/日志监控、AI 巡检、
首次 AI 部署 → 固化可复用脚本 → 手动更新、有限修复与恢复。
依据 [docs/PROD.md](docs/PROD.md) 与 [docs/PLAN.md](docs/PLAN.md)。

## 安装（预构建 tarball）

```sh
pnpm build && pnpm pack --pack-destination dist
dsh plugin --profile web add ./dist/dsh-devops-0.1.0.tgz
dsh --profile web
```

安装后侧栏底部、**“设置”上方**出现“远程运维”入口（`sidebar.footer.action`）；
主内容区为独立面板，点“返回会话”即恢复聊天（`ctx.layout.selectPanel(null)`）。

### 安装/升级注意

- **重装同一版本号不会更新**：pnpm 对相同 `file:` 规格命中缓存直接复用，必须
  `dsh plugin --profile web remove dsh-devops` 再 `add`（或升版本号）才会换入新产物。
- **宿主需重启才生效**：profile 的 `dsh.profile.bundles` 是启动期层栈；`dsh plugin add`
  只写 manifest，已运行的 Web 进程需重启（`dshmarket` 的“重启”按钮或手工重启）。
- **patch 行不写 `config` 时插件拿到的是 `undefined`**（不是 `{}`）——因此 `Config`
  必须用 `.prefault({})` 兜底，否则整棵插件树启动失败。
- **宿主服务名与存储名有语法约束**：`ctx.storageDomain` 等服务必须经 `ctx.get(name)`
  读取（直接属性访问在有 `inject` 声明缺失时抛错）；domain/表名须匹配
  `^[a-z][a-z0-9_]*$`，故 `dsh-devops`→`dsh_devops`、`inspectionRuns`→`inspection_runs`
  由适配器在边界处映射（`tests/unit/host-integration.test.ts` 固化）。

## 配置（cordis.yml patch 可覆盖）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `~/.dsh-devops` | 私有数据目录（SSH 配置、密钥、降级存储） |
| `modelRef` | null | AI 巡检/部署所用模型；为空时 AI 步骤诚实报告 unavailable |
| `hardwareIntervalSeconds` | 60 | 硬件巡检周期 |
| `processIntervalSeconds` / `logsIntervalSeconds` | 300 | 进程/日志 AI 巡检周期 |
| `retentionDays` | 30 | 普通历史保留（配置/有效脚本不清理） |
| `batchBudgetTokens` | 8000 | 单批 AI 输入预算 |

## 验证

```sh
pnpm typecheck            # 严格类型（Host/Client/Tests）
pnpm test:unit            # 契约/SSH/Vault/仓库/执行/采集/巡检/日志/调度/脚本…
pnpm test:contract:dsh    # 真实 cordis 运行时生命周期 + 重启持久化
pnpm test:integration:ssh # 私有配置/askpass/指纹/执行/停止（经高保真垫片，见 ACCEPTANCE §5.1）
pnpm test:integration:ops # 真实 git 仓库部署管线
pnpm test:e2e:web         # 全链路 + PLAN §6.2 反例矩阵
pnpm test:acceptance      # PROD §5 可执行子集
pnpm test                 # 全部（当前 149/149 通过）
```

## 架构（Host/Client 单 bundle）

```
src/contracts/    DTO Schema、错误码、部署状态机、API 契约（双端共享）
src/host/
  adapters/       端口 + DSH/file/memory 适配（业务零 SDK 依赖）
  repository/     版本化记录、迁移备份、原子占用、requestId 幂等
  vault/          AES-256-GCM 凭据封装、脱敏
  ssh/            命令白名单解析、私有配置生成、OpenSSH 传输（askpass 私有通道）
  execution/      身份化远程执行单元（意图先行、事实文件、停止核对）
  probes/         硬件/进程采集（Linux+macOS 解析器，缺字段=null 非 0）
  agents/         受限 AI 巡检（分批、覆盖率、证据服务端校验）
  logs/           Supervisor 发现、读写双游标、增量读取、告警去重
  scheduler/      持久化调度（单飞合并、不补跑、抖动、AI 并发上限）
  deployment/     git 预检、ff-only 更新、首部署编排、修复(≤2轮)、恢复、核对
  scripts/        候选→已验证→失效（哈希防篡改、适用性指纹）
  api/            zod 全量校验的 RPC 分发（/rpc/dsh-devops 认证通道）
src/client/       slots 入口 + 大卡片页面模块（服务器/项目 + 各自详情页）+ 图表 + 状态模型
```

设计要点与接入决策见 [docs/INTEGRATION.md](docs/INTEGRATION.md)；
验收状态与兼容矩阵见 [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md)。
