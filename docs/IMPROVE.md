# DSH-DevOps UI 与信息架构改造开发文档

> 版本：v1.2｜日期：2026-09-20｜依据：用户改造需求 5 条 + 当前代码 v0.1.1 实测盘点。
> **实施状态（2026-09-20）：本文 M0–M8 已全部实现，并已在真实 DSH Web 宿主上完成浏览器实测验收（v0.2.6）**。
> 实测环境：`dsh web`（web profile，真实 SSH 服务器 wwg），浅色/深色双主题截图验证通过；`pnpm typecheck`、`pnpm build`、全量测试（含 UI 冒烟 `tests/ui/ui-smoke.test.tsx`）全绿。
>
> 实装过程中发现并修复的额外问题（均已回归）：
> 1. **调度器只 tick 一次**：`start()` 原实现只安排一次性定时器，宿主启动 5s 后仅执行一次排程扫描，此后永不调度——周期采集形同虚设。已改为循环 tick（每轮结束重排下一轮，stop 后不再重排）。
> 2. **策略缺失导致永不调度**：调度器只为已存在的 policy 记录排程，而策略是旧监控页懒创建的。调度器现在每轮自动为缺策略的服务器补建默认策略（`policy-defaults.ts`，首跑在一整个间隔之后）。
> 3. **无版本硬件样本毒化仓库**：v0.2.0–0.2.2 的 `putHardwareSample` 写入缺 `schemaVersion` 的记录，`loadAndMigrate` 扫描到后令整个仓库只读（所有写入静默失败）。已改为版本化写入，并对存量无版本样本记录备份后自愈删除。
> 4. **unknown 平台不采集 CPU/内存**：capability 记录为 unknown 的服务器永远拿不到 CPU/内存。硬件采集现对 unknown 先试 Linux 探测、失败回落 macOS；进程 cwd 同理。
> 5. **项目卡片“进入详情”点击被吞**：卡片 footer 的 stopPropagation 拦截了进入详情的冒泡点击。已将拦截下沉到部署按钮自身。
> 6. **图表 y 轴混纲**：百分比序列与网络 KiB/s 序列共用线性轴时百分比线被压扁不可见。已拆分为“占用率历史（%）”与“网络吞吐历史（KiB/s）”两张独立图表。
> 7. `nginx:`/`postgres:` 等 argv0 冒号尾缀导致进程名匹配不到通用服务名单——解析时去除尾部冒号。
> 8. **控制器冲突提示不可读**：第二实例撞单控制器锁时 RPC 通道未注册，浏览器端只看到 HTTP 405。冲突实例现在注册明确的 `controller-conflict` 错误通道，UI 显示“另一个 dsh web 实例正在管理本插件”。
> 9. **tarball 几何膨胀**：`pnpm pack --pack-destination dist` 会把上一次的 tgz 卷进新包（33M→2.3G 直至超出 pnpm 2GiB 上限无法安装）。打包前必须清理 `dist/*.tgz`。
>
> 与原方案的少量偏差：
> - 轮询分层由页面级 `usePoll` Hook 实现（`src/client/hooks.ts`），未放入 `model.ts`，行为等价：列表 4s、硬件历史 30s、项目服务/日志 5s、`visibilitychange` 暂停。
> - 服务器进程 Tab **不做自动轮询**（每次刷新都是一次 SSH 采集，且有模型时触发 AI 巡检），改为手动刷新 + AI 巡检按钮。
> - tail 视图未渲染 `gapBeforeBytes` 缺口标记行（数据完整性的缺口仍记录在 fragment 上，UI 呈现列为后续迭代）。
> 本文其余内容保留为设计依据。

## 11. 二轮优化实施记录（v0.3.0–v0.3.3，2026-09-20）

在 v0.2.x 基础上按用户新需求追加三轮迭代，全部功能已在真实环境（真实 SSH 服务器 + 真实 nginx 配置）验证：

