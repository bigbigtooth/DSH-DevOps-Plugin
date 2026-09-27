/**
 * In-memory KvDomain with the same semantics as dsh-storage-domain:
 * durable-first write chain (here: synchronous), atomic update(), close().
 * Used by tests and as a degraded fallback backend.
 */
import type { KvDomain, KvTable, StoragePort } from './ports.ts'

class MemoryTable<V> implements KvTable<V> {
  private map = new Map<string, V>()
  private listeners = new Set<() => void>()
  constructor(private readonly onWrite: () => void) {}
  get(key: string): V | undefined {
    return this.map.get(key)
  }
  entries(): IterableIterator<[string, V]> {
    return this.map.entries()
  }
  keys(): IterableIterator<string> {
    return this.map.keys()
  }
  get size(): number {
    return this.map.size
  }
  async put(key: string, value: V): Promise<void> {
    this.map.set(key, value)
    this.onWrite()
    this.notify()
  }
  async delete(key: string): Promise<boolean> {
    const existed = this.map.delete(key)
    if (existed) {
      this.onWrite()
      this.notify()
    }
    return existed
  }
  async update(key: string, fn: (current: V) => V): Promise<V> {
    // atomic read-modify-write on the domain write chain: the constructor
    // serializes all writes through the domain-level queue.
    const current = this.map.get(key)
    if (current === undefined) throw new Error(`missing-key: ${key}`)
    const next = fn(current)
    this.map.set(key, next)
    this.onWrite()
    this.notify()
    return next
  }
  /** Test/inspection helper mirroring event fanout. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private notify(): void {
    for (const fn of this.listeners) fn()
  }
  /** Simulate a backend write failure after which memory must stay untouched. */
  static failNextWrite = false
}

export class MemoryDomain implements KvDomain {
  private tables = new Map<string, MemoryTable<unknown>>()
  private chain: Promise<void> = Promise.resolve()
  closed = false
  /** serialized write chain — every write queues behind the previous one */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  table<V = unknown>(name: string): KvTable<V> {
    if (this.closed) throw new Error('domain closed')
    let t = this.tables.get(name) as MemoryTable<V> | undefined
    if (!t) {
      const self = this
      t = new MemoryTable<V>(() => {
        self.changeCount++
      })
      // wrap writes through the domain chain to serialize them
      const wrapped = t as MemoryTable<V>
      const origPut = wrapped.put.bind(wrapped)
      const origUpdate = wrapped.update.bind(wrapped)
      const origDelete = wrapped.delete.bind(wrapped)
      wrapped.put = (k, v) => this.enqueue(() => origPut(k, v))
      wrapped.update = (k, fn) => this.enqueue(() => origUpdate(k, fn))
      wrapped.delete = (k) => this.enqueue(() => origDelete(k))
      this.tables.set(name, t as MemoryTable<unknown>)
    }
    return t
  }

  changeCount = 0

  async close(): Promise<void> {
    if (this.closed) return
    // drain queued writes, then reject new ones
    await this.chain
    this.closed = true
  }

  /** Snapshot all tables (for backup tests). */
  dump(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {}
    for (const [name, table] of this.tables) {
      out[name] = Object.fromEntries(table.entries())
    }
    return out
  }
}

export class MemoryStorage implements StoragePort {
  readonly domains = new Map<string, MemoryDomain>()
  async openDomain(name: string): Promise<KvDomain> {
    const existing = this.domains.get(name)
    if (existing && !existing.closed) throw new Error(`already-open: ${name}`)
    const domain = new MemoryDomain()
    this.domains.set(name, domain)
    return domain
  }
}
