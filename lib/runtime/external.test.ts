import { describe, it, expect } from 'vitest'
import { mergeExternal, EXTERNAL_STALE_MS, EXTERNAL_DROP_MS, type ExternalEntry } from './external'
import { unconfigured, emptyBurn } from '@/lib/domain/types'
import type { AccountState } from '@/lib/domain/types'
import type { Snapshot } from '@/lib/probe'

const NOW = Date.parse('2026-09-01T12:00:00Z')

function pushed(id: string): AccountState {
  return {
    accountId: id,
    configId: id,
    provider: 'anthropic',
    surface: 'claude-desktop',
    displayName: id,
    identity: null,
    planType: 'claude_pro',
    windows: [],
    burn: emptyBurn(),
    spend: { todayUsd: null, weekUsd: null },
    lastSampleAt: new Date(NOW).toISOString(),
    health: 'ok',
    message: null,
  }
}

function snapshot(accounts: AccountState[]): Snapshot {
  return { generatedAt: new Date(NOW).toISOString(), accounts, problems: [] }
}

function entries(...items: [string, number][]): Map<string, ExternalEntry> {
  return new Map(items.map(([id, receivedAt]) => [id, { state: pushed(id), receivedAt }]))
}

describe('mergeExternal', () => {
  it('adds pushed accounts to a board that probes nothing locally', () => {
    const result = mergeExternal(snapshot([]), entries(['a', NOW]), NOW)
    expect(result.accounts.map((a) => a.accountId)).toEqual(['a'])
    expect(result.accounts[0].health).toBe('ok')
  })

  it('lets a pushed account win over a local one with the same id', () => {
    const local = unconfigured('a', 'local', 'anthropic', 'claude-desktop', 'no file')
    const result = mergeExternal(snapshot([local]), entries(['a', NOW]), NOW)
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0].health).toBe('ok')
  })

  it('keeps a fresh push current', () => {
    const result = mergeExternal(snapshot([]), entries(['a', NOW - EXTERNAL_STALE_MS]), NOW)
    expect(result.accounts[0].health).toBe('ok')
    expect(result.accounts[0].message).toBeNull()
  })

  // The failure this whole module exists for: a dead collector must look like a
  // dead collector, not like an account that was never configured.
  it('marks a card stale rather than dropping it when pushes stop', () => {
    const result = mergeExternal(snapshot([]), entries(['a', NOW - 20 * 60_000]), NOW)
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0].health).toBe('stale')
    expect(result.accounts[0].message).toContain('20 นาที')
  })

  it('switches to hours once minutes stop being readable', () => {
    const result = mergeExternal(snapshot([]), entries(['a', NOW - 3 * 3_600_000]), NOW)
    expect(result.accounts[0].message).toContain('3 ชั่วโมง')
  })

  it('drops a push only after a full day, and evicts it from the map', () => {
    const external = entries(['a', NOW - EXTERNAL_DROP_MS - 1])
    const result = mergeExternal(snapshot([]), external, NOW)
    expect(result.accounts).toHaveLength(0)
    expect(external.size).toBe(0)
  })

  it('leaves the original state object untouched when ageing it', () => {
    const external = entries(['a', NOW - 20 * 60_000])
    mergeExternal(snapshot([]), external, NOW)
    expect(external.get('a')!.state.health).toBe('ok')
  })
})