| 需求 | 实现 | 验证 |
| --- | --- | --- |
| 服务器进程页大字体/大行高，已知应用显示图标和名称 | `known-apps.ts` 图标映射（nginx→🌐 mysqld→🐬 node→⬢ 等 40+ 条目）；表格字号 11/12→12/13.5、行高 11px→11-14px padding；首列“应用”= 图标 + 友好名 + 原始名 | 真实环境 DOM 断言：📦Snapd / 🔑OpenSSH / 🌐Nginx / 🐍Python 3 均正确识别 |
| 进程启动方式检测 | `classify.ts#applyLaunchModes`：沿 ppid 祖先链（深度 8、防环）识别 supervisor / pm2 / systemd / launchd / docker / kubernetes / npm；shell 祖先→`sh-script`；孤儿→`direct`；结果写入 `processEntrySchema.launchMode` | 真实环境：nginx/gunicorn 均识别为 systemd；单测覆盖祖先链/防环/未知 |
| 项目进程检测改大卡片（每进程一卡） | 服务 Tab 重构：汇总条（运行进程数/CPU 合计/内存合计/代码目录/日志合计）+ 每进程大卡（图标名称、PID、启动方式徽章、状态、CPU/RSS/IO 大数字、cwd、命令、CPU 实时 Sparkline） | 真实环境 DOM：PID 900751-900754 四张 gunicorn 大卡渲染正确 |
| nginx/apache 反代指向项目检测 | `ResourceProbe#detectReverseProxies`：grep `/etc/nginx /etc/apache2 /etc/httpd` 引用 codeDir 的配置文件并提取 server_name；`monitoring.projectProcesses` 响应新增 `proxies` | 真实环境：发现 `/etc/nginx/conf.d/opcdesk.top.conf`（域名 opcdesk.top www.opcdesk.top） |
| 日志文件从启动脚本定位 | `discovery.ts#candidatesFromProcessCommands`：解析进程命令行中的重定向（`>>`/`2>>`/`>`）与日志旗标（`--error-logfile` 等），仅接受绝对 `.log` 路径、排除设备文件；`monitoring.projectProcesses` 自动 upsert 为 logSource（configOrigin=process-cmdline） | 真实环境：自动发现 `gunicorn-access.log`（29.7 MiB）与 `gunicorn-error.log` |
| 日志页布局：上仪表盘 + 下大卡片列表 | 仪表盘 = 速率折线 + 级别分布条图（保留）；下方每个日志文件一张大卡：磁盘占用、最近更新时间（`lastModifiedAt`，stat 实时获取）、5s 轮询增量增速 ▲、异常徽章（ERROR 行数/WARN/无异常）、行/分钟 | 真实环境截图：gunicorn-access.log 卡片 29.7 MiB · 8 分钟前 |
| 点击日志卡片弹窗实时预览（行数可调） | `monitoring.logTail` 请求新增 `sourceId`（只取单文件）+ 响应新增 `meta`（size/lastModifiedAt）；前端弹窗浮层（fixed overlay）内 2s 轮询 tail，行数 50/100/200/500 可切，ERROR 行红底高亮 | UI 冒烟（happy-dom）断言弹窗打开、tail 行渲染、行数选择器存在 |
| 面板健壮性（实测中发现） | ① 视图栈提升到模块级：宿主重渲染面板 slot 导致组件重挂载时恢复原视图（原实现会跳回列表页）；② `usePoll` 缓存与在途去重提升到模块级：重挂载不闪“加载中”、SSH 轮询不叠加；③ 弹窗状态持久化；④ 面板守卫：用户开着面板时被宿主意外摘除，2s 内自动重新选中 | 重挂载后视图恢复、数据即时显示（真实环境 DOM 验证） |

> 浏览器实测注记：v0.3.3 全量测试 204/204 通过；进程图标/启动方式/反代卡片/日志卡片/浅色主题等已在真实浏览器逐项确认。日志弹窗的真实浏览器点击验证因本地内嵌浏览器会话故障（多标签页会话互相冲突 + guest 进程卡死，属宿主环境问题）未能完成，由 `tests/ui/ui-smoke.test.tsx` 的 DOM 级断言覆盖（弹窗打开、tail 渲染、行数选择器）。单实例单标签页使用时无此环境问题。

## 1. 改造目标（需求映射）

| 编号 | 需求 | 主要层面 | 一句话方案 |
| --- | --- | --- | --- |
| R1 | 服务器 Tab UI 大卡片化；整体 Tab 更大更好看、交互合理、增加动效 | Client | 服务器列表改大卡片网格（内嵌实时指标），一级 Tab 改为分段式大导航 + 全局动效规范 |
| R2 | 取消监控 Tab；点服务器卡片进入监控页；开头为硬件指标（百分比动态饼图、非百分比大数字），下方为历史曲线 | Client + Host | 删除一级"监控"Tab，新增服务器详情页（硬件/进程双 Tab）；补网络 IO 采集与样本历史落库 |
| R3 | 服务器监控页第二 Tab 为进程，须区分系统应用 / 常见通用软件服务 / 私有服务（按启动目录分组） | Client + Host | 进程采集增加 cwd，Host 端纯函数分类器输出分组，客户端分区折叠展示 |
| R4 | "项目运维"更名"项目"，参照服务器用大卡片显示运行信息 | Client + Host | 项目列表大卡片（部署状态、服务健康、告警计数），新增 projects.overview 聚合端点 |
| R5 | 项目详情双 Tab：服务（进程 cpu/内存/IO/硬盘/日志占用，图表+大数字）/ 日志（输出可视化，异常醒目） | Client + Host | 新增项目维度进程聚合与日志 tail/统计端点；日志页异常横幅 + 级别分布图 |

## 2. 现状盘点与差距分析

### 2.1 客户端现状（`src/client/`）

- `pages.tsx:45-63` `OpsApp` 一级 Tab 为 服务器 / 监控 / 项目运维 三个小按钮（`styles.tab`，padding 6×14），无动效。
- `pages.tsx:148-229` `MonitorPage` 只取第一台服务器（`state.servers[0]`），硬件信息是纯文本行，无任何图表。
- 服务器列表是 `<table>`（`pages.tsx:121-137`）；项目是小卡片 + 常驻表单（`pages.tsx:285-333`）。
- 全部 inline styles，无 CSS 动画、无图表组件、无路由概念（只有 Tab 切换 state）。
- `entry.ts` 面板外壳：标题"远程运维" + "返回会话"按钮，内容区直接渲染 `OpsApp`。
- `model.ts:47-53` 每 4s 轮询 `servers.list` + `projects.list` + `deploy.list`。

