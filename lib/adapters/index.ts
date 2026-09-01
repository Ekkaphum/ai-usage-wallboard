import type { ProviderAdapter } from './types'
import { claudeDesktopPlanUsage } from './claude-desktop-plan-usage'
import { codexLocal } from './codex-local'
import { claudeCodeLocal } from './claude-code-local'
import { openrouter } from './openrouter'
import { anthropicAdmin } from './anthropic-admin'
import { openaiAdmin } from './openai-admin'

/**
 * Adapter registry. Adding a provider means adding one file here and one entry
 * in config/accounts.json — nothing in the core has to change.
 */
export const adapters: Record<string, ProviderAdapter> = {
  [claudeDesktopPlanUsage.id]: claudeDesktopPlanUsage,
  [codexLocal.id]: codexLocal,
  [claudeCodeLocal.id]: claudeCodeLocal,
  [openrouter.id]: openrouter,
  [anthropicAdmin.id]: anthropicAdmin,
  [openaiAdmin.id]: openaiAdmin,
}

export function getAdapter(id: string): ProviderAdapter | null {
  return adapters[id] ?? null
}

export * from './types'
