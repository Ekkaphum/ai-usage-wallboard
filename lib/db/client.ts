import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import * as schema from './schema'

/*
 * These paths are resolved at runtime, not imported as modules. The bundler
 * cannot prove that, and without the hint it traces the entire project into the
 * server output "just in case".
 */
export const DB_PATH = resolve(/* turbopackIgnore: true */ process.cwd(), process.env.DATABASE_PATH ?? 'data/wallboard.db')
const MIGRATIONS_DIR = resolve(/* turbopackIgnore: true */ process.cwd(), 'lib/db/migrations')

/** Same reasoning as the store: one connection per process, not per bundle. */
const DB_KEY = Symbol.for('ai-usage-wallboard.db')
const registry = globalThis as unknown as Record<symbol, ReturnType<typeof create> | undefined>

function create() {
  mkdirSync(dirname(DB_PATH), { recursive: true })
  const sqlite = new Database(DB_PATH)
  // WAL keeps the poller writing while the dashboard reads.
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  const db = drizzle(sqlite, { schema })
  migrate(db, { migrationsFolder: MIGRATIONS_DIR })
  return db
}

export function getDb() {
  return (registry[DB_KEY] ??= create())
}

export { schema }
