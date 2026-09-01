import { describe, it, expect } from 'vitest'
import {
  findCurrentBlock, annotateBlocks, percentPerHour,
  currentTokenBlock, allTokenBlocks, tokensPerHour, floorToHour, deriveReset,
  type PercentPoint, type TokenPoint,
} from './blocks'

const MIN = 60_000
const HOUR = 3_600_000

/** Builds an evenly-spaced series, matching the app's ~15-minute cadence. */
function series(start: number, percents: number[], stepMs = 15 * MIN): PercentPoint[] {
  return percents.map((percent, i) => ({ t: start + i * stepMs, percent }))
}

describe('findCurrentBlock', () => {
  const T0 = Date.parse('2026-09-01T00:00:00Z')

  it('returns null when the window is empty', () => {
    expect(findCurrentBlock(series(T0, [0, 0, 0]))).toBeNull()
  })

  it('returns null for an empty series', () => {
    expect(findCurrentBlock([])).toBeNull()
  })

  it('bounds the start to the gap where usage resumed from zero', () => {
    const points = series(T0, [0, 0, 12, 30, 44])
    const block = findCurrentBlock(points)
    expect(block).toEqual({ startLower: points[1].t, startUpper: points[2].t })
  })

  it('detects a rollover that was immediately used again', () => {
    // 95% then 3% means the window reset and new usage landed in the same gap.
    const points = series(T0, [40, 70, 95, 3, 11])
    const block = findCurrentBlock(points)
    expect(block).toEqual({ startLower: points[2].t, startUpper: points[3].t })
  })

  it('ignores small dips that are not rollovers', () => {
    const points = series(T0, [0, 20, 38, 36, 51])
    const block = findCurrentBlock(points)
    expect(block).toEqual({ startLower: points[0].t, startUpper: points[1].t })
  })

  it('returns null when the series never shows a boundary', () => {
    // Always in use, no visible start — better to admit ignorance than guess.
    expect(findCurrentBlock(series(T0, [30, 44, 61, 80]))).toBeNull()
  })

  it('picks the most recent boundary, not the first', () => {
    const points = series(T0, [0, 40, 88, 0, 0, 9, 22])
    const block = findCurrentBlock(points)
    expect(block).toEqual({ startLower: points[4].t, startUpper: points[5].t })
  })
})

describe('annotateBlocks', () => {
  const T0 = Date.parse('2026-09-01T00:00:00Z')

  it('marks idle samples as having no active block', () => {
    const points = series(T0, [0, 0, 15, 40, 0])
    const marks = annotateBlocks(points)
    expect(marks[0]).toBeNull()
    expect(marks[1]).toBeNull()
    expect(marks[2]).toEqual({ startLower: points[1].t, startUpper: points[2].t })
    expect(marks[3]).toEqual({ startLower: points[1].t, startUpper: points[2].t })
    expect(marks[4]).toBeNull()
  })

  it('agrees with findCurrentBlock on the final sample', () => {
    const points = series(T0, [0, 12, 55, 91, 0, 0, 7])
    const marks = annotateBlocks(points)
    expect(marks[marks.length - 1]).toEqual(findCurrentBlock(points))
  })
})

describe('percentPerHour', () => {
  const T0 = Date.parse('2026-09-01T00:00:00Z')

  it('measures the slope across the lookback', () => {
    const points = series(T0, [10, 20, 30], 30 * MIN)
    const now = points[2].t
    expect(percentPerHour(points, now, 2 * HOUR)).toBeCloseTo(20, 5)
  })

  it('refuses to report a slope that spans a rollover', () => {
    const points = series(T0, [90, 95, 4], 15 * MIN)
    expect(percentPerHour(points, points[2].t, 2 * HOUR)).toBeNull()
  })

  it('needs at least two points inside the lookback', () => {
    const points = series(T0, [10, 20], 2 * HOUR)
    expect(percentPerHour(points, points[1].t, 30 * MIN)).toBeNull()
  })
})

describe('currentTokenBlock', () => {
  const T0 = Date.parse('2026-09-01T02:20:00Z')

  const evt = (offsetMs: number, tokens: number): TokenPoint => ({ t: T0 + offsetMs, tokens })

  it('floors the block start to the hour', () => {
    const block = currentTokenBlock([evt(0, 100)], T0 + MIN)
    expect(block?.startedAt).toBe(floorToHour(T0))
    expect(block?.resetsAt).toBe(floorToHour(T0) + 5 * HOUR)
  })

  it('sums every event inside the block', () => {
    const block = currentTokenBlock([evt(0, 100), evt(HOUR, 250), evt(2 * HOUR, 50)], T0 + 2 * HOUR + MIN)
    expect(block?.tokens).toBe(400)
    expect(block?.events).toBe(3)
  })

  it('starts a fresh block once the previous one has rolled', () => {
    const block = currentTokenBlock([evt(0, 100), evt(6 * HOUR, 70)], T0 + 6 * HOUR + MIN)
    expect(block?.tokens).toBe(70)
  })

  it('returns null when the newest block has already expired', () => {
    expect(currentTokenBlock([evt(0, 100)], T0 + 9 * HOUR)).toBeNull()
  })

  it('is order independent', () => {
    const forward = currentTokenBlock([evt(0, 10), evt(HOUR, 20)], T0 + HOUR + MIN)
    const shuffled = currentTokenBlock([evt(HOUR, 20), evt(0, 10)], T0 + HOUR + MIN)
    expect(shuffled).toEqual(forward)
  })

  it('returns null with no events', () => {
    expect(currentTokenBlock([], T0)).toBeNull()
  })
})

