import { sqliteTable, text, integer, real, index, unique } from 'drizzle-orm/sqlite-core'

/** One row per account we have ever seen, keyed by the provider-issued id when there is one. */
export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  configId: text('config_id').notNull(),
  provider: text('provider').notNull(),
  surface: text('surface').notNull(),
  displayName: text('display_name').notNull(),
  planType: text('plan_type'),
  firstSeenAt: integer('first_seen_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
})

/**
 * Time series of normalized states. Windows and burn are stored as JSON because
 * their shape is provider-dependent and the board always reads whole snapshots.
 */
export const samples = sqliteTable('samples', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: text('account_id').notNull(),
  /** Time of the *underlying* sample, not of our poll — this is what dedupes backfill. */
  takenAt: integer('taken_at').notNull(),
  observedAt: integer('observed_at').notNull(),
  fivePercent: real('five_percent'),
  weekPercent: real('week_percent'),
  windowsJson: text('windows_json').notNull(),
  burnJson: text('burn_json').notNull(),
  health: text('health').notNull(),
  message: text('message'),
}, (t) => [
  unique('samples_account_taken').on(t.accountId, t.takenAt),
  index('samples_account_time').on(t.accountId, t.takenAt),
])

/** Per-message token accounting from Claude Code logs. Populated in phase 2. */
export const usageEvents = sqliteTable('usage_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: text('account_id').notNull(),
  ts: integer('ts').notNull(),
  model: text('model'),
  sessionId: text('session_id'),
  project: text('project'),
  /**
   * Anthropic's request id paired with the message id. Request id alone is not
   * unique — retries and sidechains can reuse it — and collapsing those would
   * silently drop real usage.
   */
  requestId: text('request_id').notNull(),
  messageId: text('message_id').notNull(),
  isSidechain: integer('is_sidechain', { mode: 'boolean' }).notNull().default(false),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
  cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
  thinkingTokens: integer('thinking_tokens').notNull().default(0),
  costUsd: real('cost_usd'),
}, (t) => [
  unique('usage_events_unique').on(t.requestId, t.messageId),
  index('usage_events_account_time').on(t.accountId, t.ts),
  index('usage_events_model').on(t.accountId, t.model),
])

/** Ground truth for calibration: moments a window was actually exhausted. */
export const limitHits = sqliteTable('limit_hits', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: text('account_id').notNull(),
  ts: integer('ts').notNull(),
  windowKey: text('window_key').notNull(),
  resetsAt: integer('resets_at'),
  source: text('source').notNull(),
}, (t) => [unique('limit_hits_unique').on(t.accountId, t.ts, t.windowKey)])

/** Byte offsets so append-only logs are never re-read from the start. */
export const scanState = sqliteTable('scan_state', {
  path: text('path').primaryKey(),
  accountId: text('account_id').notNull(),
  offset: integer('offset').notNull().default(0),
  size: integer('size').notNull().default(0),
  mtimeMs: integer('mtime_ms').notNull().default(0),
  parseErrors: integer('parse_errors').notNull().default(0),
})

/** Fired alerts, so a threshold notifies once per window rather than every poll. */
export const alerts = sqliteTable('alerts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: text('account_id').notNull(),
  windowKey: text('window_key').notNull(),
  threshold: integer('threshold').notNull(),
  /** Identifies the specific window instance, so a new block can alert again. */
  windowInstance: text('window_instance').notNull(),
  firedAt: integer('fired_at').notNull(),
}, (t) => [unique('alerts_once').on(t.accountId, t.windowKey, t.threshold, t.windowInstance)])
