/**
 * Log tail/statistics pure functions (IMPROVE §4.6) + hardware history
 * downsampling (§4.2/§5.3).
 */
import { describe, expect, it } from 'vitest'
import { classifyLine, statSource, buildTail, buildLogTailView } from '../../src/host/logs/log-tail.ts'
import { downsampleHardware } from '../../src/host/api/devops-api.ts'
import type { LogFragment, LogSource } from '../../src/contracts/entities.ts'
import { SCHEMA_VERSION } from '../../src/contracts/entities.ts'

const NOW = 1_700_000_000_000

function fragment(over: Partial<LogFragment>): LogFragment {
  return {
    schemaVersion: SCHEMA_VERSION, fragmentId: 'f1', sourceId: 's1', runId: null,
    startOffset: 0, endOffset: 10, content: 'hello', collectedAt: NOW,
    analysisState: 'complete', analysisError: null, readTruncated: false, gapBeforeBytes: 0,
    ...over,
  }
}

function source(over: Partial<LogSource>): LogSource {
  return {
    schemaVersion: SCHEMA_VERSION, sourceId: 's1', projectId: 'p1', serverId: 'srv1',
    service: 'web', configOrigin: 'test', path: '/srv/logs/web.log', fileIdentity: null,
    status: 'active', statusReason: '', fingerprint: '', discoveredAt: NOW,
    readCursor: 0, generation: 0, truncatedAtDiscovery: false, userDefined: false,
    ignored: false, sizeBytes: null, lastModifiedAt: null,
    ...over,
  }
}

describe('log level classification (IMPROVE §4.6)', () => {
  it('recognizes conventional level keywords', () => {
    expect(classifyLine('2026-09-19 12:00:00 ERROR connection refused')).toBe('error')
    expect(classifyLine('FATAL: db unreachable')).toBe('error')
    expect(classifyLine('WARN retrying')).toBe('warn')
    expect(classifyLine('request handled 200 OK')).toBeNull()
    // case-sensitive: lowercase words are not levels
    expect(classifyLine('an error occurred while warming up')).toBeNull()
  })
})

describe('statSource (IMPROVE §4.6)', () => {
  it('counts levels over the recent window and reports lines/minute', () => {
    const fragments = [
      fragment({ content: 'ERROR a\nWARN b\ninfo c\ndone d\n', collectedAt: NOW - 60_000 }),
      fragment({ content: 'ERROR e\n', collectedAt: NOW - 30_000 }),
      fragment({ content: 'old beyond window\n', collectedAt: NOW - 3 * 3_600_000 }),
    ]
    const stat = statSource(fragments, NOW)
    expect(stat.levelCount.error).toBe(2)
    expect(stat.levelCount.warn).toBe(1)
    expect(stat.levelCount.info).toBe(2) // non-matching lines count as info/other
    expect(stat.linesPerMinute).not.toBeNull()
  })

  it('reports null rates when nothing was read (honest empty state)', () => {
    expect(statSource([], NOW).linesPerMinute).toBeNull()
  })
})

describe('buildTail (IMPROVE §4.6)', () => {
  it('assembles newest-last tail with level tags, bounded by limitLines', () => {
    const fragments = [
      fragment({ fragmentId: 'old', content: 'line-1\nline-2\n', collectedAt: NOW - 10_000 }),
      fragment({ fragmentId: 'new', content: 'ERROR now\nfine\n', collectedAt: NOW }),
    ]
    const tail = buildTail(fragments, 10)
    expect(tail.map((t) => t.line)).toEqual(['line-1', 'line-2', 'ERROR now', 'fine'])
    expect(tail[2]!.level).toBe('error')
    const bounded = buildTail(fragments, 2)
    expect(bounded.map((t) => t.line)).toEqual(['ERROR now', 'fine']) // newest fragment wins
  })
})

describe('buildLogTailView (IMPROVE §4.6)', () => {
  it('aggregates per-source stats and a merged tail', () => {
    const sources = [source({ sourceId: 's1' }), source({ sourceId: 's2', service: 'worker' })]
    const map = new Map([
      ['s1', [fragment({ content: 'ERROR x\n', collectedAt: NOW - 5000 })]],
      ['s2', [fragment({ content: 'ok\n', collectedAt: NOW })]],
    ])
    const view = buildLogTailView(sources, map, NOW, 50)
    expect(view.stats).toHaveLength(2)
    expect(view.stats[0]!.levelCount.error).toBe(1)
    expect(view.tail).toHaveLength(2)
    expect(view.tail.at(-1)!.line).toBe('ok') // newest fragment last
  })
})

describe('downsampleHardware (IMPROVE §4.2)', () => {
  it('keeps small histories untouched', () => {
    const samples = [{ collectedAt: 1 }, { collectedAt: 2 }]
    expect(downsampleHardware(samples, 300)).toHaveLength(2)
  })

  it('reduces large histories to ≤ maxPoints and stays time-ordered', () => {
    const samples = Array.from({ length: 1000 }, (_, i) => ({ collectedAt: i * 1000, v: i }))
    const out = downsampleHardware(samples, 100) as Array<{ collectedAt: number; v: number }>
    expect(out.length).toBeLessThanOrEqual(100)
    // bucket 0 spans t=0..9000 (bucketMs=9991); last-wins → 9000 represents it
    expect(out[0]!.collectedAt).toBe(9000)
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.collectedAt).toBeGreaterThan(out[i - 1]!.collectedAt)
    }
    // bucket keeps the LAST value of the bucket (most recent wins)
    expect(out.at(-1)!.v).toBe(999)
  })
})

describe('candidatesFromProcessCommands (IMPROVE 二轮 R3)', () => {
  it('extracts redirect and flag log targets, deduped and device-free', async () => {
    const { candidatesFromProcessCommands } = await import('../../src/host/logs/discovery.ts')
    const cmds = [
      'nohup java -jar app.jar >> /srv/app/logs/out.log 2>&1 &',
      'gunicorn app:app --error-logfile /srv/app/logs/gunicorn-error.log --access-logfile /srv/app/logs/gunicorn-access.log',
      'node server.js > /srv/app/nohup.out 2>/dev/null',
      'nginx: master process nginx -g daemon on;',
    ]
    const paths = candidatesFromProcessCommands(cmds)
    expect(paths).toContain('/srv/app/logs/out.log')
    expect(paths).toContain('/srv/app/logs/gunicorn-error.log')
    expect(paths).toContain('/srv/app/logs/gunicorn-access.log')
    expect(paths.some((p) => p.startsWith('/dev/'))).toBe(false)
    // nohup.out is not a .log path → not matched
    expect(paths).not.toContain('/srv/app/nohup.out')
    expect(new Set(paths).size).toBe(paths.length)
  })
})
