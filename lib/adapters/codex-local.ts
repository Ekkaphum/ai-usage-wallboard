import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ProviderAdapter } from './types'
import type { AccountConfig } from '@/lib/config'
import { expandHome, DEFAULT_CODEX_HOME } from '@/lib/domain/paths'
import {
  type AccountState, type LimitWindow, STALE_AFTER_MS,
  emptyBurn, makeWindow, unconfigured,
} from '@/lib/domain/types'
import { findLastLine } from './jsonl'

/**
 * Reads the rate-limit snapshot Codex attaches to every `token_count` event in
 * its session rollout logs. Unlike Claude, these percentages *and* their reset
 * times come straight from the server, so this adapter needs no inference.
 *
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *   { timestamp, type: "event_msg", payload: {
 *       type: "token_count",
 *       info: { total_token_usage: {...}, model_context_window },
 *       rate_limits: { primary: { used_percent, window_minutes, resets_at },
 *                      secondary: {...}, credits: {...}, plan_type } } }
 */

const WindowSchema = z.object({
  used_percent: z.number(),
  window_minutes: z.number().optional(),
  /** Epoch seconds. Some builds send a relative countdown instead. */
  resets_at: z.number().optional(),
  resets_in_seconds: z.number().optional(),
})

const RateLimitsSchema = z.object({
  primary: WindowSchema.nullish(),
  secondary: WindowSchema.nullish(),
  credits: z.object({
    has_credits: z.boolean().optional(),
    unlimited: z.boolean().optional(),
    balance: z.union([z.string(), z.number()]).optional(),
  }).nullish(),
  plan_type: z.string().nullish(),
  rate_limit_reached_type: z.string().nullish(),
})

const TokenUsageSchema = z.object({
  input_tokens: z.number().optional(),
  cached_input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  reasoning_output_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
})

const TokenCountSchema = z.object({
  timestamp: z.string(),
  payload: z.object({
    type: z.literal('token_count'),
    info: z.object({
      total_token_usage: TokenUsageSchema.nullish(),
      model_context_window: z.number().nullish(),
    }).nullish(),
    rate_limits: RateLimitsSchema.nullish(),
  }),
})

export type TokenCountEvent = z.infer<typeof TokenCountSchema>

function isTokenCount(v: unknown): v is TokenCountEvent {
  return TokenCountSchema.safeParse(v).success
}

/** Only look at sessions touched recently; older logs cannot hold current limits. */
const RECENT_FILE_WINDOW_MS = 48 * 60 * 60 * 1000
const MAX_FILES_SCANNED = 12

export function findRolloutFiles(sessionsDir: string, now: number): string[] {
  if (!existsSync(sessionsDir)) return []
  const entries = readdirSync(sessionsDir, { recursive: true, encoding: 'utf8' })
  const candidates: { path: string; mtimeMs: number }[] = []

  for (const rel of entries) {
    const name = rel.split('/').pop() ?? ''
    if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue
    const path = join(sessionsDir, rel)
    let mtimeMs: number
    try {
      const st = statSync(path)
      if (!st.isFile()) continue
      mtimeMs = st.mtimeMs
    } catch {
      continue
    }
    if (now - mtimeMs > RECENT_FILE_WINDOW_MS) continue
    candidates.push({ path, mtimeMs })
  }

  return candidates
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, MAX_FILES_SCANNED)
    .map((c) => c.path)
}

function resolveResetsAt(w: z.infer<typeof WindowSchema>, sampleMs: number): string | null {
  if (w.resets_at != null) return new Date(w.resets_at * 1000).toISOString()
  if (w.resets_in_seconds != null) return new Date(sampleMs + w.resets_in_seconds * 1000).toISOString()
  return null
}

function toWindow(
  key: 'five_hour' | 'weekly',
  label: string,
  w: z.infer<typeof WindowSchema>,
  fallbackMinutes: number,
  sampleMs: number,
): LimitWindow {
  const win = makeWindow({
    key,
    label,
    windowMinutes: w.window_minutes ?? fallbackMinutes,
    usedPercent: w.used_percent,
    confidence: 'reported',
  })
  win.resetsAt = resolveResetsAt(w, sampleMs)
  win.resetConfidence = win.resetsAt ? 'reported' : 'unknown'
  if (w.used_percent >= 100) win.hitAt = new Date(sampleMs).toISOString()
  return win
}

export const codexLocal: ProviderAdapter = {
  id: 'codex-local',

  async probe(cfg: AccountConfig): Promise<AccountState[]> {
    const home = expandHome(cfg.codexHome ?? DEFAULT_CODEX_HOME)
    const sessionsDir = join(home, 'sessions')
    const now = Date.now()

    if (!existsSync(sessionsDir)) {
      return [unconfigured(
        cfg.id, cfg.displayName, 'openai', 'codex-cli',
        `No sessions directory at ${sessionsDir}. Run codex once with CODEX_HOME set to ${home}.`,
      )]
    }

    const files = findRolloutFiles(sessionsDir, now)
    if (files.length === 0) {
      return [unconfigured(
        cfg.id, cfg.displayName, 'openai', 'codex-cli',
        `No codex session logs touched in the last 48h under ${sessionsDir}.`,
      )]
    }

    // Sessions can run concurrently, so take the newest event across all of
    // them rather than trusting the most recently written file.
    let newest: TokenCountEvent | null = null
    let newestMs = -Infinity
    for (const file of files) {
      const event = findLastLine(file, isTokenCount)
      if (!event) continue
      const ms = Date.parse(event.timestamp)
      if (Number.isNaN(ms) || ms <= newestMs) continue
      newest = event
      newestMs = ms
    }

    if (!newest || !newest.payload.rate_limits) {
      return [unconfigured(
        cfg.id, cfg.displayName, 'openai', 'codex-cli',
        `Found ${files.length} session log(s) under ${sessionsDir} but none carried a rate_limits snapshot yet.`,
      )]
    }

    const rl = newest.payload.rate_limits
    const windows: LimitWindow[] = []
    if (rl.primary) windows.push(toWindow('five_hour', '5-hour session', rl.primary, 300, newestMs))
    if (rl.secondary) windows.push(toWindow('weekly', 'Weekly', rl.secondary, 10080, newestMs))

    if (rl.credits?.has_credits && !rl.credits.unlimited) {
      const balance = Number(rl.credits.balance ?? 0)
      windows.push(makeWindow({
        key: 'credit',
        label: 'Credits',
        windowMinutes: 0,
        usedTokens: null,
        confidence: 'reported',
        note: `Balance ${Number.isFinite(balance) ? balance : rl.credits.balance}`,
      }))
    }

    const age = now - newestMs
    const usage = newest.payload.info?.total_token_usage

    return [{
      accountId: cfg.id,
      configId: cfg.id,
      provider: 'openai',
      surface: 'codex-cli',
      displayName: cfg.displayName,
      planType: rl.plan_type ?? null,
      windows,
      burn: emptyBurn(),
      spend: { todayUsd: null, weekUsd: null },
      lastSampleAt: new Date(newestMs).toISOString(),
      health: age > STALE_AFTER_MS ? 'stale' : 'ok',
      message: age > STALE_AFTER_MS
        ? `Last snapshot ${Math.round(age / 60000)} min ago — codex only records limits while a session is active, so the percentage may lag.`
        : usage?.total_tokens
          ? `Newest session used ${usage.total_tokens.toLocaleString()} tokens.`
          : null,
    }]
  },
}
