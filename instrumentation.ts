/**
 * Starts the polling loop and file watchers once, when the server boots.
 * Guarded to the Node runtime — the store touches the filesystem and SQLite.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { start } = await import('@/lib/runtime/store')
  await start()
}
