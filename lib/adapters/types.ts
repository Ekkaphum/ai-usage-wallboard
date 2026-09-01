import type { AccountState } from '@/lib/domain/types'
import type { AccountConfig } from '@/lib/config'

export interface ProviderAdapter {
  id: string
  /**
   * One config entry can yield several accounts — Claude's usage file is keyed
   * by org UUID and may hold more than one — so this always returns an array.
   */
  probe(cfg: AccountConfig): Promise<AccountState[]>
}

/** Thrown when a source file exists but its schema is not one we understand. */
export class UnknownSchemaError extends Error {
  constructor(source: string, found: unknown) {
    super(`${source}: unrecognised schema version ${JSON.stringify(found)}. Refusing to guess — the adapter needs updating.`)
    this.name = 'UnknownSchemaError'
  }
}