### 2.2 Host 能力现状与关键差距

| # | 差距 | 证据 | 影响 |
| --- | --- | --- | --- |
| G1 | 硬件样本无网络 IO 字段 | `entities.ts:188-206` `hardwareSampleSchema` 仅 CPU/内存/Swap/挂载点 | R2 要求的网络 IO 指标无数据源 |
| G2 | 硬件样本不落库、无历史端点 | `devops-api.ts:109-123` 每次实时 SSH 采集即丢；`index.ts:177-196` 调度器 60s 采集一次但丢弃 sample，只存 InspectionRun | R2 曲线图无数据；卡片轮询若直连该端点会放大 SSH 开销 |
| G3 | 进程条目无 cwd | `entities.ts:215-228` `processEntrySchema` 有 command 无工作目录 | R3 私有服务无法按启动目录分组 |
| G4 | `monitoring.logs` 不返回日志内容 | `devops-api.ts:149-153` 仅 sources + alerts（fragments 在契约中 optional，Handler 未返回） | R5 日志 Tab 无法展示输出 |
| G5 | 无项目维度聚合端点 | `api.ts` 全量端点清单 | R4/R5 需要客户端拼多个端点，N+1 且无进程↔服务关联 |
| G6 | 无图表/动效基础设施 | 客户端零图表代码；bundle externals 仅 react/react-dom/ui-primitives（`scripts/build.mjs:31-36`） | R1/R2/R5 需要自绘 SVG 组件库 |
| G7 | 无内存中的视图路由 | `pages.tsx` Tab state 是平面的 | R2"点击卡片进入详情"需要列表↔详情状态机 |

### 2.3 可复用的既有能力

- 进程快照已持久化（`ProcessSnapshot`，`snapshotId` 可查），进程含 `cpuPercent`（单核口径，可超 100%）、`rssBytes`、`command`、`ppid`。
- `monitoringPolicySchema.groupingRules`（`entities.ts:150-153`，`{match, project}[]`）已预留进程归组规则，可直接作为"常见通用软件服务"目录的用户扩展点。
- 日志片段已落库：`log-service.ts:125` `putLogFragment` / `listLogFragments`，含 `content`、`gapBeforeBytes`、`analysisState`。
- 告警已有去重与计数：`alertSchema`（severity/count/firstSeenAt/lastSeenAt）。
- 调度器已按策略周期采集 hardware(60s)/process(300s)/logs(300s)，样本入口现成，只差落库。

## 3. 总体方案

### 3.1 信息架构

一级 Tab 只剩两个：**服务器**、**项目**。监控从一级 Tab 中消失，成为服务器详情页。

```mermaid
flowchart LR
  ROOT[OpsApp 大分段 Tab] --> SRV[服务器列表（大卡片网格）]
  ROOT --> PRJ[项目列表（大卡片网格）]
  SRV -->|点击卡片| SD[服务器详情]
  SD --> SD1[Tab1 硬件：指标饼图+大数字 / 历史曲线]
  SD --> SD2[Tab2 进程：系统应用 / 通用服务 / 私有服务(按启动目录分组)]
  PRJ -->|点击卡片| PD[项目详情]
  PD --> PD1[Tab1 服务：进程资源图表+大数字]
  PD --> PD2[Tab2 日志：速率曲线+级别分布+tail+异常横幅]
```

客户端路由状态机（`src/client/router.ts`，纯 React state，不引入 router 依赖）：

```ts
type View =
  | { kind: 'servers' }                                    // 服务器列表
  | { kind: 'server'; serverId: string; tab: 'hardware' | 'processes' }
  | { kind: 'projects' }                                   // 项目列表
  | { kind: 'project'; projectId: string; tab: 'services' | 'logs' }
```

- 详情页顶部为面包屑 + `← 返回`（`服务器 / web-01`、`项目 / dsh-site`），浏览器内后退用入栈历史模拟。
- 现 `MonitorPage` 的三个手动动作不丢失，就地迁移：`硬件检查` → 硬件 Tab 工具栏；`进程 AI 巡检` → 进程 Tab 工具栏；`日志 AI 检查` → 项目日志 Tab 工具栏（`monitoring.inspect` 端点不变）。

### 3.2 设计语言与动效规范

沿用"inline styles + rgba 适配明暗主题"的既有原则（`pages.tsx` 头注释），动效用**一次性注入的 `<style>` keyframes + class** 实现（`entry.ts` 注入，`id=dsh-devops-anim`，apply 时挂载、dispose 时移除）。

