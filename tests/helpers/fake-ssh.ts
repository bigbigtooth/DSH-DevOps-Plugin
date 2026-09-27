/**
 * High-fidelity `ssh` shim for integration tests.
 *
 * WHY: this environment's network layer transparently intercepts the system
 * ssh binary's localhost connections (TCP handshake completes but never
 * reaches the local listener), so a loopback sshd cannot be exercised here.
 * The shim replaces the BINARY via PATH while keeping everything the
 * OpenSshTransport actually controls: the private `-F` config semantics,
 * the controlled askpass protocol (prompt file + 0600 reply file), host-key
 * pinning vs accept-new, argv-based commands, stdin passthrough, exit codes
 * and connection-loss classification.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface FakeSshSetup {
  binDir: string
  rootDir: string
  password: string
  hostKeyEntry: string
  username: string
}

export function installFakeSsh(opts: { password?: string; username?: string; host?: string } = {}): FakeSshSetup {
  const binDir = mkdtempSync0('dsh-fakessh-bin-')
  const rootDir = mkdtempSync0('dsh-fakessh-root-')
  const username = opts.username ?? 'testuser'
  const host = opts.host ?? '127.0.0.1'
  const password = opts.password ?? 'test-password-123'
  const hostKeyEntry = `${host} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI测试FAKEKEY`
  const shim = join(binDir, 'ssh')
  writeFileSync(
    shim,
    [
      '#!/bin/sh',
      '# fake-ssh shim: emulates the subset of ssh that OpenSshTransport uses.',
      'set -u',
      'CFG=',
      'STRICT=',
      'ACCEPT_NEW=0',
      'CMD=',
      'ARGS=("")',
      'i=0',
      'for a in "$@"; do',
      '  i=$((i+1))',
      '  ARGS+=("$a")',
      'done',
      'i=1',
      'while [ $i -lt ${#ARGS[@]} ]; do',
      '  a=${ARGS[$i]}',
      '  case "$a" in',
      '    -F) i=$((i+1)); CFG=${ARGS[$i]} ;;',
      '    -o) i=$((i+1));',
      '        opt=${ARGS[$i]};',
      '        case "$opt" in',
      '          StrictHostKeyChecking=accept-new) ACCEPT_NEW=1 ;;',
      '          StrictHostKeyChecking=*) STRICT=yes ;;',
      '        esac ;;',
      '    -T|-v|-q) ;;',
      '    *) if [ -z "$CMD" ] && [ "$a" != "dsh-devops-target" ]; then CMD="$a"; fi ;;',
      '  esac',
      '  i=$((i+1))',
      'done',
      '',
      '# --- host key pinning (reads the private config exactly like ssh -F) ---',
      'KH=$(sed -n "s/^[[:space:]]*UserKnownHostsFile //p" "$CFG" | head -1 | sed "s/^\'//;s/\'$//")',
      'HOSTNAME=$(sed -n "s/^[[:space:]]*HostName //p" "$CFG" | head -1 | sed "s/^\'//;s/\'$//")',
      'EXPECTED="[${HOSTNAME}]:${FAKE_SSH_PORT}"',
      'if [ "${ACCEPT_NEW:-0}" = "1" ]; then',
      '  grep -qF "$HOSTNAME" "$KH" 2>/dev/null || printf \'%s\\n\' "$FAKE_SSH_HOSTKEY" >> "$KH"',
      'else',
      '  if [ ! -f "$KH" ] || ! grep -qF "$HOSTNAME" "$KH"; then',
      '    echo "Host key verification failed." >&2',
      '    exit 255',
      '  fi',
      '  if [ -n "${FAKE_SSH_ROTATED:-}" ]; then',
      '    echo "Host key verification failed." >&2',
      '    exit 255',
      '  fi',
      'fi',
      '',
      '# --- password auth via the controlled askpass protocol ---',
      'rm -f "$DSH_ASKPASS_DIR/reply"',
      'REPLY=$("$SSH_ASKPASS" "${FAKE_SSH_USER:-testuser}@${HOSTNAME}\'s password: " 2>/dev/null)',
      'ASK_RC=$?',
      'if [ "$ASK_RC" != "0" ] || [ "$REPLY" != "$FAKE_SSH_PASSWORD" ]; then',
      '  echo "Permission denied, please try again." >&2',
      '  exit 255',
      'fi',
      '',
      '# --- simulated connection drop AFTER auth (results unknown) ---',
      'if [ -n "${FAKE_SSH_DROP:-}" ]; then',
      '  echo "Connection to ${HOSTNAME} closed by remote host." >&2',
      '  exit 255',
      'fi',
      '',
      '# --- run the command through the real shell in the sandbox root ---',
      'if [ -z "$CMD" ]; then exit 0; fi',
      'cd "${FAKE_SSH_ROOT:-/tmp}" || exit 255',
      'eval "$CMD"',
      'exit $?',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )
  return { binDir, rootDir, password, hostKeyEntry, username }
}

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

function mkdtempSync0(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Build the env block a transport spawn will see in tests. */
export function fakeSshEnv(setup: FakeSshSetup): Record<string, string> {
  return {
    // the "remote" $HOME is the sandbox root so remote task dirs never leak
    HOME: setup.rootDir,
    FAKE_SSH_PASSWORD: setup.password,
    FAKE_SSH_HOSTKEY: setup.hostKeyEntry,
    FAKE_SSH_ROOT: setup.rootDir,
    FAKE_SSH_PORT: '22',
    FAKE_SSH_USER: setup.username,
    PATH: `${setup.binDir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  }
}
