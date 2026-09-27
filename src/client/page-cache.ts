/**
 * 页面级缓存（框架无关的模块级 Map）+ stale-while-revalidate 数据 hook。
 *
 * 背景：页面在 tab 切换时会被卸载重挂（见 app.tsx 的条件渲染与 persistedStack
 * 先例），组件内的 useState 全部丢失，导致每次切回都白屏等数据。这里把上次
 * 成功的数据存在模块级缓存里：挂载时同步以缓存作为初始 state（页面立即有内
 * 容，不闪空白），同时后台静默刷新——刷新中不遮蔽旧数据，失败时保留旧数据并
 * 给出一次性错误提示。
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** 缓存条目上限：超出后按写入先后淘汰最旧，避免长会话内存无限增长 */
const MAX_ENTRIES = 32

interface PageCacheEntry {
  data: unknown
  /** 写入时间（毫秒时间戳），供调用方按需展示新鲜度 */
  at: number
}

/** 模块级缓存：跨组件挂载存活（同一 bundle 生命周期内有效） */
const pageCache = new Map<string, PageCacheEntry>()

/**
 * 读取页面缓存；命中时会把该条目挪到 Map 末尾（按使用顺序淘汰，Map 迭代序
 * 即插入序），未命中返回 null。
 */
export function readPageCache<T>(key: string): { data: T; at: number } | null {
  const hit = pageCache.get(key)
  if (hit === undefined) return null
  pageCache.delete(key)
  pageCache.set(key, hit)
  return { data: hit.data as T, at: hit.at }
}

/** 写入页面缓存；先删后写保证该条目位于 Map 末尾（最“新”位置） */
export function writePageCache(key: string, data: unknown): void {
  pageCache.delete(key)
  pageCache.set(key, { data, at: Date.now() })
  while (pageCache.size > MAX_ENTRIES) {
    const oldest = pageCache.keys().next()
    if (oldest.done) break
    pageCache.delete(oldest.value)
  }
}

/** 清空页面缓存：不传 key 清全部（测试 / 强制全量重取时用） */
export function clearPageCache(key?: string): void {
  if (key === undefined) pageCache.clear()
  else pageCache.delete(key)
}

// ---------- React hook ----------

/**
 * fetcher 返回形状与 OpsClient.call 对齐，页面里直接传闭包：
 * `(opts: { force: boolean }) => client.call(endpoint, { ...payload, force: opts.force })`
 * `force` 的语义由 fetcher 决定（通常是让宿主同步重算，而不是读缓存）。
 */
export type PageFetchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: string; message: string } }

export interface CachedPage<T> {
  data: T | null
  /** 尚无可展示数据时的加载态：首拉中，或手动刷新进行中 */
  loading: boolean
  /** 最近一次拉取失败的错误文案（成功后清空；失败保留旧数据） */
  error: string | null
  /** 是否有拉取在途（含后台静默刷新），用于「后台刷新中」轻提示 */
  refreshing: boolean
  /** 当前渲染的数据是否来自页面缓存（拉到新数据后转 false） */
  fromCache: boolean
  /**
   * 手动刷新：置 loading 并立即发起请求；`refresh(true)` 表示用户手动触发的
   * 强制刷新，force 会透传给 fetcher。返回 Promise 便于调用方挂本地的
   * “进行中”状态（如刷新图标旋转）。
   */
  refresh: (force?: boolean) => Promise<void>
}

/**
 * 页面数据获取 hook（进入即显缓存 + 后台刷新）。
 * @param key       页面缓存键，如 `processes:${serverId}`
 * @param fetcher   拉取函数（闭包携带 client 与路由参数）
 * @param opts.intervalMs 可选轮询间隔；>0 时挂载后按固定间隔后台刷新
 *                        （页签不可见时暂停，上一轮在途时跳过，避免 SSH 轮询堆叠）
 */
export function useCachedPageData<T>(
  key: string,
  fetcher: (opts: { force: boolean }) => Promise<PageFetchResult<T>>,
  opts?: { intervalMs?: number },
): CachedPage<T> {
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const intervalMs = opts?.intervalMs ?? 0

  // 挂载即同步读缓存作为初始 state：页面立刻有内容，不闪空白
  const [data, setData] = useState<T | null>(() => readPageCache<T>(key)?.data ?? null)
  const [loading, setLoading] = useState<boolean>(() => !pageCache.has(key))
  const [error, setError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [fromCache, setFromCache] = useState<boolean>(() => pageCache.has(key))

  // 乱序防护：仅最新一次请求可写 state（同 model.ts patch 注释的精神）；
  // 换 key / 卸载 / 手动刷新都会使更早的在途请求过期。
  const seqRef = useRef(0)
  // 在途计数：轮询 tick 时若上一轮尚未返回则跳过，避免 SSH 拉取堆叠
  const inFlightRef = useRef(0)

  const run = useCallback((force: boolean, manual: boolean): Promise<void> => {
    const seq = ++seqRef.current
    inFlightRef.current++
    if (manual) setLoading(true)
    setRefreshing(true)
    return fetcherRef.current({ force }).then(
      (res) => {
        inFlightRef.current--
        if (seqRef.current !== seq) return // 已有更新的请求，过期响应直接丢弃
        setRefreshing(false)
        setLoading(false)
        if (res.ok) {
          writePageCache(key, res.value)
          setData(res.value)
          setFromCache(false)
          setError(null)
        } else {
          // 失败保留旧数据（若有），只给一次性错误提示
          setError(`${res.error.code}: ${res.error.message}`)
        }
      },
      (e: unknown) => {
        inFlightRef.current--
        if (seqRef.current !== seq) return
        setRefreshing(false)
        setLoading(false)
        setError(e instanceof Error ? e.message : String(e))
      },
    )
  }, [key])

  // 挂载（或 key 变化，如同一页面实例换 serverId）：用新 key 的缓存重置并后台拉取
  useEffect(() => {
    const hit = readPageCache<T>(key)
    setData(hit ? hit.data : null)
    setLoading(!hit)
    setFromCache(hit !== null)
    setError(null)
    setRefreshing(false)
    seqRef.current++ // 作废上一个 key 的在途请求
    void run(false, false)
    let timer: ReturnType<typeof setInterval> | null = null
    if (intervalMs > 0) {
      timer = setInterval(() => {
        // 页签不可见时暂停轮询（与 usePoll 行为一致）
        const doc = (globalThis as { document?: { hidden?: boolean } }).document
        if (doc?.hidden) return
        if (inFlightRef.current > 0) return // 上一轮在途，跳过避免堆叠
        void run(false, false)
      }, intervalMs)
    }
    return () => {
      if (timer !== null) clearInterval(timer)
      seqRef.current++ // 卸载 / 换 key：作废仍未返回的请求，防止过期写入
    }
  }, [key, intervalMs, run])

  const refresh = useCallback((force = false): Promise<void> => run(force, true), [run])

  return { data, loading, error, refreshing, fromCache, refresh }
}