| 对象 | 规格 |
| --- | --- |
| 一级 Tab | 分段控制器（segmented control），高 44px、字号 15、圆角 12；激活项白底/主色描边；指示条 `transform: translateX()` 240ms ease-out 滑动 |
| 大卡片 | `display:grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`；卡片圆角 14、padding 18、边框 `rgba(128,128,128,.25)`；标题区/指标区/操作区三段式布局 |
| 状态色 | ok `#22c55e`、warn `#f59e0b`、err `#ef4444`、主色 `#3b82f6`（与现 styles 一致）；徽章 pill + 对应色低饱和背景 |
| 卡片入场 | `fadeInUp`（12px 位移 + 透明度，360ms），同屏按 index 阶梯延迟 `index*30ms` |
| 卡片 hover | `translateY(-2px)` + 阴影加深 + 边框提亮，180ms；整卡可点击进入详情 |
| 饼图/环形图 | SVG `stroke-dashoffset` transition 600ms 实现占比动画；中心数字 count-up |
| 大数字 | count-up 动画（requestAnimationFrame，400ms）；非百分比指标"数字+单位"（如 `1.2 GB/s`、`12.4 GiB`） |
| 异常强调 | critical 徽章/横幅 `pulse` 呼吸动画（1.6s 循环）；`prefers-reduced-motion` 下全部动效禁用 |
| 页面切换 | 列表↔详情 `fadeIn` 160ms；详情 Tab 切换内容区 slide-fade |

### 3.3 图表组件（零依赖自绘 SVG）

新文件 `src/client/charts.tsx`，不新增 npm 运行时依赖（保持 bundle externals 与宿主版本解耦的既有决策）：

| 组件 | 用途 | 要点 |
| --- | --- | --- |
| `Donut` | 百分比指标（CPU/内存/磁盘） | 环形 + 中心大数字；颜色按阈值分级（<70% ok / 70-90% warn / >90% err）；动画见 §3.2 |
| `BigNumber` | 非百分比指标（网络速率、RSS 绝对值） | 数字+单位，count-up；单位自动换算（B→KiB→MiB→GiB / B/s→MB/s） |
| `LineChart` | 历史曲线（多序列） | 多序列折线 + 时间轴刻度 + 图例；空数据/单点时诚实占位"暂无历史" |
| `Sparkline` | 卡片内迷你趋势（60 点内） | 无轴细折线，尾部圆点 |
| `MiniBar` | 日志级别分布 | ERROR/WARN/INFO 三色横条 + 计数 |

## 4. 逐项设计

### 4.1 R1 服务器 Tab：大卡片列表

```
┌─ 一级 Tab ──────────────────────────────────────────────┐
│  [ 服务器 ]   [ 项目 ]                        + 添加服务器 │
├─────────────────────────────────────────────────────────┤
│ ┌───────────────┐  ┌───────────────┐  ┌───────────────┐ │
│ │ ●web-01  linux│  │ ●db-01   linux│  │ ○ci-01  macos │ │
│ │ ssh u@1.2.3.4 │  │ ssh u@5.6.7.8 │  │ 凭据缺失(红)   │ │
│ │ CPU ◔ 23%     │  │ CPU ◔ 91%(!)  │  │ — 无数据      │ │
│ │ MEM ◕ 61% ▁▂▃ │  │ MEM ◕ 88% ▄▅▆ │  │              │ │
│ │ 告警 2 ⚠ 1 ⛔ │  │ 告警 0        │  │              │ │
│ │ [进入监控 →]  │  │ [进入监控 →]   │  │ [删除]        │ │
│ └───────────────┘  └───────────────┘  └───────────────┘ │
└─────────────────────────────────────────────────────────┘
```

- 整卡可点击进入服务器详情；删除等危险操作收进卡片右上角 `⋯` 菜单，避免误触。
- 卡片数据（一轮 RPC 拿全，**只读库、不触发 SSH**）：

```
servers.overview  {}  → Array<{
  server: ServerDto,
  latestSample: HardwareSample | null,   // 最近一次落库样本（见 §4.2）
  lastCollectedAt: number | null,
  alertCount: { critical: number, warning: number },
}>
```

- 采样失败/从未采集：卡片指标区显示"— 无数据"，不显示 0%（遵守"缺字段≠0"原则）。
- 添加服务器流程（验证→指纹确认→保存）不变，表单折叠为顶部 `+ 添加服务器` 按钮，展开为模态/抽屉。
- 列表页轮询 `servers.overview` 4s；`document.visibilitychange` 隐藏时暂停（现 `model.ts` 全局 4s 轮询一并改造成分层节奏，见 §6）。

### 4.2 R2 服务器详情 · 硬件 Tab

进入即页面开头为指标区，非百分比指标直接"数字+单位"：

```
服务器 / web-01                                     ← 返回
[硬件] [进程]      时间范围: 30m | 1h | 6h | 24h    [立即检查]

┌ CPU 占用 ───┐ ┌ 内存 ───────┐ ┌ 磁盘 / ──────┐ ┌ 网络 IO ─────────┐
│    ◔ 23%    │ │    ◕ 61%    │ │    ◕ 47%     │ │ ↓ 128.4 MB/s     │
│   8 核       │ │ 9.8/16 GiB  │ │ 235/500 GiB  │ │ ↑  36.2 MB/s     │
│  (环形动画)   │ │  (环形动画)  │ │  (环形动画)   │ │  (大数字+count-up)│
└─────────────┘ └─────────────┘ └──────────────┘ └──────────────────┘
  Swap 1.2/4 GiB   其他挂载点：/data 71% · /boot 23%

┌ 历史曲线 ──────────────────────────────────────────────┐
│ CPU% ─ ─   内存% ─ ─   磁盘%(根) ─ ─   ↓网速 ─ ─        │
│ (LineChart 多序列，时间轴，序列可点图例开关)              │
└─────────────────────────────────────────────────────────┘
```

