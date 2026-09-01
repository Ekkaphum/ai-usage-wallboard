/** Shared HTTP plumbing for the remote adapters. */

const DEFAULT_TIMEOUT_MS = 10_000

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: string, url: string) {
    super(`${status} from ${new URL(url).host}${body ? `: ${body.slice(0, 200)}` : ''}`)
    this.name = 'ApiError'
  }
}

export async function getJson<T>(url: string, headers: Record<string, string>, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    cache: 'no-store',
  })
  if (!response.ok) {
    throw new ApiError(response.status, await response.text().catch(() => ''), url)
  }
  return response.json() as Promise<T>
}

/**
 * Remote adapters are polled far less often than local files: every call costs
 * money or quota, and none of these figures move by the second.
 */
export const REMOTE_CACHE_MS = 5 * 60_000

interface CacheEntry<T> { at: number; value: T }
const cache = new Map<string, CacheEntry<unknown>>()

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as CacheEntry<T> | undefined
  if (hit && Date.now() - hit.at < ttlMs) return hit.value
  const value = await load()
  cache.set(key, { at: Date.now(), value })
  return value
}

/** Reads a secret from the environment, naming the variable when it is missing. */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`ไม่ได้ตั้ง ${name} — ใส่ไว้ใน .env.local`)
  return value
}
