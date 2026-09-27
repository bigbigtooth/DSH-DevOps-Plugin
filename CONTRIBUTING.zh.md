# 参与 dsh-devops 开发

感谢你愿意参与。本文件说明本地工作流；英文版见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 环境准备

- Node.js 22+
- pnpm 11+（没有的话先 `corepack enable pnpm`）

```sh
git clone https://github.com/bigbigtooth/DSH-DevOps-Plugin.git
cd DSH-DevOps-Plugin
pnpm install
```

## 提交前必过

质量门禁就是 CI 跑的那一套，不通过不会合入：

```sh
pnpm typecheck
pnpm test
```

`pnpm test` 是全量（单元、DSH 运行时契约、SSH 与部署集成、端到端、验收）。
契约测试会重新打 client bundle，所以 `dist/` 里的旧产物不会让它蒙混过关。
SSH 与部署套件跑在进程内 fake 上，不需要真实服务器。

## 本地装进 DSH profile

插件 bundle 在宿主启动期加载，所以每次安装后都必须重启。两个务必记住的坑：

- **同版本号重装不生效** —— pnpm 会对相同 `file:` 规格命中缓存。要么升版本号，
  要么先 `remove` 再 `add`。
- `dsh plugin add` 只写 manifest，bundle 是宿主启动时才读的。

```sh
rm -f dist/*.tgz
pnpm build && pnpm pack --pack-destination dist

DSH=~/.dsh/tooling/node_modules/.bin/dsh
$DSH plugin --profile web remove dsh-devops
$DSH plugin --profile web add "$(pwd)/dist/"dsh-devops-*.tgz

pkill -f '\.bin/dsh --profile web'
sleep 2
nohup ~/.dsh/tooling/node_modules/.bin/dsh --profile web >> /tmp/dsh-web.log 2>&1 &
```

必须核实安装副本确实是刚构建的产物，**不能默认 remove → add 一定成功**：

```sh
ls -la ~/.dsh/profiles/web/node_modules/dsh-devops/dist/client/client.js
```

## 验证安装

安装过程没有 console exporter，`ctx.logger` 只写 1000 条内存缓冲，
所以日志和退出码都不构成验证信号。唯一硬证据是「层是否加载」加「真实路由是否有返回」：

```sh
dsh --profile web --dump-config | grep -A5 'dsh-devops'   # 层在不在
# 再启动宿主，打一次真实 RPC 路由
```

## 代码约定

- 注释与文档一律中文，风格与周边保持一致。
- UI 是 `h()` + `createElement` 的纯 DOM 写法，client 侧不引入 JSX 语法糖。
- 图标用 `src/client/icons.tsx` 里的内联 SVG `Icon` 组件，不要引入 emoji 图标。
- 面向用户的文案一律中文；`status` / `stage` / `kind` / `launchMode` 等枚举
  不得以英文原样露出，要走 `statusLabel` / `stageLabel` / `kindLabel` /
  `launchModeLabel` 映射。
- 巡检边界是**只读**，且由工具权限强制执行，不靠提示词约束 —— 请保持这一点。

## 报告缺陷

用缺陷模板开 issue。请附上 DSH 版本（`dsh --version`）、平台，以及
`/tmp/dsh-web.log` 的相关片段。涉及凭据的问题请勿粘贴，
先看 [SAFETY.md](./SAFETY.md)。

## 安全问题

不要开公开 issue，见 [SAFETY.md](./SAFETY.md)。

## 许可

你贡献的内容以 [MIT License](./LICENSE) 授权。