Host 侧三项支撑（对应 G1/G2）：

1. **网络 IO 采集**（`entities.ts` + `probes/collector.ts` + `probes/parsers.ts`）
   - schema 扩展（新字段全部 nullable + default null，兼容已存样本）：
     ```ts
     hardwareSampleSchema.extend({
       netRecvBytesPerSec: z.number().nullable().default(null),
       netSentBytesPerSec: z.number().nullable().default(null),
     })
     ```
   - Linux：与 CPU 同一 300ms 窗口两次读 `/proc/net/dev`，按接口累计值差分求速率（排除 `lo`）；macOS：两次 `netstat -ib` 差分（排除 `lo0`）。解析器纯函数化并加固定样本单测。
2. **样本落库**：`repo.putHardwareSample(sample)`；落库点 = `monitoring.hardware` Handler 成功采集后 + 调度器 `runKind('hardware')`（`src/index.ts:177-196`，当前丢弃 sample 处）。读取接口 `listHardwareSamples(serverId, sinceMs)`；清理并入现有 `retentionDays` 任务。
3. **历史端点**：
   ```
   monitoring.history  { serverId, rangeMinutes: 30|60|360|1440 }
     → { samples: HardwareSample[] }   // >300 点时按时间桶取桶内最后值降采样
   ```

### 4.3 R3 服务器详情 · 进程 Tab

三区折叠布局，AI findings 面板保留在顶部（现 `MonitorPage` 的 findings/coverage 展示迁移至此）：

```
[硬件] [进程]                        🔍 搜索进程…   [进程 AI 巡检]

▼ 系统应用 (86)            折叠
▼ 常见通用软件服务 (7)      折叠/展开
│ ┌ dockerd   PID 1204   CPU ▌3.2%   RSS 412 MiB   运行 32d ┐
│ ┌ mysqld    PID 2088   CPU ▌8.7%   RSS 1.8 GiB    运行 12d ┐
▼ 私有服务 (5)
│ ├─ /srv/dsh-site (3)                    ← 按启动目录分组标题
│ │   node server.js  PID 9101  CPU ▌12%  RSS 620 MiB
│ │   …
│ └─ /srv/report-worker (2)
```

**分类器**（`probes/classify.ts` 纯函数，输入进程数组 + 项目 codeDir 列表 + policy.groupingRules，输出分组；先单测后接线）：

1. **私有服务**：`cwd` 非空且不在系统目录白名单（`/`、`/usr*`、`/var*`、`/opt`、`/System`、`/Library`、`/private/*` 等）→ 按 `cwd` 精确分组；`cwd` 匹配某项目 `codeDir` 前缀时回填 `projectId`（联动 R5）。
2. **常见通用软件服务**：内置名单（mysqld/mariadbd、postgres、redis-server、mongod、nginx、httpd/apache2、dockerd/containerd、supervisord、java 应用按 cwd 优先归私有）匹配进程名；`policy.groupingRules`（既有字段）可增删规则。
3. **系统应用**：内核线程（`kworker_*`、`[xxx]`）与系统守护（systemd、sshd、cron、rsyslogd、launchd、logind…名单内置）。
4. **未分类兜底**：cwd 因权限不可读的进程 → "其他"组诚实展示，不假装归类。

**cwd 采集**（`processEntrySchema` 增加 `cwd: z.string().nullable().default(null)`）：

- Linux：一次批量执行 `for d in /proc/[0-9]*; do printf '%s %s\n' "${d#/proc/}" "$(readlink "$d/cwd" 2>/dev/null)"; done`，按 PID 合并进快照。
- macOS：`lsof -a -d cwd -Fn -p <pids>` 分批（每批 ≤100 PID，超时 10s → 该批 cwd=null）。
- `monitoring.processes` 响应在既有扁平 `processes`（搜索用）之外增加 `groups` 字段，分类在 Host 完成避免客户端规则漂移。

### 4.4 R4 项目 Tab：大卡片列表

一级 Tab 文案 `项目运维` → `项目`；卡片参照服务器网格：

```
┌─ dsh-site ────────────────────── ● 部署成功 ─┐
│ git@…/dsh-site.git @ main                    │
│ web-01:/srv/dsh-site                         │
│ 服务 2/2 运行中   CPU 12%   MEM 1.2 GiB       │
│ 最近部署 2h 前 · commit a1b2c3d              │
│ [首次 AI 部署] [手动更新]        [进入详情 →] │
└──────────────────────────────────────────────┘
```

- 状态徽章：SUCCEEDED 绿 / RUNNING·REPAIRING 蓝呼吸 / FAILED·STOPPED 红 / 无部署灰。
- 数据源（只读库 + 受控缓存）：

