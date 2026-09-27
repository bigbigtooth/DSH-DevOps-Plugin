<div align="center">

# dsh-devops

**把服务器运维搬进 DSH Web：SSH 服务器管理 · 硬件 / 进程 / 日志监控 · AI 巡检 · Git 部署闭环**

[English](./README.md) · [中文](./README.zh.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.2-informational)](https://github.com/deepseek-ai/deepseek-harness)
[![Platform](https://img.shields.io/badge/host-Linux%20%7C%20macOS-lightgrey)](#功能特性)
[![Tests](https://img.shields.io/badge/tests-unit%20%2F%20contract%20%2F%20e2e%20%2F%20acceptance-passing-green)](#开发与测试)
[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-2f6feb)](https://github.com/topics/dsh-plugin)

</div>

---

## 这是什么

dsh-devops 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）Web 插件。
不用离开聊天界面、不用另开终端，你在 DSH 侧栏点开「远程运维」，就能添加 SSH 服务器、
查看硬件与进程、让 AI 定时巡检日志和进程异常，并把 Git 仓库的代码部署到服务器、重启服务。

它最核心的是一个**部署闭环**：

1. **首次 AI 部署** —— 选定 Git 仓库、分支与目标服务器，AI 通过 SSH 完成环境检查、依赖安装、
   构建、服务启动与健康验证；
2. **脚本固化** —— 部署成功后，把可复用的步骤沉淀为带版本管理的 `.sh` 脚本
   （`候选 → 已验证 → 失效`，哈希防篡改），一次性环境操作与日常更新分开对待；
3. **一键更新** —— 后续部署在服务器上执行 `git pull --ff-only`（只快进，杜绝意外合并/变基），
   固定步骤直接执行脚本、未固化步骤由 AI 兜底，失败自动修复（默认最多 2 轮）后重试。

> 巡检永远只读：AI 只分析与建议，不自行修复或重启服务。
> 这个边界由工具权限在结构上强制执行，不依赖提示词措辞。

## 界面预览

| 服务器总览 | 硬件监控 |
| --- | --- |
| ![服务器总览：环形仪表与告警状态](docs/images/servers.png) | ![硬件监控：趋势图表](docs/images/hardware.png) |

| 进程分组与 AI 巡检 | 项目服务详情 |
| --- | --- |
| ![进程监控：按项目分组](docs/images/processes.png) | ![项目详情：资源合计](docs/images/project-detail.png) |

**项目运维**：多项目、多仓库、多部署目标，首次 AI 部署 / 手动更新一键触发。

![项目列表](docs/images/projects.png)

## 功能特性

### 🖥 服务器管理

- 多台 SSH 服务器增删改查；**添加前强制真实登录测试**，能无人值守执行远程命令才能保存
- 首次连接核对并保存主机指纹，指纹变化即暂停连接
- 插件私有 SSH 配置，与系统 / 用户配置完全隔离；支持私钥、跳板机
- 覆盖 Linux（不设发行版白名单）与 macOS，能力不满足时如实标注「可用 / 受限 / 不可用」及原因

### 📊 监控与 AI 巡检

- **硬件**：CPU / 内存 / 磁盘使用情况，手动或定时采集（默认 60 秒）
- **进程**：无需逐个配置，全量枚举运行进程并按项目 / 服务分组；AI 逐批分析资源与状态异常，
  给出具体进程与判断依据，分析覆盖率透明展示（部分分析不会伪装成正常）
- **日志**：按「项目 → 服务 → 日志文件」动态发现日志来源（如读取 Supervisor 实际生效配置），
  增量读取、告警去重；AI 识别异常与告警，展示级别、摘要与可定位的原文证据
- **服务端执行**：关闭浏览器不停止巡检；DSH 重启后自动恢复巡检计划，不无限堆积补跑

### 🚀 项目部署

- 多项目、多仓库、多部署目标；SSH、Git 认证、提权分别配置、分别验证
- 首次部署由 AI 编排，部署前确定健康检查（预期进程、端口、等待时限），并动态刷新日志监控
- 后续部署：仓库 / 分支核对 → `git pull --ff-only` → 依赖更新 / 构建 → 服务重启 → 健康验证
- 未提交改动、分支不符、分叉冲突一律停止报告，绝不自动覆盖；默认不提供危险的全量回滚
- 任务全程持久化，中断后标记「中断 / 待核对」，核对远程实际状态后才能继续

### 🛡 安全设计

- 凭据（密码 / 私钥 / 口令）**AES-256-GCM 加密存储**，密钥材料与配置数据分离
- 敏感信息在展示、持久化、送入 AI 上下文前统一**脱敏**；密码不进命令、脚本与日志
- 远程命令经**白名单解析**；巡检为只读边界（工具权限实施，不靠提示词约束）
- RPC 走宿主认证通道，API 层 zod 全量校验
- **无安装期脚本**，无遥测，插件自身不持有模型 API Key

## 快速开始

### 环境要求

- DSH Web 宿主（支持 `dsh plugin` 插件机制），已验证版本见下方[兼容性](#兼容性)
- 能连到目标服务器的 SSH 客户端
- ⚠️ **保存任何凭据前，先设置 `DSH_DEVOPS_KEY_FILE`**（见下方说明）

### 安装

两条路径都是预构建的，**你不需要在本机跑任何构建**：

```sh
# 从 npm 安装（推荐：免掉构建授权）
dsh plugin --profile web add @bigbigtooth/dsh-devops

# 或从预构建 tarball 安装
dsh plugin --profile web add https://github.com/bigbigtooth/DSH-DevOps-Plugin/releases/latest/download/dsh-devops-latest.tgz
```

装完**必须重启宿主** —— 插件 bundle 在启动期加载，`plugin add` 只写 manifest：

```sh
pkill -f '\.bin/dsh --profile web'
sleep 2
nohup ~/.dsh/tooling/node_modules/.bin/dsh --profile web >> /tmp/dsh-web.log 2>&1 &
```

安装后，DSH 侧栏底部、「设置」上方会出现**远程运维**入口；点击进入独立运维面板，
点「返回会话」随时恢复聊天。

> 无头场景把 `--profile web` 换成 `--profile headless`；本插件的 UI 半侧只在
> web profile 下提供，headless 下巡检与部署照常工作。

### ⚠️ 三个必踩的坑

1. **先设密钥文件。** 不设 `DSH_DEVOPS_KEY_FILE` 时插件使用进程内内存密钥，
   宿主每次启动重新生成，**已保存的凭据在重启后无法解密**：
   ```sh
   export DSH_DEVOPS_KEY_FILE="$HOME/.dsh-devops/master.key"
   ```
   密钥文件以 `0600` 写入。**没有找回通道 —— 密钥文件丢了凭据就没了。**
2. **同版本号重装不生效。** pnpm 对相同 `file:` 规格命中缓存，必须先 remove 再 add：
   ```sh
   dsh plugin --profile web remove @bigbigtooth/dsh-devops
   dsh plugin --profile web add @bigbigtooth/dsh-devops
   ```
3. **必须重启宿主。** 见上。

## 权限与副作用

完整披露见 **[SAFETY.md](./SAFETY.md)**（中文 [SAFETY.zh.md](./SAFETY.zh.md)）。摘要：

| 项目 | 说明 |
| --- | --- |
| 读取的本地文件 | 仅 `<dataDir>`（默认 `~/.dsh-devops`）与宿主存储域 `dsh_devops`；**不读** `~/.ssh`、shell 历史 |
| 读取的远程文件 | 你添加的服务器上的硬件、进程、日志、git 工作树 |
| 网络出口 | ① 到你的服务器（SSH）；② 到你配置的模型（巡检 / 部署数据）。**无遥测、无第三方端点** |
| API Key | 插件自身**不持有**任何模型 API Key，使用宿主 LLM 服务 |
| 写入行为 | 巡检只读；部署仅在你显式创建的任务内写（`git pull --ff-only`、构建、重启） |
| 会话数据 | **不读取、不外传** DSH 会话内容、凭据与工作区文件 |
| 安装期脚本 | 无 `preinstall` / `install` / `postinstall` |

## 兼容性

DSH 目前全线在 rc，且官方明确会有破坏性兼容变更。请按下表对齐：

| dsh-devops | DSH (harness) | 状态 |
| --- | --- | --- |
| 0.5.0 | 0.1.5-rc.2 | ✅ 已实测（含全量测试与实机安装） |
| 0.4.x | 0.1.5-rc.2 | ✅ 已实测 |

> 0.5.0 起包名从 `dsh-devops` 改为 `@bigbigtooth/dsh-devops` —— 因为 npm 上不带 scope
> 的同名包已被他人预留占用。0.4.x 仍可从 `v0.4.0` 的 release 资产安装。

宿主版本用 `dsh --version` 查看。`dsh-devops` 对 `@deepseek-ai/cordis` 声明的是
**正式版**范围（`^4.0.1`，两者均为 optional peer），因此不涉及预发布三元组
匹配问题；宿主换 minor 时请优先升级本插件。

## 验证安装

安装过程没有 console exporter，`ctx.logger` 只写内存缓冲，
**日志和退出码都不构成验证信号**。唯一硬证据是「层是否加载」加「真实路由是否有返回」：

```sh
# 1) 配置层在不在（应能看到 dsh-devops 这一层）
dsh --profile web --dump-config | grep -A5 'dsh-devops'

# 2) 宿主启动日志里不应有 activation 门禁失败

# 3) 启动后打开「远程运维」面板，添加一台服务器 —— 添加前的登录测试会真实
#    执行远程命令，它成功才算装通
```

## 配置

以下默认值可通过 cordis patch 层覆盖：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `~/.dsh-devops` | 私有数据目录（SSH 配置、密钥、降级存储） |
| `modelRef` | null | AI 巡检 / 部署所用模型；为空时 AI 步骤诚实报告不可用 |
| `hardwareIntervalSeconds` | 60 | 硬件巡检周期 |
| `processIntervalSeconds` / `logsIntervalSeconds` | 300 | 进程 / 日志 AI 巡检周期 |
| `retentionDays` | 30 | 普通历史保留（配置、有效脚本不清理） |
| `batchBudgetTokens` | 8000 | 单批 AI 输入预算 |

环境变量 `DSH_DEVOPS_KEY_FILE` 指定凭据主密钥文件路径（见上方坑 1）。

## 从源码安装

```sh
git clone https://github.com/bigbigtooth/DSH-DevOps-Plugin.git
cd DSH-DevOps-Plugin
pnpm install
pnpm build && pnpm pack --pack-destination dist

dsh plugin --profile web remove @bigbigtooth/dsh-devops   # 同版本重装必须先 remove
dsh plugin --profile web add ./dist/bigbigtooth-dsh-devops-*.tgz
```

从 Git 安装需要你自己构建 —— git 安装不跑构建脚本。

## 开发与测试

```sh
pnpm typecheck            # 严格类型（Host/Client/Tests）
pnpm test:unit            # 契约/SSH/Vault/仓库/执行/采集/巡检/日志/调度/脚本…
pnpm test:contract:dsh    # 真实 cordis 运行时生命周期 + 重启持久化
pnpm test:integration:ssh # 私有配置/askpass/指纹/执行/停止
pnpm test:integration:ops # 真实 git 仓库部署管线
pnpm test:e2e:web         # 全链路 + 反例矩阵
pnpm test:acceptance      # 产品验收可执行子集
pnpm test                 # 全部
```

SSH 与部署集成测试跑在进程内 fake 上，不需要真实服务器。贡献指南见
[CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md)。

## 架构（Host / Client 单 bundle）

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

<details>
<summary>插件集成备忘（给二次开发者）</summary>

- patch 行不写 `config` 时插件拿到的是 `undefined`（不是 `{}`），`Config` 必须用
  `.prefault({})` 兜底，否则整棵插件树启动失败。
- 宿主服务名与存储名有语法约束：服务必须经 `ctx.get(name)` 读取；
  domain/表名须匹配 `^[a-z][a-z0-9_]*$`（如 `dsh-devops`→`dsh_devops`、
  `inspectionRuns`→`inspection_runs`），由适配器在边界处映射。
- 卸载时多个异步 disposer 是**并发**执行的（逆注册序，但无串行完成保证）。
  有顺序依赖的清理必须合并进**同一个** `ctx.effect` 返回的单个 disposer 里串行 await。

</details>

## 文档

- [产品设计（PROD）](docs/PROD.md) —— 产品目标、需求与设计默认值
- [实施计划（PLAN）](docs/PLAN.md)
- [宿主集成（INTEGRATION）](docs/INTEGRATION.md) —— 接入决策与设计要点
- [验收状态（ACCEPTANCE）](docs/ACCEPTANCE.md) —— 验收结果与兼容矩阵
- [安全与行为披露](SAFETY.md) / [安全与行为披露（中文）](SAFETY.zh.md)
- [贡献指南](CONTRIBUTING.zh.md) / [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
