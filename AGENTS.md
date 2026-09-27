# AGENTS.md — dsh-devops 开发约定

DSH（DeepSeek Harness）Web 内的远程运维插件：SSH 服务器管理、硬件/进程/日志监控、
AI 巡检与部署闭环。宿主通过 `dsh plugin` 机制加载**已安装的构建产物**，不是本仓库源码。

## 常用命令

```sh
pnpm typecheck          # tsc --noEmit
pnpm test               # vitest 全量（含 contract 测试，会重打 client bundle）
pnpm build              # 产出 dist/index.js + dist/client/client.js
pnpm pack --pack-destination dist   # 产出 dist/dsh-devops-<version>.tgz
```

## ⚠️ 强制流程：每次代码更新后必须刷新 dist 并同步 DSH 宿主引用

**用户已预先授权整套流程（含重启宿主），全程无需向用户确认，必须自动跑完，不允许只改代码就交付。**

原因（也是三个必踩的坑）：

1. 浏览器里的“远程运维”面板由 DSH 宿主下发，宿主加载的是安装副本
   `~/.dsh/profiles/web/node_modules/dsh-devops/dist/client/client.js`，
   刷新网页只会重新下发旧副本——不重新安装就永远看不到改动。
2. 同版本号直接 `add` 会被 pnpm 的 `file:` 缓存跳过，**必须先 `remove` 再 `add`**。
3. `dsh plugin add` 只写 manifest；bundle 是宿主**启动期**加载的，
   **必须重启宿主进程**才生效。

### 流程（每次代码改动完成后依次执行）

```sh
cd /Users/davidwu/GithubProject/DSH-DevOps

# 1. 质量门禁：不过就不继续
pnpm typecheck && pnpm test

# 2. 构建并打包（先清掉旧 tgz，避免被打进新包）
rm -f dist/*.tgz
pnpm build && pnpm pack --pack-destination dist

# 3. 换入 DSH 宿主的安装副本（remove → add，顺序不能反）
DSH=~/.dsh/tooling/node_modules/.bin/dsh
$DSH plugin --profile web remove dsh-devops
$DSH plugin --profile web add "$(pwd)/dist/"dsh-devops-*.tgz

# 4. 重启宿主（会短暂中断 DSH Web 会话，属预期行为，无需询问）
pkill -f '\.bin/dsh --profile web'
sleep 2
nohup ~/.dsh/tooling/node_modules/.bin/dsh --profile web >> /tmp/dsh-web.log 2>&1 &

# 5. 验证安装副本确实是新产物（时间戳应为刚刚；命中标记说明新代码已就位）
ls -la ~/.dsh/profiles/web/node_modules/dsh-devops/dist/client/client.js
grep -c "dsh-spin" ~/.dsh/profiles/web/node_modules/dsh-devops/dist/client/client.js
```

第 5 步的 `grep` 标记会随代码演进过期，换成当次改动中稳定存在的新增字符串即可；
关键不是这个标记本身，而是**必须核实安装副本已更新**，不能默认 remove → add 一定成功。

### 完成的定义

一次代码更新只有在满足以下全部条件后才算交付：

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm test` 全量通过
- [ ] dist 已重新 build + pack（dist 内无嵌套 tgz）
- [ ] remove → add 已执行，安装副本时间戳/内容已核实为最新
- [ ] 宿主已重启并确认进程存活（`ps aux | grep 'dsh --profile web'`）
- [ ] 已提示用户刷新网页查看新 UI

## 其他约定

- 文档与注释一律中文；代码风格与周边保持一致（`h()` + `createElement`，无 JSX 语法糖）。
- UI 图标使用 `src/client/icons.tsx` 的内联 SVG（`Icon` 组件），不要引入 emoji 图标。
- 面向用户的文案一律中文；状态/阶段/kind 等枚举不得以英文原样露出
  （用 `statusLabel` / `stageLabel` / `kindLabel` / `launchModeLabel` 等映射）。
- 改动涉及 UI 时，按 AGENTS 流程同步宿主后提示用户刷新页面验收。