```
projects.overview  {}  → Array<{
  project: Project,
  lastRun: DeploymentRun | null,
  serviceHealth: { running: number, total: number },   // 由最近进程快照按 §4.5 规则匹配
  aggregate: { cpuPercent: number|null, rssBytes: number|null },
  alertCount: { critical: number, warning: number },
  codeDirBytes: number | null,    // du -s 缓存 5min（可选，失败=null）
}>
```

- 新建项目表单同样折叠为 `+ 新建项目`；部署记录列表移入项目详情"服务"Tab 底部与卡片操作区，一级列表不再平铺全部 run。

### 4.5 R5 项目详情 · 服务 Tab

顶部为每个服务的资源卡片（大数字、图表优先），其下未关联进程列表与部署记录：

```
项目 / dsh-site                                    ← 返回
[服务] [日志]

┌ web (supervisor) ── ●运行中 ─────────────────────┐
│   CPU        内存 RSS        磁盘占用      日志占用  │
│  38.4%      1.8 GiB        2.3 GiB       412 MiB  │
│  (大数字)    (大数字)        (大数字)      (大数字)  │
│  ▁▂▃▅▃▂▃ 实时CPU  ▂▃▃▄▅▆ RSS   IO ↓12MB/s ↑3MB/s  │
│  PID 9101 · 运行 5d 3h · 3 进程                    │
└───────────────────────────────────────────────────┘
部署记录（时间线，含阶段展开）
```

数据源：新端点

```
monitoring.projectProcesses  { projectId }
  → {
    services: Array<{
      spec: ServiceSpec,
      processes: ProcessEntry[],
      aggregate: { cpuPercent, rssBytes, ioReadBytesPerSec|null, ioWriteBytesPerSec|null },
      status: 'running' | 'stopped' | 'unknown',   // 对照 healthCheck.expected / 进程存在性
    }>,
    unlinked: ProcessEntry[],       // cwd 在 codeDir 下但未登记 serviceSpec 的进程
  }
```

- 匹配规则：`managerId`/进程名匹配 `serviceSpec`；其余按 `cwd` 前缀 = `codeDir` 归入 unlinked。
- 指标口径与实现取舍（**诚实标注**）：
  - CPU/RSS：进程快照求和；CPU 注明"单核口径，可超 100%"（沿用现 UI 提示）。
  - 进程 IO：Linux 读 `/proc/PID/io` 两次差分（批量、best-effort），权限不足 → null 显示"—"；macOS v1 不做（null）。`processEntrySchema` 增加 `ioReadBytesPerSec`/`ioWriteBytesPerSec`（nullable）。
  - 磁盘占用：`du -sb <codeDir>` 一次执行，结果缓存 5min。
  - 日志占用：该项目 logSource 文件 `sizeBytes` 合计（`logSourceSchema` 增加 `sizeBytes: z.number().nullable().default(null)`，发现/巡检时 `stat` 更新）。
  - **服务级历史曲线为 BACKLOG**：首版曲线 = 页面打开期间客户端 5s 轮询累积的实时序列（Sparkline）+ 服务器级历史（§4.2）；进程快照历史落库（按服务聚合的时序表）列为 P2。

### 4.6 R5 项目详情 · 日志 Tab

```
项目 / dsh-site                                    ← 返回
[服务] [日志]                            [日志 AI 检查]

⛔ 异常横幅（critical，pulse 动画）：ERROR "connection refused" ×37（近1h）
⚠ WARN ×112

┌ 日志速率（行/分钟）────────┐ ┌ 级别分布 ────────────┐
│ (LineChart，ERROR 红色序列) │ │ ERROR 37 ███         │
│                            │ │ WARN  112 ████████   │
│                            │ │ INFO  8.2k ██████████│
└────────────────────────────┘ └──────────────────────┘

来源：web → /srv/dsh-site/logs/web.log  ●active  412 MiB  ▲2.1 KiB/s
      worker → …/worker.log           ●active   88 MiB  ▲0.4 KiB/s

┌ Tail（最后 200 行，自动刷新）────────────────────────┐
│ 12:03:01 INFO  request handled 200 …                 │
│ 12:03:04 ERROR connection refused  ← 红色高亮         │
│ ⋯gap 8.2 KiB（读取缺口标记）⋯                        │
└──────────────────────────────────────────────────────┘
```

- 数据源：扩展 `monitoring.logs` 响应（契约已预留 fragments 字段，Handler 补齐），或等价新端点（推荐后者，语义更清晰）：

```
monitoring.logTail  { projectId, limitLines?: 200 }
  → {
    sources: Array<LogSource & { sizeBytes, growthBytesPerSec|null }>,
    alerts: Alert[],
    stats: Array<{ sourceId, linesPerMinute|null, levelCount: { error, warn, info } }>,
    tail: Array<{ sourceId, line: string, level: 'error'|'warn'|'info'|null, at: number|null }>,
  }
```

- 级别识别在 Host 端：正则 `ERROR|FATAL|PANIC|CRITICAL` / `WARN`（大小写敏感匹配日志惯例），统计进 `stats`；行级 `level` 用于 tail 高亮。
- 异常判定（醒目呈现，满足"出现异常要明显显示"）：`alerts` 中 severity=critical → 顶部红色 pulse 横幅；ERROR 行红底高亮；速率曲线 ERROR 序列独立红色；`gapBeforeBytes` 缺口在 tail 中以标记行呈现（数据完整性诚实展示）。

