/**
 * Recovering Claude's 5-hour window boundaries from a percentage series.
 *
 * The desktop app records how full the window is but never when it resets, so
 * the boundary has to be inferred: within a block the percentage only rises, so
 * a block began in the gap between a sample at zero (or one much higher, meaning
 * the window rolled over and was immediately used again) and the sample after
 * it. The width of that gap is the app's sampling interval, which is why every
 * derived reset carries an uncertainty band rather than a single instant.
 */

export interface PercentPoint { t: number; percent: number }

export interface BlockBounds {
  startLower: number
  startUpper: number
}

/** A fall of at least this many points between samples means the window rolled. */
export const RESET_DROP_PERCENT = 20

/**
 * True when a block *started* between these two samples.
 *
 * Both cases require the later sample to be above zero: a fall to exactly zero
 * means the window emptied and nothing has been spent since, which is an idle
 * gap rather than a new block. Missing that distinction makes an idle account
 * look like it just started a fresh five hours.
 */
function isBoundary(prev: number, cur: number): boolean {
  if (cur <= 0) return false
  return prev === 0 || cur < prev - RESET_DROP_PERCENT
}

/** Bounds of the block running at the end of the series, or null if none is active. */
export function findCurrentBlock(points: PercentPoint[]): BlockBounds | null {
  if (points.length === 0) return null
  if (points[points.length - 1].percent <= 0) return null

  for (let i = points.length - 1; i > 0; i--) {
    if (isBoundary(points[i - 1].percent, points[i].percent)) {
      return { startLower: points[i - 1].t, startUpper: points[i].t }
    }
  }
  return null
}

/**
 * Bounds of the block active at every point, in one forward pass. Used to give
 * historical samples a reset time so the detail view can draw block boundaries.
 */
export function annotateBlocks(points: PercentPoint[]): (BlockBounds | null)[] {
  const out: (BlockBounds | null)[] = []
  let current: BlockBounds | null = null

  for (let i = 0; i < points.length; i++) {
    const cur = points[i].percent
    if (i > 0 && isBoundary(points[i - 1].percent, cur)) {
      current = { startLower: points[i - 1].t, startUpper: points[i].t }
    } else if (cur <= 0) {
      // Window is empty: no block is running, whatever came before.
      current = null
    }
    // Otherwise the block carries forward. A series that opens mid-block keeps
    // `current` null — its boundary is off the left edge and cannot be recovered.
    out.push(current)
  }
  return out
}

export const midpoint = (b: BlockBounds) => (b.startLower + b.startUpper) / 2
export const uncertaintyMs = (b: BlockBounds) => Math.round((b.startUpper - b.startLower) / 2)

export interface DerivedReset {
  at: number
  /** Half-width of the remaining ambiguity, in ms. Zero when the answer is exact. */
  uncertaintyMs: number
  exact: boolean
}

/**
 * Converts block bounds into the moment the window rolls over.
 *
 * Anthropic floors a session window to the top of the hour: every reset time
 * recovered from an actual 429 (`quotaLimits.resetsAt`) in these logs landed on
 * an exact hour. So instead of adding five hours to the midpoint of the sample
 * gap — which lands on an arbitrary minute and is wrong by up to half the
 * sampling interval — the start is floored to its hour first.
 *
 * When the gap sits inside one hour the answer is exact. When it straddles an
 * hour boundary there are two candidates; the one covering more of the gap is
 * the likelier, and the result says it is not exact.
 *
 * `notBefore` is the timestamp of an observation known to be inside the block —
 * usually the newest sample. A window cannot reset before it was seen in use,
 * so a candidate that fails that test is discarded outright.
 */
