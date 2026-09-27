# Safety and disclosure

This document states exactly what `dsh-devops` touches. It is written to be
audited against the source, not to be reassuring. If any line here stops
matching the code, that is a bug — please report it.

中文版见 [SAFETY.zh.md](./SAFETY.zh.md)。

## Install-time behaviour

- **No install lifecycle scripts.** The package declares no `preinstall`,
  `install` or `postinstall` hook. Nothing in this package executes on your
  machine as a side effect of `dsh plugin add` or `npm install` beyond the module
  being loaded.
- The distributed artefacts (`dist/index.js`, `dist/client/client.js`) are
  prebuilt. If you install from Git, you build it yourself — see
  [CONTRIBUTING.md](./CONTRIBUTING.md).
- Dependencies are `schemastery` and `zod` at runtime; everything else is a dev
  dependency. `@deepseek-ai/cordis` and `react` are **optional** peer
  dependencies provided by the host.

## What the plugin reads

| Path | Why | Mode |
| --- | --- | --- |
| `<dataDir>` (default `~/.dsh-devops`) | SSH config, encrypted credentials, inspection history, deployment tasks, verified scripts | read + write |
| `<dataDir>/ssh` | Plugin-private OpenSSH config and work files | read + write |
| Host storage domain `dsh_devops` | Versioned records via `ctx.storageDomain` | host-managed |
| Remote servers you add | Hardware, processes, log files, git working tree — over SSH | read (and write during deploy) |

`dataDir` is configurable through the patch layer. The plugin does not read your
`~/.ssh`, your shell history, or any file outside `dataDir` and the remote hosts
you explicitly add.

## What it stores, and how

- SSH passwords, key passphrases, Git credentials and sudo passphrases are
  wrapped with **AES-256-GCM** authenticated encryption. The envelope is
  versioned (`enc1:…`) so key rotation keeps older records readable.
- **Key material comes from `DSH_DEVOPS_KEY_FILE`.** When that variable is
  unset, the plugin falls back to an in-memory key that is regenerated on every
  host start — stored credentials then become undecryptable after a restart.
  **Set this variable before you save any credential.** There is no key escrow
  and no recovery: if the key file is lost, the credentials are gone.
- The key file is written with mode `0600`.
- Secrets are redacted before they reach the UI, the persistent store, remote
  command lines, deployment scripts, logs, or model context.

## Network egress

- **To your servers:** SSH over the OpenSSH binary, with the system config
  neutralised (`UserKnownHostsFile`, `GlobalKnownHostsFile`, `IdentitiesOnly`
  are each overridden with `-o`). No SSH command string is built through a
  shell — arguments are passed as an array.
- **Host fingerprint pinning:** the first connection records the host key;
  a changed fingerprint pauses the connection instead of trusting it.
- **To your model provider:** hardware samples, process listings and log
  excerpts are sent to whatever model the host resolves for `modelRef`, using
  the host's own LLM service and credentials. **The plugin never holds a model
  API key of its own.** With `modelRef: null`, AI steps report the capability as
  unavailable rather than falling back to anything.
- **No telemetry.** Nothing is sent to the maintainer, to a marketplace, or to
  any third-party endpoint. The plugin makes no network request other than the
  two above.

## AI boundaries

- **Inspection is read-only, and that is enforced structurally.** The agents
  registered for inspection receive only whitelisted read tools on their own
  scope; they do not inherit the general shell or file-write tools. The
  read-only boundary does not depend on prompt wording.
- Inspection never restarts a service and never repairs anything. It reports.
- **Deployment does write**, but only inside a task the user explicitly created:
  `git pull --ff-only`, dependency install, build, service restart, health
  check. A failed step is retried at most twice by AI-assisted repair, then
  reported.
- Deployment stops and reports rather than proceeding when the working tree is
  dirty, the branch does not match, or the remote has diverged. It does not
  force-push, reset, or auto-merge. There is no bulk rollback.
- Model output is treated as a claim, not as a fact: a deploy step has to be
  confirmed against the remote's actual state before the task advances.

## Host surface

- RPC is served at `/rpc/dsh-devops` over the **host's authenticated channel**.
  Every request payload is validated with zod at the API boundary.
- Side effects (timers, listeners, registered routes, open connections) are all
  registered through `ctx.effect()` or a disposer-bearing API, so the host's
  uninstall path reclaims them.
- Route registration is wrapped in `try/catch` and degrades to a no-op — a
  duplicate `(kind, path)` cannot take the host process down.

## What it never does

- Never reads or transmits DSH conversation content, credentials, or workspace
  files. AI context is assembled from inspection and deployment material only.
- Never installs anything from the internet on your servers beyond what the
  project's own dependency install step requires.
- Never runs unvalidated remote commands: every command goes through a
  whitelist parser.
- Never escalates privileges on its own. Sudo, if configured, is explicit.

## Reporting a vulnerability

Please **do not open a public issue**. Email the maintainer at
[davidwu@users.noreply.github.com](https://github.com/bigbigtooth) or use
GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**).

Include: affected plugin version, DSH version, reproduction steps, and the
relevant log excerpt with credentials removed. You can expect an
acknowledgement within a few days. There is no formal SLA and no bug bounty.

## Out of scope

dsh-devops is an operations tool. It is not hardened against a hostile target
host, and it should not be pointed at one.