## 5. 契约与 Host 变更总表

### 5.1 Schema diff（`src/contracts/entities.ts`）

| Schema | 变更 | 兼容性 |
| --- | --- | --- |
| `hardwareSampleSchema` | + `netRecvBytesPerSec`、`netSentBytesPerSec`（nullable，default null）；`unitNotes` 更新 | 旧样本缺字段 parse 为 null，无需迁移 |
| `processEntrySchema` | + `cwd`、`ioReadBytesPerSec`、`ioWriteBytesPerSec`（nullable，default null） | 同上 |
| `logSourceSchema` | + `sizeBytes`（nullable，default null） | 同上 |
| 新增 `processGroupSchema` | `{ kind: 'system'|'common'|'private'|'other', title, cwd?, projectId?, processes: ProcessEntry[] }` | 新表 |

> 全部为可空新增字段，`SCHEMA_VERSION` 不升级；zod default 保证旧记录读取通过。

### 5.2 端点 diff（`src/contracts/api.ts` + `host/api/devops-api.ts`）

| 端点 | 请求 → 响应 | 是否触发 SSH | 轮询安全 |
| --- | ---| --- | --- |
| `servers.overview`（新） | `{}` → §4.1 | 否（读库） | 4s ✓ |
| `projects.overview`（新） | `{}` → §4.4 | 否（du 结果缓存 5min） | 4s ✓ |
| `monitoring.history`（新） | `{serverId, rangeMinutes}` → `{samples}` | 否（读库） | 详情页 30s ✓ |
| `monitoring.projectProcesses`（新） | `{projectId}` → §4.5 | 是（一次进程采集 + IO 批读） | 详情页 5s，注明开销 |
| `monitoring.logTail`（新） | `{projectId, limitLines?}` → §4.6 | 否（读 fragments；增量读取由调度器负责） | 详情页 5s ✓ |
| `monitoring.processes`（改） | 响应 + `groups: ProcessGroup[]` | 是（既有行为） | 手动/详情页 |
| `monitoring.hardware`（改） | 成功采集后落库样本 | 是（既有行为） | 手动 |
| 其余端点 | 不变 | — | — |

### 5.3 Host 其他改动

| 文件 | 改动 |
| --- | --- |
| `probes/parsers.ts` | + `parseNetDev`/`parseNetstatIb`（差分速率）、`parseProcCwd`、`parseLsofCwd`、`parseProcIo`；均纯函数 |
| `probes/collector.ts` | Hardware 采集增加网络窗口差分；Process 采集追加 cwd 批量命令与合并 |
| `probes/classify.ts`（新） | 进程三分类 + 私有服务按 cwd 分组 + 分组规则（内置名单 + policy.groupingRules） |
| `repository/ops-repository.ts` | + `putHardwareSample`/`listHardwareSamples`（serverId+collectedAt 索引）；hardware_samples 纳入 retention 清理；logSource 增量维护 sizeBytes |
| `src/index.ts` | 调度器 `runKind('hardware')` 采集成功后落库（现丢弃处，`index.ts:180`） |
| `logs/log-service.ts` | + 级别统计与 tail 聚合辅助（读 fragments，不新增 SSH） |
| `servers/server-service.ts` | 无（overview 在 API 层聚合） |

## 6. 客户端文件改动

```text
src/client/
  entry.ts          # +一次性注入 <style id=dsh-devops-anim>（keyframes，随 dispose 移除）
  model.ts          # +overview/history/logTail/projectProcesses 拉取与缓存；
                    #  轮询分层：列表 4s / 硬件曲线 30s / 详情 5s；visibilitychange 暂停
  router.ts         # 新：View 状态机 + 返回栈 + 面包屑数据
  theme.ts          # 新：设计 token（间距/圆角/状态色/阴影/动效时长）
  charts.tsx        # 新：Donut / BigNumber / LineChart / Sparkline / MiniBar
  pages/
    app.tsx         # OpsApp 改造：分段大 Tab + View 路由分发
    servers-list.tsx    # 大卡片网格 + 添加抽屉（替代现 table+表单）
    server-hardware.tsx # 指标 Donut/大数字 + 历史曲线 + 立即检查
    server-processes.tsx# 三分类折叠分组 + 搜索 + AI findings
    projects-list.tsx   # 大卡片 + 新建抽屉 + 部署操作
    project-services.tsx# 服务资源卡片（大数字+图表）+ 部署时间线
    project-logs.tsx    # 异常横幅 + 速率/级别图表 + tail 视图
```

- 现单文件 `pages.tsx` 拆分删除；已核实 `tests/` 无对该文件导出组件的直接引用，可安全拆分。
- `OpsStore` 保持框架无关 + `useSyncExternalStore` 绑定模式不变；详情页数据以页面局部 state + 轮询为主，避免全局 store 膨胀。

## 7. 实施里程碑（每步可独立合入）

