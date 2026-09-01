import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { probeAll, type Snapshot } from '@/lib/probe'
import { recordSnapshot } from '@/lib/db/record'
import { recentHistory, type History } from '@/lib/history'
import { loadConfig, CONFIG_PATH } from '@/lib/config'
import { expandHome, DEFAULT_CLAUDE_APP_DATA, DEFAULT_CODEX_HOME, DEFAULT_CLAUDE_CONFIG_DIR } from '@/lib/domain/paths'
import type { AccountState } from '@/lib/domain/types'
import { evaluate } from '@/lib/alerts'
import { mergeExternal, type ExternalEntry } from '@/lib/runtime/external'

/**
 * The single in-process source of truth the board reads from.
 *
 * Probing is centralised here rather than done per request so that ten browsers
 * on ten screens cost exactly as much as one, and so a slow adapter delays a
 * refresh rather than a page load.
 */

export interface BoardPayload {
  generatedAt: string
  accounts: AccountState[]
  problems: string[]
  history: History
  /** Accounts pushed in from other machines, merged over the locally probed set. */
  externalCount: number
}

/** Full re-probe cadence when nothing has changed on disk. */
const POLL_INTERVAL_MS = 60_000
/** Files are written in bursts; wait for quiet before re-probing. */
const WATCH_DEBOUNCE_MS = 2_000

interface StoreState {
  emitter: EventEmitter
  current: BoardPayload | null
  started: boolean
  refreshing: Promise<BoardPayload> | null
  timer: NodeJS.Timeout | null
  debounce: NodeJS.Timeout | null
  external: Map<string, ExternalEntry>
}

/**
 * The store lives on globalThis rather than in module scope.
 *
 * Next gives the instrumentation hook, route handlers, and server components
 * separate module registries, so plain module-level state produces *several*
 * independent stores: the one that polls is not the one the event stream reads
 * from, and the board silently serves whatever snapshot its own copy happened
 * to take first. Pinning to a global symbol keeps exactly one.
 */
const STORE_KEY = Symbol.for('ai-usage-wallboard.store')

function initialState(): StoreState {
  const emitter = new EventEmitter()
  emitter.setMaxListeners(0)
  return { emitter, current: null, started: false, refreshing: null, timer: null, debounce: null, external: new Map() }
}

const registry = globalThis as unknown as Record<symbol, StoreState | undefined>
const state: StoreState = (registry[STORE_KEY] ??= initialState())
const { emitter, external } = state

function build(snapshot: Snapshot): BoardPayload {
  return {
    generatedAt: snapshot.generatedAt,
    accounts: snapshot.accounts,
    problems: snapshot.problems,
    history: recentHistory(),
    externalCount: external.size,
  }
}

export async function refresh(): Promise<BoardPayload> {
  // Collapse concurrent callers onto one probe; adapters touch the same files.
  if (state.refreshing) return state.refreshing

  state.refreshing = (async () => {
    // Merge before recording: on a display-only machine every account arrives
    // over the wire, and a snapshot that dropped them would leave the history
    // table — and so every sparkline on the board — permanently empty.
    const snapshot = mergeExternal(await probeAll(), external, Date.now())
    try {
      recordSnapshot(snapshot)
    } catch (error) {
      // A write failure must not blank the board — serve the numbers anyway.
      console.error('[store] failed to record snapshot:', error)
    }
    state.current = build(snapshot)
    emitter.emit('update', state.current)

    // Alerting is deliberately after the broadcast: the board updating must
    // never wait on a webhook, and a failing channel must not blank a screen.
    void evaluate(state.current).catch((error) => console.error('[store] alert evaluation failed:', error))

    return state.current
  })()

  try {
    return await state.refreshing
  } finally {
    state.refreshing = null
  }
}

/**
 * Also ensures the scheduler is running. Instrumentation normally starts it,
 * but a request must never be the thing that discovers it never started.
 */
export async function getPayload(): Promise<BoardPayload> {
  if (!state.started) void start()
  return state.current ?? refresh()
}

export function peek(): BoardPayload | null {
  return state.current
}

export function subscribe(listener: (payload: BoardPayload) => void): () => void {
  emitter.on('update', listener)
  return () => emitter.off('update', listener)
}

/** Accepts a state pushed from another machine's collector. */
export function ingest(state: AccountState): void {
  external.set(state.accountId, { state, receivedAt: Date.now() })
  void refresh()
}

function scheduleRefresh() {
  if (state.debounce) clearTimeout(state.debounce)
  state.debounce = setTimeout(() => { void refresh() }, WATCH_DEBOUNCE_MS)
}

/** Directories whose changes should trigger an immediate re-probe. */
function watchTargets(): string[] {
  const cfg = loadConfig()
  const dirs = new Set<string>()
  for (const account of cfg.accounts) {
    if (!account.enabled) continue
    if (account.adapter === 'claude-desktop-plan-usage') {
      dirs.add(join(expandHome(account.appDataDir ?? DEFAULT_CLAUDE_APP_DATA), 'plan-usage-history.json'))
    } else if (account.adapter === 'codex-local') {
      dirs.add(join(expandHome(account.codexHome ?? DEFAULT_CODEX_HOME), 'sessions'))
    } else if (account.adapter === 'claude-code-local') {
      dirs.add(join(expandHome(account.claudeConfigDir ?? DEFAULT_CLAUDE_CONFIG_DIR), 'projects'))
    }
  }
  if (existsSync(CONFIG_PATH)) dirs.add(CONFIG_PATH)
  return [...dirs].filter((p) => existsSync(p))
}

export async function start(): Promise<void> {
  if (state.started) return
  state.started = true

  state.timer = setInterval(() => { void refresh() }, POLL_INTERVAL_MS)

  await refresh().catch((error) => console.error('[store] initial probe failed:', error))

  try {
    const { watch } = await import('chokidar')
    const targets = watchTargets()
    if (targets.length === 0) return

    const watcher = watch(targets, {
      ignoreInitial: true,
      // These logs are appended to constantly; polling the whole tree would be
      // wasteful, and we only need to know that *something* changed.
      depth: 4,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    })
    watcher.on('all', scheduleRefresh)
    watcher.on('error', (error) => console.error('[store] watcher error:', error))
    console.log(`[store] watching ${targets.length} path(s); polling every ${POLL_INTERVAL_MS / 1000}s`)
  } catch (error) {
    console.error('[store] file watching unavailable, falling back to polling only:', error)
  }
}

export function stop(): void {
  if (state.timer) clearInterval(state.timer)
  state.timer = null
  state.started = false
}
