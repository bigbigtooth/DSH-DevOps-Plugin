import { describe, expect, it } from 'vitest'
import { execSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderWrapper } from '../../src/host/execution/wrapper.ts'

function makeTaskDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wrapper-'))
  writeFileSync(join(dir, 'wrapper.sh'), renderWrapper(), { mode: 0o755 })
  return dir
}

function runWrapper(dir: string, args: string, timeout = 20_000): { status: number; stdout: string } {
  try {
    const stdout = execSync(`sh '${join(dir, 'wrapper.sh')}' ${args}`, { encoding: 'utf8', timeout, cwd: dir })
    return { status: 0, stdout }
  } catch (e) {
    const err = e as { status?: number; stdout?: string }
    return { status: err.status ?? 1, stdout: err.stdout ?? '' }
  }
}

describe('remote wrapper on real sh (S3)', () => {
  it('start runs the payload, publishes atomic exit facts and status=finished', () => {
    const dir = makeTaskDir()
    writeFileSync(join(dir, 'token'), 'tok-123')
    writeFileSync(join(dir, 'payload.sh'), 'sleep 0.3\necho hello-world\nexit 7\n')
    const r = runWrapper(dir, `start '${dir}'`)
    expect(r.status).toBe(0) // the wrapper publishes facts; its own exit is 0
    expect(readFileSync(join(dir, 'output.log'), 'utf8')).toContain('hello-world')
    expect(readFileSync(join(dir, 'exitcode'), 'utf8')).toBe('7')
    expect(existsSync(join(dir, 'signal'))).toBe(false)
    expect(Number(readFileSync(join(dir, 'finished'), 'utf8'))).toBeGreaterThan(0)
    expect(readFileSync(join(dir, 'status'), 'utf8').trim()).toBe('finished')
    expect(readFileSync(join(dir, 'pid'), 'utf8').trim()).toMatch(/^\d+$/)
    expect(readFileSync(join(dir, 'lstart'), 'utf8').trim()).not.toBe('')
  })

  it('signal exits leave empty exitcode + signal marker', () => {
    const dir = makeTaskDir()
    writeFileSync(join(dir, 'token'), 'tok')
    writeFileSync(join(dir, 'payload.sh'), 'kill -TERM $$\n')
    runWrapper(dir, `start '${dir}'`)
    expect(existsSync(join(dir, 'signal'))).toBe(true)
    expect(readFileSync(join(dir, 'status'), 'utf8').trim()).toBe('finished')
  })

  it('stop terminates a live payload process group and records stop facts', async () => {
    const dir = makeTaskDir()
    writeFileSync(join(dir, 'token'), 'tok-stop')
    writeFileSync(join(dir, 'payload.sh'), 'sleep 30\n')
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    const child = spawn('sh', [join(dir, 'wrapper.sh'), 'start', dir], { stdio: 'ignore', detached: true })
    child.unref()
    // wait for the payload to register
    const deadline = Date.now() + 5000
    while (!existsSync(join(dir, 'pid')) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const pid = readFileSync(join(dir, 'pid'), 'utf8').trim()
    expect(Number(pid)).toBeGreaterThan(0)
    // process alive?
    const aliveBefore = (() => {
      try {
        process.kill(Number(pid), 0)
        return true
      } catch {
        return false
      }
    })()
    expect(aliveBefore).toBe(true)
    const r = runWrapper(dir, `stop '${dir}'`, 30_000)
    expect(r.status).toBe(0)
    const stopResult = readFileSync(join(dir, 'stop.result'), 'utf8')
    expect(stopResult).toContain('pidAliveBefore=1')
    expect(stopResult).toContain('pidAliveAfter=0')
    expect(readFileSync(join(dir, 'status'), 'utf8').trim()).toBe('stopped')
    try {
      process.kill(Number(pid), 0)
      throw new Error('payload survived stop')
    } catch (e) {
      if ((e as Error).message === 'payload survived stop') throw e
    }
  })

  it('status reports absent for unknown dir and running mid-flight', async () => {
    const dir = makeTaskDir()
    expect(runWrapper(dir, `status '${dir}/missing'`).stdout.trim()).toBe('absent')
    writeFileSync(join(dir, 'payload.sh'), 'sleep 6\n')
    const { spawn } = require('node:child_process') as typeof import('node:child_process')
    const child = spawn('sh', [join(dir, 'wrapper.sh'), 'start', dir], { stdio: 'ignore', detached: true })
    child.unref()
    const deadline = Date.now() + 8000
    let sawRunning = false
    while (Date.now() < deadline) {
      if (existsSync(join(dir, 'status')) && readFileSync(join(dir, 'status'), 'utf8').trim() === 'running') {
        sawRunning = true
        break
      }
      await new Promise((r) => setTimeout(r, 30))
    }
    expect(sawRunning).toBe(true)
    expect(runWrapper(dir, `status '${dir}'`).stdout.trim()).toBe('running')
  })
})
