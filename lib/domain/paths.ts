import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** Expands a leading `~` and resolves to an absolute path. */
export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2))
  return resolve(p)
}

export const DEFAULT_CLAUDE_APP_DATA = '~/Library/Application Support/Claude'
export const DEFAULT_CLAUDE_CONFIG_DIR = '~/.claude'
export const DEFAULT_CODEX_HOME = '~/.codex'
