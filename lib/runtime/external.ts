import type { Snapshot } from '@/lib/probe'
import type { AccountState } from '@/lib/domain/types'

/**
 * Merging of account states pushed in from another machine's collector.
 *
 * Kept separate from the store so the ageing rules can be tested without
 * standing up the singleton, its timers, and a database.
 */

export interface ExternalEntry {
  state: AccountState
  receivedAt: number
}

/** Past this, a pushed card is shown but no longer presented as current. */
export const EXTERNAL_STALE_MS = 5 * 60_000

/**
 * ...and only past *this* is it dropped from the board entirely.
 *
 * The two thresholds are far apart on purpose. A collector that dies is the
 * most likely failure of a two-machine setup, and a board that quietly shrinks
 * from three cards to zero looks identical to a quiet afternoon. Holding the
 * card and marking it stale keeps the failure visible.
 */
export const EXTERNAL_DROP_MS = 24 * 60 * 60_000

function age(entry: ExternalEntry, now: number): AccountState {
  const elapsed = now - entry.receivedAt
  if (elapsed <= EXTERNAL_STALE_MS) return entry.state

  const minutes = Math.round(elapsed / 60_000)
  const since = minutes >= 120 ? `${Math.round(minutes / 60)} ชั่วโมง` : `${minutes} นาที`
  return {
    ...entry.state,
    health: 'stale',
    message: `ไม่ได้รับข้อมูลจากเครื่องเก็บมา ${since} — ตัวเลขนี้ค้างอยู่`,
  }
}

/**
 * Folds pushed state over the locally probed set, dropping what has expired.
 * Mutates `external` only to evict; the snapshot is returned as a new value.
 */
export function mergeExternal(
  snapshot: Snapshot,
  external: Map<string, ExternalEntry>,
  now: number,
): Snapshot {
  for (const [id, entry] of external) {
    if (now - entry.receivedAt > EXTERNAL_DROP_MS) external.delete(id)
  }

  const byId = new Map(snapshot.accounts.map((a) => [a.accountId, a]))
  for (const entry of external.values()) byId.set(entry.state.accountId, age(entry, now))

  return { ...snapshot, accounts: [...byId.values()] }
}