describe('allTokenBlocks', () => {
  const T0 = Date.parse('2026-09-01T00:00:00Z')

  it('splits a long history into non-overlapping five-hour blocks', () => {
    const points: TokenPoint[] = [
      { t: T0, tokens: 10 },
      { t: T0 + 4 * HOUR, tokens: 20 },
      { t: T0 + 5 * HOUR, tokens: 30 },
      { t: T0 + 12 * HOUR, tokens: 40 },
    ]
    const blocks = allTokenBlocks(points)
    expect(blocks).toHaveLength(3)
    expect(blocks.map((b) => b.tokens)).toEqual([30, 30, 40])
    for (let i = 1; i < blocks.length; i++) {
      expect(blocks[i].startedAt).toBeGreaterThanOrEqual(blocks[i - 1].resetsAt)
    }
  })
})

describe('tokensPerHour', () => {
  const T0 = Date.parse('2026-09-01T00:00:00Z')

  it('extrapolates the trailing window to a full hour', () => {
    const now = T0 + HOUR
    const points: TokenPoint[] = [
      { t: now - 40 * MIN, tokens: 1000 }, // outside a 30-minute lookback
      { t: now - 20 * MIN, tokens: 500 },
      { t: now - 10 * MIN, tokens: 500 },
    ]
    expect(tokensPerHour(points, now, 30 * MIN)).toBe(2000)
  })

  it('ignores events in the future', () => {
    const now = T0 + HOUR
    const points: TokenPoint[] = [{ t: now + 10 * MIN, tokens: 999 }]
    expect(tokensPerHour(points, now, 30 * MIN)).toBeNull()
  })
})

describe('deriveReset', () => {
  const at = (iso: string) => Date.parse(iso)

  it('is exact when the block start sits inside one hour', () => {
    // Ground truth from a real 429: a block starting between 06:02 and 06:17
    // reset at exactly 11:00, not at midpoint + 5h (11:09).
    const reset = deriveReset({
      startLower: at('2026-09-01T06:02:24+07:00'),
      startUpper: at('2026-09-01T06:17:24+07:00'),
    })
    expect(reset.exact).toBe(true)
    expect(reset.uncertaintyMs).toBe(0)
    expect(new Date(reset.at).toISOString()).toBe(new Date(at('2026-09-01T11:00:00+07:00')).toISOString())
  })

  it('lands on the hour, never on an arbitrary minute', () => {
    const reset = deriveReset({
      startLower: at('2026-09-01T09:41:00Z'),
      startUpper: at('2026-09-01T09:56:00Z'),
    })
    expect(new Date(reset.at).getUTCMinutes()).toBe(0)
    expect(new Date(reset.at).getUTCSeconds()).toBe(0)
  })

  it('picks the hour holding more of the gap when the gap straddles a boundary', () => {
    // 11 of the 15 minutes fall after 10:00, so 10:00 is the likelier start.
    const reset = deriveReset({
      startLower: at('2026-09-01T09:56:00Z'),
      startUpper: at('2026-09-01T10:11:00Z'),
    })
    expect(reset.exact).toBe(false)
    expect(new Date(reset.at).toISOString()).toBe(new Date(at('2026-09-01T15:00:00Z')).toISOString())
  })

  it('picks the earlier hour when most of the gap is before the boundary', () => {
    const reset = deriveReset({
      startLower: at('2026-09-01T09:48:00Z'),
      startUpper: at('2026-09-01T10:03:00Z'),
    })
    expect(new Date(reset.at).toISOString()).toBe(new Date(at('2026-09-01T14:00:00Z')).toISOString())
  })

  it('admits an hour of doubt when it had to choose', () => {
    const reset = deriveReset({
      startLower: at('2026-09-01T09:56:00Z'),
      startUpper: at('2026-09-01T10:11:00Z'),
    })
    expect(reset.uncertaintyMs).toBe(3_600_000)
  })
})

describe('deriveReset with a known in-block observation', () => {
  const at = (iso: string) => Date.parse(iso)

  it('rejects a candidate that would have reset before the block was observed', () => {
    // Gap straddles 01:00. Share alone prefers 00:00 → reset 05:00, but the
    // window was still in use at 05:30, so 00:00 is impossible.
    const bounds = {
      startLower: at('2026-08-31T00:52:00Z'),
      startUpper: at('2026-08-31T01:07:00Z'),
    }
    expect(new Date(deriveReset(bounds).at).toISOString())
      .toBe(new Date(at('2026-08-31T05:00:00Z')).toISOString())

    const constrained = deriveReset(bounds, at('2026-08-31T05:30:00Z'))
    expect(new Date(constrained.at).toISOString())
      .toBe(new Date(at('2026-08-31T06:00:00Z')).toISOString())
    expect(constrained.exact).toBe(true)
  })

  it('reports no doubt when the constraint eliminates the other candidate', () => {
    const constrained = deriveReset(
      { startLower: at('2026-09-01T09:56:00Z'), startUpper: at('2026-09-01T10:11:00Z') },
      at('2026-09-01T14:30:00Z'),
    )
    expect(constrained.uncertaintyMs).toBe(0)
    expect(constrained.exact).toBe(true)
  })

  it('keeps the doubt when both candidates remain possible', () => {
    const constrained = deriveReset(
      { startLower: at('2026-09-01T09:56:00Z'), startUpper: at('2026-09-01T10:11:00Z') },
      at('2026-09-01T10:20:00Z'),
    )
    expect(constrained.uncertaintyMs).toBe(3_600_000)
    expect(constrained.exact).toBe(false)
  })
})