| 阶段 | 内容 | 交付判据 |
| --- | --- | --- |
| M0 | 契约冻结：§5.1/§5.2 全部 zod schema + 端点注册（Handler 可先返回空结构） | `pnpm typecheck` 通过；契约单测 round-trip |
| M1 | 客户端骨架：theme/router/charts/app 分段 Tab + 动效注入，两列表页用现有数据先上大卡片 | 静态数据下卡片网格、Tab 滑动、入场/hover 动效可演示；reduced-motion 生效 |
| M2 | `servers.overview` + 服务器大卡片真实数据（含告警计数、无数据态） | 卡片 4s 轮询不触发 SSH（日志验证）；空库/离线态正确 |
| M3 | 网络 IO 采集 + 样本落库 + `monitoring.history` + 硬件 Tab（Donut 指标区 + 曲线） | 服务器详情硬件 Tab 完整；30m~24h 曲线渲染；旧样本兼容 |
| M4 | cwd 采集 + 分类器 + 进程 Tab 三分组 | 分类矩阵单测通过（系统/通用/私有/其他/权限缺失）；分组 UI 折叠可用 |
| M5 | `projects.overview` + 项目大卡片 + 一级 Tab 更名"项目" | 部署状态徽章、服务健康、告警计数正确 |
| M6 | `monitoring.projectProcesses` + 服务 Tab（大数字卡片、du、/proc/PID/io best-effort） | 服务匹配率可解释（unlinked 可见）；IO 权限不足显示"—" |
| M7 | `monitoring.logTail` + 日志 Tab（横幅/图表/tail/高亮/缺口） | 构造 ERROR 日志与告警时横幅+红色高亮可见；gap 标记可见 |
| M8 | 回归：全量测试更新 + 视觉走查 | `pnpm test` 全绿（当前基线 149）；§8 手工清单逐条通过 |

## 8. 测试与验收

### 8.1 自动化

- **单测**：`parseNetDev`/`parseNetstatIb` 差分（含 lo 排除、计数器回绕）、`parseProcCwd`（空/权限拒绝）、`parseProcIo`、`classifyProcesses` 分类矩阵（含 groupingRules 覆盖、cwd 前缀匹配项目）、history 降采样、logTail 级别统计与 tail 截断。
- **契约**：新端点 zod 请求/响应 round-trip；`servers.overview` 空库/离线；`monitoring.history` 时间范围参数。
- **e2e**：现 149 用例回归（页面拆分后同步修正驱动代码）；新增冒烟：点服务器卡片→硬件 Tab→进程 Tab→返回；点项目卡片→服务/日志 Tab→返回；Tab 文案断言（无"监控"、有"项目"）。

### 8.2 手工视觉验收清单（对应需求逐条）

1. 服务器 Tab 为大卡片网格，卡片含平台/凭据/CPU/内存迷你图/告警数；一级 Tab 为大分段控件，切换有滑动指示条；卡片入场/hover/饼图/数字动效存在，系统开启"减少动态效果"时动效消失。
2. 无"监控"一级 Tab；点卡片进入详情页，开头即 CPU/内存/磁盘环形图（动画）+ 网络 IO 大数字（单位），下方 30m~24h 历史曲线可切换。
3. 服务器详情第二 Tab 进程按"系统应用 / 常见通用软件服务 / 私有服务（目录分组标题）"分区折叠展示，搜索仍可用。
4. 一级 Tab 文案为"项目"，项目为大卡片，含部署状态、服务健康、资源、告警。
5. 项目详情"服务"Tab：每服务 CPU/内存/磁盘/日志占用大数字 + 图表；"日志"Tab：速率曲线 + 级别分布 + tail，构造 ERROR 时红色高亮与 critical 横幅醒目。

### 8.3 性能预算

- 列表页 4s 轮询零 SSH（overview 全读库，端点目标 <50ms/10 服务器）。
- 24h 历史返回点数 ≤300（降采样）；hardware_samples 30 天清理。
- 打开服务器详情页期间 SSH 采集频次 ≤ 每 30s 一次（手动"立即检查"除外）。

## 9. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 卡片/曲线轮询放大 SSH 开销 | 全部读库端点（§5.2 已标注）；实时采集仅调度器(60s)与手动检查 |
| `/proc/PID/cwd`、`/proc/PID/io` 需要目标进程属主权限 | 返回 null，UI 显示"—/不可见"；sudo 凭据可选提权列为 P2 |
| macOS `lsof` 慢 | 分批 + 10s 超时，失败批 cwd=null，不阻塞快照返回 |
| 历史数据体积 | 降采样 + retentionDays 复用清理路径 |
| 自绘图表维护成本 | 组件限定 5 个、接口最小化（数据 in、SVG out）；缩放/hover tooltip 列 BACKLOG |
| 页面拆分破坏 e2e 基线 | M8 集中回归；e2e 驱动尽量走 API 断言而非 DOM 细节 |
| 旧记录缺新字段 | 全部 nullable+default，不做数据迁移 |

## 10. 明确不做（BACKLOG）

- 进程级/服务级历史时序落库（服务 Tab 曲线首版为会话内实时序列）。
- 图表缩放、hover tooltip、日志全文搜索与过滤语法。
- 服务器编辑（`servers.update`）、监控策略编辑的 UI 化。
- macOS 进程 IO、sudo 提权采集。
