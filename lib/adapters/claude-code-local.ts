import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { join, basename } from 'node:path'
import { and, eq, gte, sql } from 'drizzle-orm'
import type { ProviderAdapter } from './types'
import type { AccountConfig } from '@/lib/config'
import { expandHome, DEFAULT_CLAUDE_CONFIG_DIR } from '@/lib/domain/paths'
import {
  type AccountState, type LimitWindow, WEEK_MS,
  emptyBurn, makeWindow, unconfigured,
} from '@/lib/domain/types'
import { getDb, schema } from '@/lib/db/client'
import { currentTokenBlock, tokensPerHour, type TokenPoint } from '@/lib/calc/blocks'
import { costUsd, normalizeModel, unpricedModels } from '@/lib/calc/pricing'
import { budgetForFiveHour } from '@/lib/calc/calibrate'
import { claudeIdentityDirectory } from '@/lib/identity'

/**
 * Reads the per-message token accounting Claude Code writes to
 * `<CLAUDE_CONFIG_DIR>/projects/**\/*.jsonl`.
 *
 * This is deliberately *not* the source of Claude's percentages — the desktop
 * app's plan-usage file reports those directly. What only lives here is the
 * detail that file lacks: tokens split by model and project, dollar cost, and
 * the exact moments a request was actually rejected for hitting a limit.
 *
 * These logs cover Claude Code sessions only (from the CLI and from inside the
 * desktop app). Ordinary chat in the app or on the web leaves no trace here.
 */

interface ParsedEvent {
  ts: number
  requestId: string
  messageId: string
  model: string | null
  sessionId: string | null
  project: string | null
  isSidechain: boolean
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  thinkingTokens: number
}

interface ParsedLimitHit {
  ts: number
  windowKey: string
  resetsAt: number | null
}

interface ScanResult {
  events: ParsedEvent[]
  limitHits: ParsedLimitHit[]
  filesScanned: number
  bytesRead: number
  parseErrors: number
  linesSeen: number
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

type LineResult =
  /** The line was not valid JSON — the only thing that counts as a parse error. */
  | { kind: 'malformed' }
  /**
   * Valid JSON, but not a usage record. These logs interleave plenty of session
   * metadata (`last-prompt`, `mode`, `custom-title`, file-history snapshots) and
   * counting those as failures would put a healthy account into an error state.
   */
  | { kind: 'ignored' }
  | { kind: 'parsed'; event?: ParsedEvent; limitHit?: ParsedLimitHit }

function parseLine(line: string, project: string | null): LineResult {
  let record: Record<string, unknown>
  try {
    record = JSON.parse(line) as Record<string, unknown>
  } catch {
    return { kind: 'malformed' }
  }
  if (typeof record !== 'object' || record === null) return { kind: 'malformed' }

  const out: { event?: ParsedEvent; limitHit?: ParsedLimitHit } = {}
  const ts = Date.parse(String(record.timestamp ?? ''))
  if (Number.isNaN(ts)) return { kind: 'ignored' }

  // A rejected request records the window that was exhausted and, unlike
  // anything else we can read, the exact epoch it resets — ground truth.
  const quota = record.quotaLimits as Record<string, unknown> | undefined
  if (record.error === 'rate_limit' && quota?.rateLimitType) {
    out.limitHit = {
      ts,
      windowKey: String(quota.rateLimitType),
      resetsAt: typeof quota.resetsAt === 'number' ? quota.resetsAt * 1000 : null,
    }
  }

  if (record.type !== 'assistant') {
    return out.limitHit ? { kind: 'parsed', ...out } : { kind: 'ignored' }
  }

  const message = record.message as Record<string, unknown> | undefined
  const usage = message?.usage as Record<string, unknown> | undefined
  const requestId = record.requestId
  const messageId = message?.id
  if (!usage || typeof requestId !== 'string' || typeof messageId !== 'string') {
    return out.limitHit ? { kind: 'parsed', ...out } : { kind: 'ignored' }
  }

  const model = typeof message?.model === 'string' ? message.model : null
  if (model === '<synthetic>') {
    return out.limitHit ? { kind: 'parsed', ...out } : { kind: 'ignored' }
  }

  const cacheCreation = usage.cache_creation as Record<string, unknown> | undefined
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined

  const cacheWrite5m = num(cacheCreation?.ephemeral_5m_input_tokens)
  const cacheWrite1h = num(cacheCreation?.ephemeral_1h_input_tokens)
  // Older records carry only the rolled-up figure; treat it as 5-minute.
  const totalCacheWrite = num(usage.cache_creation_input_tokens)
  const split = cacheWrite5m + cacheWrite1h

  out.event = {
    ts,
    requestId,
    messageId,
    model,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : null,
    project,
    isSidechain: record.isSidechain === true,
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWrite5mTokens: split > 0 ? cacheWrite5m : totalCacheWrite,
    cacheWrite1hTokens: split > 0 ? cacheWrite1h : 0,
    thinkingTokens: num(outputDetails?.thinking_tokens),
  }
  return { kind: 'parsed', ...out }
}

/**
 * Reads only the bytes appended since the last scan.
 *
 * A trailing partial line is left unconsumed rather than parsed, so a session
 * writing while we read does not lose a record or produce a spurious error.
 */
function readAppended(path: string, offset: number, size: number): { lines: string[]; consumed: number } {
  if (size <= offset) return { lines: [], consumed: offset }
  const length = size - offset
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(length)
    readSync(fd, buf, 0, length, offset)
    const text = buf.toString('utf8')
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline === -1) return { lines: [], consumed: offset }
    return {
      lines: text.slice(0, lastNewline).split('\n'),
      consumed: offset + Buffer.byteLength(text.slice(0, lastNewline + 1), 'utf8'),
    }
  } finally {
    closeSync(fd)
  }
}

