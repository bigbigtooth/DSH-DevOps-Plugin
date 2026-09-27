<div align="center">

# dsh-devops

**把服务器运维搬进 DSH Web：SSH 服务器管理 · 硬件 / 进程 / 日志监控 · AI 巡检 · AI 部署闭环**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](#license)
[![Platform](https://img.shields.io/badge/%E7%9B%AE%E6%A0%87-Linux%20%7C%20macOS-lightgrey)](#功能特性)
[![Tests](https://img.shields.io/badge/%E6%B5%8B%E8%AF%95-unit%20%2F%20integration%20%2F%20e2e-green)](#开发与测试)

</div>

---

## 这是什么

dsh-devops 是一个 DeepSeek Harness（DSH）Web 插件。
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

## 功能特性

### 🖥 服务器管理

- 多台 SSH 服务器增删改查；**添加前强制真实登录测试**，能无人值守执行远程命令才能保存
- 首次连接核对并保存主机指纹，指纹变化即暂停连接
- 插件私有 SSH 配置，与系统/用户配置完全隔离；支持私钥、跳板机
- 覆盖 Linux（不设发行版白名单）与 macOS，能力不满足时如实标注「可用 / 受限 / 不可用」及原因

### 📊 监控与 AI 巡检

- **硬件**：CPU / 内存 / 磁盘使用情况，手动或定时采集（默认 60 秒）
- **进程**：无需逐个配置，全量枚举运行进程并按项目/服务分组；AI 逐批分析资源与状态异常，
  给出具体进程与判断依据，分析覆盖率透明展示（部分分析不会伪装成正常）
- **日志**：按「项目 → 服务 → 日志文件」动态发现日志来源（如读取 Supervisor 实际生效配置），
  增量读取、告警去重；AI 识别异常与告警，展示级别、摘要与可定位的原文证据
- **服务端执行**：关闭浏览器不停止巡检；DSH 重启后自动恢复巡检计划，不无限堆积补跑

### 🚀 项目部署

- 多项目、多仓库、多部署目标；SSH、Git 认证、提权分别配置、分别验证
- 首次部署由 AI 编排，部署前确定健康检查（预期进程、端口、等待时限），并动态刷新日志监控
- 后续部署：仓库/分支核对 → `git pull --ff-only` → 依赖更新/构建 → 服务重启 → 健康验证
- 未提交改动、分支不符、分叉冲突一律停止报告，绝不自动覆盖；默认不提供危险的全量回滚
- 任务全程持久化，中断后标记「中断/待核对」，核对远程实际状态后才能继续

### 🛡 安全设计

- 凭据（密码/私钥/口令）**AES-256-GCM 加密存储**，解密材料与配置数据分离
- 敏感信息在展示、持久化、送入 AI 上下文前统一**脱敏**；密码不进命令、脚本与日志
- 远程命令经**白名单解析**；巡检为只读边界（工具权限实施，不靠提示词约束）
- RPC 走宿主认证通道，API 层 zod 全量校验

## 快速开始

### 环境要求

- DSH Web 宿主（支持 `dsh plugin` 插件机制）
- Node.js 与 pnpm

### 构建与安装

```sh
git clone https://github.com/bigbigtooth/DSH-DevOps-Plugin.git
cd DSH-DevOps-Plugin
pnpm install
pnpm build && pnpm pack --pack-destination dist

# 换入 DSH 宿主
dsh plugin --profile web add ./dist/dsh-devops-*.tgz
dsh --profile web
```

安装后，DSH 侧栏底部、「设置」上方会出现**远程运维**入口；点击进入独立运维面板，
点「返回会话」随时恢复聊天。

### 升级注意

两个容易踩的坑：

- **同版本号重装不生效**：pnpm 对相同 `file:` 规格命中缓存，必须先 remove 再 add
  （或升版本号）：
  ```sh
  dsh plugin --profile web remove dsh-devops
  dsh plugin --profile web add ./dist/dsh-devops-*.tgz
  ```
- **必须重启宿主**：插件 bundle 在宿主启动期加载，`plugin add` 后需重启 DSH Web 进程。

## 配置

以下默认值可通过 cordis.yml patch 覆盖：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `dataDir` | `~/.dsh-devops` | 私有数据目录（SSH 配置、密钥、降级存储） |
| `modelRef` | null | AI 巡检/部署所用模型；为空时 AI 步骤诚实报告不可用 |
| `hardwareIntervalSeconds` | 60 | 硬件巡检周期 |
| `processIntervalSeconds` / `logsIntervalSeconds` | 300 | 进程/日志 AI 巡检周期 |
| `retentionDays` | 30 | 普通历史保留（配置、有效脚本不清理） |
| `batchBudgetTokens` | 8000 | 单批 AI 输入预算 |

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

<details>
<summary>插件集成备忘（给二次开发者）</summary>

- patch 行不写 `config` 时插件拿到的是 `undefined`（不是 `{}`），`Config` 必须用
  `.prefault({})` 兜底，否则整棵插件树启动失败。
- 宿主服务名与存储名有语法约束：服务必须经 `ctx.get(name)` 读取；
  domain/表名须匹配 `^[a-z][a-z0-9_]*$`（如 `dsh-devops`→`dsh_devops`、
  `inspectionRuns`→`inspection_runs`），由适配器在边界处映射。

</details>

## 文档

- [产品设计（PROD）](docs/PROD.md) —— 产品目标、需求与设计默认值
- [实施计划（PLAN）](docs/PLAN.md)
- [宿主集成（INTEGRATION）](docs/INTEGRATION.md) —— 接入决策与设计要点
- [验收状态（ACCEPTANCE）](docs/ACCEPTANCE.md) —— 验收结果与兼容矩阵

## License

[MIT](package.json)
