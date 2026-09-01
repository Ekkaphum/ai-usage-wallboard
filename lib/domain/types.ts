/**
 * Core domain model. Every provider is normalized down to these shapes so the
 * UI never has to know which adapter produced a number.
 */

/**
 * How much a number can be trusted. This is deliberately part of the domain and
 * not a UI detail: a wallboard that mixes reported and guessed values without
 * saying which is which is worse than no wallboard.
 */
export type Confidence =
  /** The provider told us this value directly. */
  | 'reported'
  /** Computed from a complete local log we fully control. */
  | 'derived'
  /** Inferred against a budget we calibrated ourselves. */
  | 'estimated'
  /** Not enough data to produce a percentage yet — show raw counters instead. */
  | 'unknown'

export type WindowKey = 'five_hour' | 'weekly' | 'daily' | 'monthly' | 'credit'

export type Health = 'ok' | 'stale' | 'error' | 'unconfigured'

export interface LimitWindow {
  key: WindowKey
  label: string
  /** Nominal length of the window in minutes. 0 for balances that never roll. */
  windowMinutes: number
  usedPercent: number | null
  usedTokens: number | null
  budgetTokens: number | null
  /** ISO8601. null when the provider does not expose a reset and we cannot derive one. */
  resetsAt: string | null
  /** Trust level of `usedPercent` / `usedTokens`. */
  confidence: Confidence
  /**
   * Trust level of `resetsAt`. Often lower than `confidence` — Claude reports an
   * exact percentage but no reset time, so the countdown has to be derived.
   */
  resetConfidence: Confidence
  /** Half-width of the uncertainty band on `resetsAt`, in ms. */
  resetUncertaintyMs: number | null
  /** When this window was last observed at 100%. */
  hitAt: string | null
  /** Free-form note shown under the window in the detail view. */
  note: string | null
}

export interface BurnRate {
  tokensPerHour: number | null
  percentPerHour: number | null
  /** ISO8601 — when the primary window is projected to hit 100%, if before its reset. */
  projectedExhaustAt: string | null
}

export interface ModelBreakdownEntry {
  model: string
  tokens: number
  costUsd: number | null
}

export interface AccountState {
  /** Stable identity. Prefer a provider-issued id (Claude's org UUID) over config order. */
  accountId: string
  /** The config entry this came from, so settings can round-trip. */
  configId: string
  provider: 'anthropic' | 'openai' | 'openrouter' | 'google' | 'github' | 'custom'
  surface: 'claude-desktop' | 'claude-code' | 'codex-cli' | 'api' | 'web'
  displayName: string
  planType: string | null
  windows: LimitWindow[]
  burn: BurnRate
  spend: { todayUsd: number | null; weekUsd: number | null }
  /** Per-model token and cost split. Only sources with per-message logs can fill this. */
  breakdown?: ModelBreakdownEntry[]
  /** ISO8601 of the newest underlying sample, not of our poll. */
  lastSampleAt: string | null
  health: Health
  /** Present whenever health is 'error' or 'unconfigured'. Must be actionable. */
  message: string | null
}

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** Age past which a sample stops being treated as live. */
export const STALE_AFTER_MS = 30 * 60 * 1000

export function emptyBurn(): BurnRate {
  return { tokensPerHour: null, percentPerHour: null, projectedExhaustAt: null }
}

export function makeWindow(w: Partial<LimitWindow> & Pick<LimitWindow, 'key' | 'label' | 'windowMinutes' | 'confidence'>): LimitWindow {
  return {
    usedPercent: null,
    usedTokens: null,
    budgetTokens: null,
    resetsAt: null,
    resetConfidence: 'unknown',
    resetUncertaintyMs: null,
    hitAt: null,
    note: null,
    ...w,
  }
}

/** Builds the state shown when an adapter cannot read its source at all. */
export function unconfigured(configId: string, displayName: string, provider: AccountState['provider'], surface: AccountState['surface'], message: string): AccountState {
  return {
    accountId: configId,
    configId,
    provider,
    surface,
    displayName,
    planType: null,
    windows: [],
    burn: emptyBurn(),
    spend: { todayUsd: null, weekUsd: null },
    lastSampleAt: null,
    health: 'unconfigured',
    message,
  }
}
