import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { DEFAULT_CLAUDE_APP_DATA, DEFAULT_CLAUDE_CONFIG_DIR, DEFAULT_CODEX_HOME } from '@/lib/domain/paths'

const AccountConfigSchema = z.object({
  id: z.string().min(1),
  adapter: z.string().min(1),
  displayName: z.string().min(1),
  enabled: z.boolean().default(true),

  /** claude-desktop-plan-usage: the Electron profile directory. */
  appDataDir: z.string().optional(),
  /** claude-code-local: CLAUDE_CONFIG_DIR for this account. */
  claudeConfigDir: z.string().optional(),
  /** codex-local: CODEX_HOME for this account. */
  codexHome: z.string().optional(),
  /**
   * Environment variable holding this account's API key. The key itself is
   * never written to the config file, so the config stays safe to share.
   */
  apiKeyEnv: z.string().optional(),
  /**
   * Override the provider's API host — for a gateway, a proxy, or a test
   * double. Leave unset to use the provider's own endpoint.
   */
  baseUrl: z.string().url().optional(),
  /** Anthropic/OpenAI admin reports: which workspace or project to scope to. */
  scopeId: z.string().optional(),
  /** Restrict a Claude profile to one org UUID when its file holds several. */
  org: z.string().optional(),
  /**
   * Fold this account's cost and model breakdown into another account's card
   * instead of showing it separately — Claude Code usage belongs to the same
   * subscription the desktop app reports on.
   */
  attachTo: z.string().optional(),
  /** Manual override for a window budget, in tokens. */
  budgetTokens: z.record(z.string(), z.number()).optional(),
})

export type AccountConfig = z.infer<typeof AccountConfigSchema>

const ConfigSchema = z.object({
  accounts: z.array(AccountConfigSchema),
})

export type AppConfig = z.infer<typeof ConfigSchema>

export const CONFIG_PATH = resolve(process.cwd(), 'config/accounts.json')

const FALLBACK: AppConfig = {
  accounts: [
    { id: 'claude-primary', adapter: 'claude-desktop-plan-usage', displayName: 'Claude', enabled: true, appDataDir: DEFAULT_CLAUDE_APP_DATA },
    { id: 'codex-main', adapter: 'codex-local', displayName: 'Codex', enabled: true, codexHome: DEFAULT_CODEX_HOME },
    { id: 'claude-code', adapter: 'claude-code-local', displayName: 'Claude Code', enabled: false, claudeConfigDir: DEFAULT_CLAUDE_CONFIG_DIR },
  ],
}

export function loadConfig(path = CONFIG_PATH): AppConfig {
  if (!existsSync(path)) return FALLBACK
  const parsed = ConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.success) {
    throw new Error(`Invalid ${path}:\n${z.prettifyError(parsed.error)}`)
  }
  return parsed.data
}

/**
 * Two accounts pointed at the same directory would silently double-count and
 * render as duplicate cards, so this is a hard error rather than a warning.
 */
export function validateConfig(cfg: AppConfig): string[] {
  const problems: string[] = []
  const seenIds = new Set<string>()
  const seenPaths = new Map<string, string>()

  for (const a of cfg.accounts) {
    if (seenIds.has(a.id)) problems.push(`Duplicate account id "${a.id}".`)
    seenIds.add(a.id)

    const dir = a.appDataDir ?? a.claudeConfigDir ?? a.codexHome
    if (!dir) continue
    const key = `${a.adapter}:${dir}`
    const owner = seenPaths.get(key)
    if (owner) {
      problems.push(`Accounts "${owner}" and "${a.id}" both read ${dir} — they cannot be told apart. Give the second account its own directory.`)
    }
    seenPaths.set(key, a.id)
  }
  return problems
}
