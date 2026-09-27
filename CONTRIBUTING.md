# Contributing to dsh-devops

Thanks for taking the time to contribute. This document covers the local
workflow; the Chinese version lives in [CONTRIBUTING.zh.md](./CONTRIBUTING.zh.md).

## Prerequisites

- Node.js 22+
- pnpm 11+ (`corepack enable pnpm` if you do not have it)

```sh
git clone https://github.com/bigbigtooth/DSH-DevOps-Plugin.git
cd DSH-DevOps-Plugin
pnpm install
```

## Before you open a pull request

The quality gate is the same one CI runs. Nothing gets merged without it:

```sh
pnpm typecheck
pnpm test
```

`pnpm test` is the full suite — unit, DSH runtime contract, SSH and deployment
integration, end-to-end and acceptance. It rebuilds the client bundle as part of
the contract test, so a stale `dist/` will not make it pass. The SSH and
deployment suites run against an in-process fake, so no real server is needed.

## Local install into a DSH profile

Plugin bundles are loaded at host startup, so a restart is required after every
install. Two traps worth memorising:

- Reinstalling the **same version** is a no-op — pnpm serves the `file:` spec
  from cache. Bump the version, or `remove` before `add`.
- `dsh plugin add` only writes the manifest. The bundle is read during host
  boot.

```sh
rm -f dist/*.tgz
pnpm build && pnpm pack --pack-destination dist

DSH=~/.dsh/tooling/node_modules/.bin/dsh
$DSH plugin --profile web remove @bigbigtooth/dsh-devops
$DSH plugin --profile web add "$(pwd)/dist/"bigbigtooth-dsh-devops-*.tgz

pkill -f '\.bin/dsh --profile web'
sleep 2
nohup ~/.dsh/tooling/node_modules/.bin/dsh --profile web >> /tmp/dsh-web.log 2>&1 &
```

Verify the installed copy is really the artefact you just built — do not assume
`remove` then `add` succeeded:

```sh
ls -la ~/.dsh/profiles/web/node_modules/@bigbigtooth/dsh-devops/dist/client/client.js
```

## Verifying an install

There is no console exporter during install, and `ctx.logger` only writes to an
in-memory buffer, so neither logs nor exit codes prove anything. The only hard
signals are that the layer loads and that a real route answers:

```sh
dsh --profile web --dump-config | grep -A5 'dsh-devops'   # the layer is present
# then start the host and exercise a real RPC route
```

## Code conventions

- Comments and docs are written in Chinese; keep the surrounding style.
- UI is plain DOM via `h()` + `createElement` — no JSX sugar in the client.
- Icons come from the inline SVG `Icon` component in `src/client/icons.tsx`.
  Do not introduce emoji as icons.
- All user-facing strings are Chinese. Enum-like values (`status`, `stage`,
  `kind`, `launchMode`, …) must never surface in English; map them through
  `statusLabel` / `stageLabel` / `kindLabel` / `launchModeLabel`.
- The inspection boundary is **read-only**. That is enforced by tool
  permissions, not by prompt wording — keep it that way.

## Reporting bugs

Open an issue using the bug report template. Please include your DSH version
(`dsh --version`), your platform, and the relevant section of
`/tmp/dsh-web.log`. If the issue involves credentials, do not paste them —
see [SAFETY.md](./SAFETY.md).

## Security issues

Do not open a public issue. Follow [SAFETY.md](./SAFETY.md).

## License

By contributing you agree that your work is licensed under the
[MIT License](./LICENSE).
