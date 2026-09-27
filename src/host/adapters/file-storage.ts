/**
 * File-backed KvDomain: same interface as the storage-domain handle, with a
 * per-table JSON file, a serialized write chain, and atomic tmp+rename
 * persistence. Used by contract tests (restart persistence) and as the
 * explicitly-flagged degraded backend when the host storage facility is
 * unavailable.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { KvDomain, KvTable, StoragePort } from './ports.ts'

interface TableFile<V> {
  records: Record<string, V>
}

class FileTable<V> implements KvTable<V> {
  constructor(
    private readonly path: string,
    private state: TableFile<V>,
    private readonly chain: <T>(task: () => Promise<T>) => Promise<T>,
    private readonly onWrite: () => void,
    private readonly onMissingKey: (key: string) => Error,
  ) {}

  get(key: string): V | undefined {
    return this.state.records[key]
  }
  entries(): IterableIterator<[string, V]> {
    return Object.entries(this.state.records)[Symbol.iterator]()
  }
  keys(): IterableIterator<string> {
    return Object.keys(this.state.records)[Symbol.iterator]()
  }
  get size(): number {
    return Object.keys(this.state.records).length
  }
  put(key: string, value: V): Promise<void> {
    return this.chain(async () => {
      this.state.records[key] = value
      this.flush()
      this.onWrite()
    })
  }
  delete(key: string): Promise<boolean> {
    return this.chain(async () => {
      const existed = key in this.state.records
      if (existed) {
        delete this.state.records[key]
        this.flush()
        this.onWrite()
      }
      return existed
    })
  }
  update(key: string, fn: (current: V) => V): Promise<V> {
    return this.chain(async () => {
      const current = this.state.records[key]
      if (current === undefined) throw this.onMissingKey(key)
      const next = fn(current)
      this.state.records[key] = next
      this.flush()
      this.onWrite()
      return next
    })
  }
  private flush(): void {
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify(this.state))
    renameSync(tmp, this.path)
  }
}

export class FileKvDomain implements KvDomain {
  private tables = new Map<string, KvTable<unknown>>()
  private chainTail: Promise<void> = Promise.resolve()
  closed = false

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chainTail.then(task, task)
    this.chainTail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  table<V = unknown>(name: string): KvTable<V> {
    if (this.closed) throw new Error('domain closed')
    let t = this.tables.get(name) as KvTable<V> | undefined
    if (!t) {
      const path = join(this.dir, `${name}.json`)
      let state: TableFile<V> = { records: {} }
      if (existsSync(path)) {
        try {
          state = JSON.parse(readFileSync(path, 'utf8')) as TableFile<V>
        } catch {
          state = { records: {} }
        }
      }
      t = new FileTable<V>(
        path,
        state,
        (task) => this.enqueue(task),
        () => undefined,
        (key) => new Error(`missing-key: ${key}`),
      ) as KvTable<V>
      this.tables.set(name, t as KvTable<unknown>)
    }
    return t as KvTable<V>
  }

  async close(): Promise<void> {
    await this.chainTail
    this.closed = true
  }

  /** Remove all data (test helper / uninstall). */
  destroy(): void {
    rmSync(this.dir, { recursive: true, force: true })
  }
}

export class FileStorage implements StoragePort {
  private readonly domains = new Map<string, FileKvDomain>()
  constructor(private readonly baseDir: string) {
    mkdirSync(dirname(baseDir), { recursive: true })
  }
  async openDomain(name: string): Promise<KvDomain> {
    const existing = this.domains.get(name)
    if (existing && !existing.closed) throw new Error(`already-open: ${name}`)
    const domain = new FileKvDomain(join(this.baseDir, name))
    this.domains.set(name, domain)
    return domain
  }
}
