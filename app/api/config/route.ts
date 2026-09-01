import { NextResponse } from 'next/server'
import { writeFileSync, renameSync } from 'node:fs'
import { z } from 'zod'
import { loadConfig, validateConfig, CONFIG_PATH } from '@/lib/config'
import { refresh } from '@/lib/runtime/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Reads and writes config/accounts.json.
 *
 * Writes are refused when WALLBOARD_READONLY is set, so a board exposed beyond
 * localhost can be made view-only without editing code.
 */

const BodySchema = z.object({
  accounts: z.array(z.object({
    id: z.string().min(1),
    adapter: z.string().min(1),
    displayName: z.string().min(1),
    enabled: z.boolean(),
    appDataDir: z.string().optional(),
    claudeConfigDir: z.string().optional(),
    codexHome: z.string().optional(),
    org: z.string().optional(),
    attachTo: z.string().optional(),
    budgetTokens: z.record(z.string(), z.number()).optional(),
  })).min(1),
})

const readOnly = () => process.env.WALLBOARD_READONLY === '1'

export async function GET() {
  return NextResponse.json(
    { ...loadConfig(), readOnly: readOnly(), path: CONFIG_PATH },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function PUT(request: Request) {
  if (readOnly()) {
    return NextResponse.json({ error: 'อ่านอย่างเดียว — WALLBOARD_READONLY ถูกตั้งไว้' }, { status: 403 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body ต้องเป็น JSON' }, { status: 400 })
  }

  const parsed = BodySchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 })
  }

  // Duplicate paths make two accounts indistinguishable, so they are rejected
  // here rather than quietly producing two identical cards.
  const problems = validateConfig(parsed.data)
  if (problems.length > 0) {
    return NextResponse.json({ error: problems.join('\n') }, { status: 400 })
  }

  // Write to a sibling then rename, so a crash mid-write cannot leave the board
  // with a truncated config it will refuse to start from.
  const temp = `${CONFIG_PATH}.tmp`
  writeFileSync(temp, `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8')
  renameSync(temp, CONFIG_PATH)

  const payload = await refresh()
  return NextResponse.json({ ok: true, accounts: payload.accounts.length })
}
