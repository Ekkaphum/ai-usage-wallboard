import { describe, it, expect } from 'vitest'
import { normalizeModel, rateFor, costUsd, unpricedModels } from './pricing'

describe('normalizeModel', () => {
  it('passes through an exact id', () => {
    expect(normalizeModel('claude-opus-5')).toBe('claude-opus-5')
  })

  it('strips a date suffix', () => {
    expect(normalizeModel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5')
  })

  it('resolves a short alias', () => {
    expect(normalizeModel('opus')).toBe('claude-opus-5')
  })

  it('leaves an unknown model alone rather than inventing a match', () => {
    expect(normalizeModel('some-future-model')).toBe('some-future-model')
  })
})

describe('costUsd', () => {
  const zero = {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWrite5mTokens: 0, cacheWrite1hTokens: 0,
  }

  it('prices plain input and output at the published rates', () => {
    const rate = rateFor('claude-opus-5')!
    const cost = costUsd('claude-opus-5', { ...zero, inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(cost).toBeCloseTo(rate.input + rate.output, 6)
  })

  it('discounts cache reads to a tenth of the input rate', () => {
    const rate = rateFor('claude-opus-5')!
    expect(costUsd('claude-opus-5', { ...zero, cacheReadTokens: 1_000_000 })).toBeCloseTo(rate.input * 0.1, 6)
  })

  it('charges 1h cache writes more than 5m writes', () => {
    const short = costUsd('claude-opus-5', { ...zero, cacheWrite5mTokens: 1_000_000 })!
    const long = costUsd('claude-opus-5', { ...zero, cacheWrite1hTokens: 1_000_000 })!
    expect(long).toBeGreaterThan(short)
    expect(long / short).toBeCloseTo(2 / 1.25, 6)
  })

  it('returns null for a model with no published rate, never zero', () => {
    expect(costUsd('some-future-model', { ...zero, inputTokens: 1_000_000 })).toBeNull()
  })
})

describe('unpricedModels', () => {
  it('reports models we cannot price and ignores synthetic rows', () => {
    expect(unpricedModels(['claude-opus-5', 'mystery-model', '<synthetic>'])).toEqual(['mystery-model'])
  })
})