/** Turns `-Users-me-Projects-Thing` back into something readable. */
export function projectLabel(dirName: string): string {
  const parts = dirName.split('-').filter(Boolean)
  return parts[parts.length - 1] ?? dirName
}

/** Session files are not all at a fixed depth — some sit in nested subdirectories. */
function collectSessionFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) collectSessionFiles(path, out)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path)
  }
  return out
}

export function scanLogs(configDir: string, accountId: string): ScanResult {
  const db = getDb()
  const projectsDir = join(configDir, 'projects')
  const result: ScanResult = { events: [], limitHits: [], filesScanned: 0, bytesRead: 0, parseErrors: 0, linesSeen: 0 }
  if (!existsSync(projectsDir)) return result

  for (const projectDir of readdirSync(projectsDir, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue
    const project = projectLabel(projectDir.name)

    for (const path of collectSessionFiles(join(projectsDir, projectDir.name))) {
      const st = statSync(path)

      const prior = db.select().from(schema.scanState).where(eq(schema.scanState.path, path)).get()
      // A file that shrank was rotated or rewritten; start it over.
      const offset = prior && st.size >= prior.size ? prior.offset : 0
      if (prior && st.size === prior.size && st.mtimeMs === prior.mtimeMs) continue

      const { lines, consumed } = readAppended(path, offset, st.size)
      result.filesScanned += 1
      result.bytesRead += consumed - offset

      let errors = 0
      for (const line of lines) {
        if (!line.trim()) continue
        result.linesSeen += 1
        const parsed = parseLine(line, project)
        if (parsed.kind === 'malformed') { errors += 1; continue }
        if (parsed.kind === 'ignored') continue
        if (parsed.event) result.events.push(parsed.event)
        if (parsed.limitHit) result.limitHits.push(parsed.limitHit)
      }
      result.parseErrors += errors

      db.insert(schema.scanState).values({
        path, accountId, offset: consumed, size: st.size, mtimeMs: Math.round(st.mtimeMs), parseErrors: errors,
      }).onConflictDoUpdate({
        target: schema.scanState.path,
        set: { offset: consumed, size: st.size, mtimeMs: Math.round(st.mtimeMs), parseErrors: errors },
      }).run()
    }
  }

  return result
}

/**
 * Share of lines that were actually corrupt. Past this, the log format has
 * probably changed and the numbers should not be trusted.
 */
export const MAX_PARSE_ERROR_RATE = 0.05

export function persist(accountId: string, scan: ScanResult): { events: number; hits: number } {
  const db = getDb()
  let events = 0
  let hits = 0

  db.transaction((tx) => {
    for (const e of scan.events) {
      const cost = e.model
        ? costUsd(e.model, {
            inputTokens: e.inputTokens,
            outputTokens: e.outputTokens,
            cacheReadTokens: e.cacheReadTokens,
            cacheWrite5mTokens: e.cacheWrite5mTokens,
            cacheWrite1hTokens: e.cacheWrite1hTokens,
          })
        : null

      const res = tx.insert(schema.usageEvents).values({
        accountId,
        ts: e.ts,
        model: e.model ? normalizeModel(e.model) : null,
        sessionId: e.sessionId,
        project: e.project,
        requestId: e.requestId,
        messageId: e.messageId,
        isSidechain: e.isSidechain,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        cacheReadTokens: e.cacheReadTokens,
        cacheWriteTokens: e.cacheWrite5mTokens + e.cacheWrite1hTokens,
        thinkingTokens: e.thinkingTokens,
        costUsd: cost,
      }).onConflictDoNothing().run()
      events += res.changes
    }

    for (const h of scan.limitHits) {
      const res = tx.insert(schema.limitHits).values({
        accountId, ts: h.ts, windowKey: h.windowKey, resetsAt: h.resetsAt, source: 'claude-code-429',
      }).onConflictDoNothing().run()
      hits += res.changes
    }
  })

  return { events, hits }
}

export interface ModelBreakdown { model: string; tokens: number; costUsd: number | null }

function queryPoints(accountId: string, since: number): TokenPoint[] {
  const db = getDb()
  const rows = db.select({
    ts: schema.usageEvents.ts,
    input: schema.usageEvents.inputTokens,
    output: schema.usageEvents.outputTokens,
    cacheWrite: schema.usageEvents.cacheWriteTokens,
  }).from(schema.usageEvents)
    .where(and(eq(schema.usageEvents.accountId, accountId), gte(schema.usageEvents.ts, since)))
    .all()

  // Cache reads are excluded: they are the cheap, mostly-repeated prefix and
  // counting them would make a long session look far heavier than it is.
  return rows.map((r) => ({ t: r.ts, tokens: r.input + r.output + r.cacheWrite }))
}

export function modelBreakdown(accountId: string, since: number): ModelBreakdown[] {
  const db = getDb()
  return db.all<{ model: string; tokens: number; cost: number | null }>(sql`
    SELECT COALESCE(model, 'unknown') AS model,
           SUM(input_tokens + output_tokens + cache_write_tokens) AS tokens,
           SUM(cost_usd) AS cost
    FROM usage_events
    WHERE account_id = ${accountId} AND ts >= ${since}
    GROUP BY model ORDER BY tokens DESC
  `).map((r) => ({ model: r.model, tokens: r.tokens, costUsd: r.cost }))
}

function spendSince(accountId: string, since: number): number | null {
  const db = getDb()
  const row = db.get<{ cost: number | null }>(sql`
    SELECT SUM(cost_usd) AS cost FROM usage_events
    WHERE account_id = ${accountId} AND ts >= ${since}
  `)
  return row?.cost ?? null
}

export const claudeCodeLocal: ProviderAdapter = {
  id: 'claude-code-local',

  async probe(cfg: AccountConfig): Promise<AccountState[]> {
    const dir = expandHome(cfg.claudeConfigDir ?? DEFAULT_CLAUDE_CONFIG_DIR)
    if (!existsSync(join(dir, 'projects'))) {
      return [unconfigured(
        cfg.id, cfg.displayName, 'anthropic', 'claude-code',
        `No projects directory under ${dir}. Run Claude Code once with CLAUDE_CONFIG_DIR set to ${dir}.`, cfg.expectedEmail,
      )]
    }

    const now = Date.now()
    const scan = scanLogs(dir, cfg.id)

    const errorRate = scan.linesSeen > 0 ? scan.parseErrors / scan.linesSeen : 0
    if (errorRate > MAX_PARSE_ERROR_RATE) {
      const state = unconfigured(
        cfg.id, cfg.displayName, 'anthropic', 'claude-code',
        `${scan.parseErrors} of ${scan.linesSeen} lines under ${dir} failed to parse (${(errorRate * 100).toFixed(1)}%). The log format has probably changed — refusing to report numbers from a partial read.`, cfg.expectedEmail,
      )
      state.health = 'error'
      return [state]
    }

    persist(cfg.id, scan)

    const weekAgo = now - WEEK_MS
    const points = queryPoints(cfg.id, weekAgo)
    const block = currentTokenBlock(points, now)
    const weekTokens = points.reduce((sum, p) => sum + p.tokens, 0)

    const budget = budgetForFiveHour(cfg.id, cfg.budgetTokens?.five_hour ?? null)

    const fiveHour: LimitWindow = makeWindow({
      key: 'five_hour',
      label: '5-hour session',
      windowMinutes: 300,
      usedTokens: block?.tokens ?? 0,
      budgetTokens: budget?.tokens ?? null,
      usedPercent: budget && block ? Math.min(100, (block.tokens / budget.tokens) * 100) : null,
      confidence: budget ? 'estimated' : 'unknown',
    })
    if (block) {
      fiveHour.resetsAt = new Date(block.resetsAt).toISOString()
      fiveHour.resetConfidence = 'derived'
    }
    fiveHour.note = budget
      ? `Budget ${budget.tokens.toLocaleString()} tokens (${budget.source}).`
      : 'Calibrating — not enough history to turn tokens into a percentage yet.'

    const weekly = makeWindow({
      key: 'weekly',
      label: 'Weekly',
      windowMinutes: 10080,
      usedTokens: weekTokens,
      confidence: 'derived',
    })

    const burn = emptyBurn()
    burn.tokensPerHour = tokensPerHour(points, now)
    if (budget && block && burn.tokensPerHour && burn.tokensPerHour > 0) {
      const left = budget.tokens - block.tokens
      if (left > 0) {
        const exhaustAt = now + (left / burn.tokensPerHour) * 3_600_000
        if (exhaustAt < block.resetsAt) burn.projectedExhaustAt = new Date(exhaustAt).toISOString()
      }
    }

    // A Claude Code profile keeps its own signed-in account in .claude.json.
    const [identity] = [...claudeIdentityDirectory([cfg.claudeConfigDir ?? '~']).values()]

    const breakdown = modelBreakdown(cfg.id, weekAgo)
    const missing = unpricedModels(breakdown.map((b) => b.model))
    const startOfDay = new Date(now).setHours(0, 0, 0, 0)

    return [{
      accountId: cfg.id,
      configId: cfg.id,
      provider: 'anthropic',
      surface: 'claude-code',
      displayName: cfg.displayName,
      identity: identity && {
        email: identity.email,
        name: identity.name,
        organizationName: identity.organizationName,
        accountUuid: identity.accountUuid,
        organizationUuid: identity.organizationUuid,
      },
      planType: identity?.organizationType ?? null,
      windows: [fiveHour, weekly],
      burn,
      spend: { todayUsd: spendSince(cfg.id, startOfDay), weekUsd: spendSince(cfg.id, weekAgo) },
      breakdown,
      lastSampleAt: points.length ? new Date(Math.max(...points.map((p) => p.t))).toISOString() : null,
      health: points.length ? 'ok' : 'stale',
      message: missing.length
        ? `No published rate for ${missing.join(', ')} — those rows are excluded from cost. Add them to config/pricing.json.`
        : null,
    }]
  },
}

export { basename }