export function deriveReset(bounds: BlockBounds, notBefore?: number): DerivedReset {
  const lowerHour = floorToHour(bounds.startLower)
  const upperHour = floorToHour(bounds.startUpper)

  const viable = (hour: number) => notBefore == null || hour + FIVE_HOURS_MS > notBefore

  if (lowerHour === upperHour) {
    return { at: lowerHour + FIVE_HOURS_MS, uncertaintyMs: 0, exact: true }
  }

  // The true start is uniform across the gap, so weight by how much of the gap
  // falls either side of the boundary — then let the hard constraint override.
  const boundary = upperHour
  const preferred = bounds.startUpper - boundary >= boundary - bounds.startLower ? upperHour : lowerHour
  const fallback = preferred === upperHour ? lowerHour : upperHour

  if (viable(preferred)) {
    // Only one candidate survives the constraint, so there is nothing left to doubt.
    return { at: preferred + FIVE_HOURS_MS, uncertaintyMs: viable(fallback) ? 3_600_000 : 0, exact: !viable(fallback) }
  }
  return { at: fallback + FIVE_HOURS_MS, uncertaintyMs: 0, exact: true }
}

/**
 * Points consumed per hour over the trailing window. Returns null when the
 * lookback spans a rollover, because the slope across a reset is meaningless.
 */
export function percentPerHour(points: PercentPoint[], now: number, lookbackMs = 45 * 60 * 1000): number | null {
  const recent = points.filter((p) => now - p.t <= lookbackMs)
  if (recent.length < 2) return null
  const first = recent[0]
  const last = recent[recent.length - 1]
  const hours = (last.t - first.t) / 3_600_000
  if (hours <= 0) return null
  const delta = last.percent - first.percent
  if (delta < 0) return null
  return delta / hours
}

/* ------------------------------------------------------------------ */
/* Token-side blocks                                                   */
/* ------------------------------------------------------------------ */

export interface TokenPoint { t: number; tokens: number }

export interface TokenBlock {
  startedAt: number
  resetsAt: number
  tokens: number
  events: number
}

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000

/**
 * The 5-hour block that message activity puts us in right now.
 *
 * Anthropic's session window opens on the first message after a quiet period
 * and runs five hours from there, so blocks are reconstructed the same way:
 * walk forward, start a block on the first event that falls outside the open
 * one, and floor its start to the hour the way the published windows do.
 */
export function currentTokenBlock(points: TokenPoint[], now: number): TokenBlock | null {
  if (points.length === 0) return null
  const sorted = [...points].sort((a, b) => a.t - b.t)

  let block: TokenBlock | null = null
  for (const p of sorted) {
    if (block === null || p.t >= block.resetsAt) {
      const startedAt = floorToHour(p.t)
      block = { startedAt, resetsAt: startedAt + FIVE_HOURS_MS, tokens: 0, events: 0 }
    }
    block.tokens += p.tokens
    block.events += 1
  }

  if (block && now >= block.resetsAt) return null
  return block
}

/** All completed and current blocks, oldest first. Feeds budget calibration. */
export function allTokenBlocks(points: TokenPoint[]): TokenBlock[] {
  const sorted = [...points].sort((a, b) => a.t - b.t)
  const blocks: TokenBlock[] = []
  let block: TokenBlock | null = null

  for (const p of sorted) {
    if (block === null || p.t >= block.resetsAt) {
      const startedAt = floorToHour(p.t)
      block = { startedAt, resetsAt: startedAt + FIVE_HOURS_MS, tokens: 0, events: 0 }
      blocks.push(block)
    }
    block.tokens += p.tokens
    block.events += 1
  }
  return blocks
}

export function floorToHour(ms: number): number {
  return Math.floor(ms / 3_600_000) * 3_600_000
}

/** Tokens per hour over the trailing window, extrapolated to a full hour. */
export function tokensPerHour(points: TokenPoint[], now: number, lookbackMs = 30 * 60 * 1000): number | null {
  const recent = points.filter((p) => now - p.t <= lookbackMs && p.t <= now)
  if (recent.length === 0) return null
  const total = recent.reduce((sum, p) => sum + p.tokens, 0)
  return total * (3_600_000 / lookbackMs)
}
