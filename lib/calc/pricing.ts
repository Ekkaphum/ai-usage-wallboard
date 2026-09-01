import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Token pricing. Rates live in config/pricing.json because they change on
 * Anthropic's schedule, not ours — nothing here should ever be hardcoded.
 *
 * Cache tokens are priced as multiples of the model's input rate: reads are
 * heavily discounted, writes carry a premium that depends on the TTL. The
 * Claude Code logs report 5-minute and 1-hour cache writes separately, so both
 * are priced correctly rather than averaged.
 */

export interface ModelRate { input: number; output: number }

interface PricingFile {
  multipliers: { cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }
  aliases: Record<string, string>
  models: Record<string, ModelRate>
}

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
}

const PRICING_PATH = resolve(process.cwd(), 'config/pricing.json')

let cache: PricingFile | null = null

function load(): PricingFile {
  if (cache) return cache
  if (!existsSync(PRICING_PATH)) throw new Error(`Missing ${PRICING_PATH}`)
  cache = JSON.parse(readFileSync(PRICING_PATH, 'utf8')) as PricingFile
  return cache
}

/** Strips date suffixes and resolves short aliases: `claude-haiku-4-5-20251001` → `claude-haiku-4-5`. */
export function normalizeModel(model: string): string {
  const pricing = load()
  if (pricing.models[model]) return model
  const aliased = pricing.aliases[model]
  if (aliased) return aliased
  const undated = model.replace(/-\d{8}$/, '')
  if (pricing.models[undated]) return undated
  return model
}

export function rateFor(model: string): ModelRate | null {
  const pricing = load()
  return pricing.models[normalizeModel(model)] ?? null
}

/** Returns null for models with no published rate — an unpriced row must not read as free. */
export function costUsd(model: string, t: TokenCounts): number | null {
  const pricing = load()
  const rate = rateFor(model)
  if (!rate) return null
  const m = pricing.multipliers
  const perToken = rate.input / 1_000_000
  return (
    t.inputTokens * perToken +
    t.outputTokens * (rate.output / 1_000_000) +
    t.cacheReadTokens * perToken * m.cacheRead +
    t.cacheWrite5mTokens * perToken * m.cacheWrite5m +
    t.cacheWrite1hTokens * perToken * m.cacheWrite1h
  )
}

/** Models seen in logs that we cannot price — surfaced so the gap is visible, not silent. */
export function unpricedModels(models: Iterable<string>): string[] {
  const missing = new Set<string>()
  for (const m of models) {
    if (m === '<synthetic>') continue
    if (!rateFor(m)) missing.add(m)
  }
  return [...missing].sort()
}
