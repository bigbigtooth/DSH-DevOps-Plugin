/** Node spawn port: argv only, no shell, fully controlled environment. */
import { spawn } from 'node:child_process'
import type { SpawnPort } from './ports.ts'

export function spawnPortFromNode(): SpawnPort {
  return {
    spawn(argv, opts) {
      return new Promise((resolve) => {
        const child = spawn(argv[0]!, argv.slice(1), {
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', ...(opts.env ?? {}) },
        })
        let stdout = ''
        let stderr = ''
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', (c: string) => (stdout += c))
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (c: string) => (stderr += c))
        const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : null
        if (opts.input !== undefined) child.stdin.end(opts.input)
        else child.stdin.end()
        child.on('close', (code, signal) => {
          if (timer) clearTimeout(timer)
          resolve({ exitCode: code, signal, stdout, stderr })
        })
        child.on('error', (e) => resolve({ exitCode: null, signal: null, stdout, stderr: `${stderr}\n${e.message}` }))
      })
    },
  }
}
