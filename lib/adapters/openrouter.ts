import type { ProviderAdapter } from './types'
import type { AccountConfig } from '@/lib/config'
import { type AccountState, emptyBurn, makeWindow, unconfigured } from '@/lib/domain/types'
import { getJson, cached, requireEnv, REMOTE_CACHE_MS } from './http'

/**
 * OpenRouter reports the key's own spend and limit directly, so this is the
 * cheapest reliable remote source we have — one request, no admin credentials.
 *
 *   GET /api/v1/key → { data: { usage, limit, limit_remaining, is_free_tier } }
 */

interface KeyResponse {
  data: {
    label?: string
    usage: number
    limit: number | null
    limit_remaining?: number | null
    is_free_tier?: boolean
    rate_limit?: { requests: number; interval: string }
  }
}

export const openrouter: ProviderAdapter = {
  id: 'openrouter',

  async probe(cfg: AccountConfig): Promise<AccountState[]> {
    const envName = cfg.apiKeyEnv ?? 'OPENROUTER_API_KEY'
    let key: string
    try {
      key = requireEnv(envName)
    } catch (error) {
      return [unconfigured(cfg.id, cfg.displayName, 'openrouter', 'api', (error as Error).message)]
    }

    const data = (await cached(`openrouter:${cfg.id}`, REMOTE_CACHE_MS, () =>
      getJson<KeyResponse>(`${cfg.baseUrl ?? 'https://openrouter.ai'}/api/v1/key`, { Authorization: `Bearer ${key}` }),
    )).data

    const windows = []
    if (data.limit != null && data.limit > 0) {
      windows.push(makeWindow({
        key: 'credit',
        label: 'Credit',
        windowMinutes: 0,
        usedPercent: Math.min(100, (data.usage / data.limit) * 100),
        confidence: 'reported',
        note: `ใช้ไป $${data.usage.toFixed(2)} จาก $${data.limit.toFixed(2)}`,
      }))
    } else {
      // An unlimited key still has spend worth watching, just no denominator.
      windows.push(makeWindow({
        key: 'credit',
        label: 'Credit',
        windowMinutes: 0,
        confidence: 'reported',
        note: `ใช้ไป $${data.usage.toFixed(2)} · ไม่มีเพดาน`,
      }))
    }

    return [{
      accountId: cfg.id,
      configId: cfg.id,
      provider: 'openrouter',
      surface: 'api',
      displayName: cfg.displayName,
      planType: data.is_free_tier ? 'free' : 'paid',
      windows,
      burn: emptyBurn(),
      spend: { todayUsd: null, weekUsd: null },
      lastSampleAt: new Date().toISOString(),
      health: 'ok',
      message: data.limit_remaining != null ? `เหลือ $${data.limit_remaining.toFixed(2)}` : null,
    }]
  },
}
