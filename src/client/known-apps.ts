/**
 * Known-application presentation: icon + friendly label for process names
 * seen in the wild. Matching is case-insensitive with a trailing-colon
 * tolerance (`nginx:` from `nginx: worker process`). Unknown names fall
 * back to a generic gear icon and the raw name. Icons are stroke SVGs from
 * icons.tsx (IconName keys) — emoji rendered inconsistently across platforms
 * and too small next to text.
 */
import type { IconName } from './icons.tsx'

export interface KnownApp {
  icon: IconName
  label: string
}

const KNOWN_APPS: Record<string, KnownApp> = {
  nginx: { icon: 'globe', label: 'Nginx' },
  'nginx:': { icon: 'globe', label: 'Nginx' },
  apache2: { icon: 'feather', label: 'Apache' },
  httpd: { icon: 'feather', label: 'Apache' },
  'httpd-foreground': { icon: 'feather', label: 'Apache' },
  caddy: { icon: 'shield', label: 'Caddy' },
  traefik: { icon: 'route', label: 'Traefik' },
  haproxy: { icon: 'scale', label: 'HAProxy' },
  mysqld: { icon: 'database', label: 'MySQL' },
  mariadbd: { icon: 'database', label: 'MariaDB' },
  postgres: { icon: 'database', label: 'PostgreSQL' },
  postmaster: { icon: 'database', label: 'PostgreSQL' },
  'redis-server': { icon: 'zap', label: 'Redis' },
  mongod: { icon: 'leaf', label: 'MongoDB' },
  memcached: { icon: 'box', label: 'Memcached' },
  'clickhouse-server': { icon: 'database', label: 'ClickHouse' },
  etcd: { icon: 'database', label: 'etcd' },
  rabbitmq: { icon: 'message', label: 'RabbitMQ' },
  'rabbitmq-server': { icon: 'message', label: 'RabbitMQ' },
  'beam.smp': { icon: 'message', label: 'Erlang/OTP' },
  dockerd: { icon: 'box', label: 'Docker' },
  containerd: { icon: 'box', label: 'containerd' },
  'containerd-shim-runc-v2': { icon: 'box', label: 'containerd-shim' },
  'containerd-shim': { icon: 'box', label: 'containerd-shim' },
  kubelet: { icon: 'network', label: 'Kubelet' },
  supervisord: { icon: 'compass', label: 'Supervisor' },
  pm2: { icon: 'zap', label: 'PM2' },
  systemd: { icon: 'gear', label: 'systemd' },
  sshd: { icon: 'key', label: 'OpenSSH' },
  cron: { icon: 'clock', label: 'Cron' },
  crond: { icon: 'clock', label: 'Crond' },
  rsyslogd: { icon: 'file-text', label: 'rsyslog' },
  syslogd: { icon: 'file-text', label: 'syslog' },
  snapd: { icon: 'box', label: 'Snapd' },
  prometheus: { icon: 'flame', label: 'Prometheus' },
  grafana: { icon: 'chart', label: 'Grafana' },
  node: { icon: 'hexagon', label: 'Node.js' },
  'node-exporter': { icon: 'trend', label: 'Node Exporter' },
  python3: { icon: 'code', label: 'Python 3' },
  python: { icon: 'code', label: 'Python' },
  gunicorn: { icon: 'code', label: 'Gunicorn' },
  uvicorn: { icon: 'code', label: 'Uvicorn' },
  java: { icon: 'coffee', label: 'Java' },
  go: { icon: 'terminal', label: 'Go' },
  ruby: { icon: 'gem', label: 'Ruby' },
  puma: { icon: 'gem', label: 'Puma' },
  'php-fpm': { icon: 'code', label: 'PHP-FPM' },
  'php-fpm:': { icon: 'code', label: 'PHP-FPM' },
  bash: { icon: 'terminal', label: 'Bash' },
  sh: { icon: 'terminal', label: 'Shell' },
}

/** Resolve presentation for a process name; never returns null. */
export function knownApp(name: string): KnownApp {
  const lower = name.toLowerCase()
  const exact = KNOWN_APPS[lower] ?? KNOWN_APPS[lower.replace(/:$/, '')]
  if (exact) return exact
  const prefix = Object.keys(KNOWN_APPS).find((k) => lower.startsWith(k))
  return prefix ? KNOWN_APPS[prefix]! : { icon: 'gear', label: name }
}

/** Client labels for launch modes produced by applyLaunchModes(). */
export const LAUNCH_MODE_LABELS: Record<string, string> = {
  supervisor: 'Supervisor',
  pm2: 'PM2',
  systemd: 'systemd',
  launchd: 'launchd',
  docker: 'Docker',
  kubernetes: 'Kubernetes',
  npm: 'npm/yarn',
  'sh-script': 'sh 脚本',
  direct: '直接启动',
}

export function launchModeLabel(mode: string | null | undefined): string {
  if (!mode) return '未知'
  return LAUNCH_MODE_LABELS[mode] ?? mode
}
