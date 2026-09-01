import type { ProviderAdapter } from './types'
import type { AccountConfig } from '@/lib/config'
import { type AccountState, WEEK_MS, emptyBurn, makeWindow, unconfigured } from '@/lib/domain/types'
import { getJson, cached, requireEnv, REMOTE_CACHE_MS } from './http'

/**
 * Anthropic's Usage and Cost Admin API — the only *official* source of Claude
 * numbers, but it covers organisation API traffic, not a personal Pro/Max
 * subscription. It is what makes the dollar figures on this board authoritative
 * for an org account rather than computed from a local price table.
 *
 * Needs an Admin key (`sk-ant-admin…`), which is separate from a normal API key.
 */

const DEFAULT_BASE = 'https://api.anthropic.com/v1/organizations'
const VERSION = '2023-06-01'

interface UsageBucket {
  starting_at: string
  ending_at: string
  results: {
    uncached_input_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    output_tokens?: number
    model?: string
  }[]
}

interface CostBucket {
  starting_at: string
  results: { amount?: string | number; currency?: string; description?: string }[]
}

const sumTokens = (buckets: UsageBucket[]): number =>
  buckets.reduce((total, bucket) => total + bucket.results.reduce((sub, r) =>
    sub + (r.uncached_input_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0)
      + (r.cache_read_input_tokens ?? 0) + (r.output_tokens ?? 0), 0), 0)

const sumCost = (buckets: CostBucket[]): number =>
  buckets.reduce((total, bucket) => total + bucket.results.reduce((sub, r) =>
    sub + (typeof r.amount === 'string' ? Number.parseFloat(r.amount) : r.amount ?? 0), 0), 0)

function modelSplit(buckets: UsageBucket[]) {
  const byModel = new Map<string, number>()
  for (const bucket of buckets) {
    for (const r of bucket.results) {
      const tokens = (r.uncached_input_tokens ?? 0) + (r.cache_creation_input_tokens ?? 0)
        + (r.cache_read_input_tokens ?? 0) + (r.output_tokens ?? 0)
      if (tokens === 0) continue
      const model = r.model ?? 'unknown'
      byModel.set(model, (byModel.get(model) ?? 0) + tokens)
    }
  }
  return [...byModel.entries()]
    .map(([model, tokens]) => ({ model, tokens, costUsd: null }))
    .sort((a, b) => b.tokens - a.tokens)
}

export const anthropicAdmin: ProviderAdapter = {
  id: 'anthropic-admin',

  async probe(cfg: AccountConfig): Promise<AccountState[]> {
    const envName = cfg.apiKeyEnv ?? 'ANTHROPIC_ADMIN_KEY'
    let key: string
    try {
      key = requireEnv(envName)
    } catch (error) {
      return [unconfigured(cfg.id, cfg.displayName, 'anthropic', 'api', (error as Error).message, cfg.expectedEmail)]
    }

    const headers = { 'x-api-key': key, 'anthropic-version': VERSION }
    const BASE = cfg.baseUrl ? `${cfg.baseUrl}/v1/organizations` : DEFAULT_BASE
    const now = Date.now()
    const weekAgo = new Date(now - WEEK_MS).toISOString()
    const dayAgo = new Date(now - 24 * 3_600_000).toISOString()

    const [usage, weekCost, dayCost] = await cached(`anthropic-admin:${cfg.id}`, REMOTE_CACHE_MS, async () => Promise.all([
      getJson<{ data: UsageBucket[] }>(
        `${BASE}/usage_report/messages?starting_at=${encodeURIComponent(weekAgo)}&bucket_width=1d&limit=31`, headers),
      getJson<{ data: CostBucket[] }>(
        `${BASE}/cost_report?starting_at=${encodeURIComponent(weekAgo)}&limit=31`, headers),
      getJson<{ data: CostBucket[] }>(
        `${BASE}/cost_report?starting_at=${encodeURIComponent(dayAgo)}&limit=2`, headers),
    ]))

    const buckets = usage.data ?? []
    const weekTokens = sumTokens(buckets)

    return [{
      accountId: cfg.id,
      configId: cfg.id,
      provider: 'anthropic',
      surface: 'api',
      displayName: cfg.displayName,
      // Admin keys carry no user identity; naming the variable that supplied
      // the key is what distinguishes two org cards from each other.
      identity: {
        email: null,
        name: `key: ${envName}`,
        organizationName: cfg.scopeId ?? null,
        accountUuid: null,
        organizationUuid: null,
        verified: true,
      },
      planType: 'org',
      windows: [makeWindow({
        key: 'weekly',
        label: 'Weekly',
        windowMinutes: 10080,
        usedTokens: weekTokens,
        confidence: 'reported',
        note: 'จาก Usage Admin API — เป็น API traffic ขององค์กร ไม่ใช่โควตา subscription',
      })],
      burn: emptyBurn(),
      spend: { todayUsd: sumCost(dayCost.data ?? []), weekUsd: sumCost(weekCost.data ?? []) },
      breakdown: modelSplit(buckets),
      lastSampleAt: new Date().toISOString(),
      health: 'ok',
      message: null,
    }]
  },
}
