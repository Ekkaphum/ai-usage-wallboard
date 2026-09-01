import type { ProviderAdapter } from './types'
import type { AccountConfig } from '@/lib/config'
import { type AccountState, WEEK_MS, emptyBurn, makeWindow, unconfigured } from '@/lib/domain/types'
import { getJson, cached, requireEnv, REMOTE_CACHE_MS } from './http'

/**
 * OpenAI's organisation usage and cost endpoints. Like the Anthropic admin
 * adapter this covers platform API traffic, not a ChatGPT plan — the Codex
 * adapter remains the source for subscription limits.
 *
 * Needs an Admin key, and both endpoints take epoch seconds, not ISO dates.
 */

const DEFAULT_BASE = 'https://api.openai.com/v1/organization'

interface UsageBucket {
  start_time: number
  results: { input_tokens?: number; output_tokens?: number; model?: string }[]
}

interface CostBucket {
  start_time: number
  results: { amount?: { value?: number; currency?: string } }[]
}

const sumTokens = (buckets: UsageBucket[]): number =>
  buckets.reduce((total, b) => total + b.results.reduce((s, r) =>
    s + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0), 0)

const sumCost = (buckets: CostBucket[]): number =>
  buckets.reduce((total, b) => total + b.results.reduce((s, r) => s + (r.amount?.value ?? 0), 0), 0)

function modelSplit(buckets: UsageBucket[]) {
  const byModel = new Map<string, number>()
  for (const bucket of buckets) {
    for (const r of bucket.results) {
      const tokens = (r.input_tokens ?? 0) + (r.output_tokens ?? 0)
      if (tokens === 0) continue
      const model = r.model ?? 'unknown'
      byModel.set(model, (byModel.get(model) ?? 0) + tokens)
    }
  }
  return [...byModel.entries()]
    .map(([model, tokens]) => ({ model, tokens, costUsd: null }))
    .sort((a, b) => b.tokens - a.tokens)
}

export const openaiAdmin: ProviderAdapter = {
  id: 'openai-admin',

  async probe(cfg: AccountConfig): Promise<AccountState[]> {
    const envName = cfg.apiKeyEnv ?? 'OPENAI_ADMIN_KEY'
    let key: string
    try {
      key = requireEnv(envName)
    } catch (error) {
      return [unconfigured(cfg.id, cfg.displayName, 'openai', 'api', (error as Error).message)]
    }

    const headers = { Authorization: `Bearer ${key}` }
    const BASE = cfg.baseUrl ? `${cfg.baseUrl}/v1/organization` : DEFAULT_BASE
    const now = Math.floor(Date.now() / 1000)
    const weekAgo = now - Math.floor(WEEK_MS / 1000)
    const dayAgo = now - 24 * 3600
    const scope = cfg.scopeId ? `&project_ids=${encodeURIComponent(cfg.scopeId)}` : ''

    const [usage, weekCost, dayCost] = await cached(`openai-admin:${cfg.id}`, REMOTE_CACHE_MS, async () => Promise.all([
      getJson<{ data: UsageBucket[] }>(
        `${BASE}/usage/completions?start_time=${weekAgo}&bucket_width=1d&group_by=model&limit=7${scope}`, headers),
      getJson<{ data: CostBucket[] }>(`${BASE}/costs?start_time=${weekAgo}&limit=7${scope}`, headers),
      getJson<{ data: CostBucket[] }>(`${BASE}/costs?start_time=${dayAgo}&limit=2${scope}`, headers),
    ]))

    const buckets = usage.data ?? []

    return [{
      accountId: cfg.id,
      configId: cfg.id,
      provider: 'openai',
      surface: 'api',
      displayName: cfg.displayName,
      planType: 'org',
      windows: [makeWindow({
        key: 'weekly',
        label: 'Weekly',
        windowMinutes: 10080,
        usedTokens: sumTokens(buckets),
        confidence: 'reported',
        note: 'จาก Organization Usage API — เป็น API traffic ไม่ใช่โควตา ChatGPT',
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
