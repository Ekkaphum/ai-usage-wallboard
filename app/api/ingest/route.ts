import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ingest } from '@/lib/runtime/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Accepts an account state pushed from another machine's collector, or from a
 * script standing in for a provider we have no adapter for.
 */

const LimitWindowSchema = z.object({
  key: z.enum(['five_hour', 'weekly', 'daily', 'monthly', 'credit']),
  label: z.string(),
  windowMinutes: z.number(),
  usedPercent: z.number().nullable().default(null),
  usedTokens: z.number().nullable().default(null),
  budgetTokens: z.number().nullable().default(null),
  resetsAt: z.string().nullable().default(null),
  confidence: z.enum(['reported', 'derived', 'estimated', 'unknown']),
  resetConfidence: z.enum(['reported', 'derived', 'estimated', 'unknown']).default('unknown'),
  resetUncertaintyMs: z.number().nullable().default(null),
  hitAt: z.string().nullable().default(null),
  note: z.string().nullable().default(null),
})

const StateSchema = z.object({
  accountId: z.string().min(1),
  configId: z.string().min(1).optional(),
  provider: z.enum(['anthropic', 'openai', 'openrouter', 'google', 'github', 'custom']).default('custom'),
  surface: z.enum(['claude-desktop', 'claude-code', 'codex-cli', 'api', 'web']).default('api'),
  displayName: z.string().min(1),
  planType: z.string().nullable().default(null),
  windows: z.array(LimitWindowSchema).default([]),
  burn: z.object({
    tokensPerHour: z.number().nullable().default(null),
    percentPerHour: z.number().nullable().default(null),
    projectedExhaustAt: z.string().nullable().default(null),
  }).default({ tokensPerHour: null, percentPerHour: null, projectedExhaustAt: null }),
  spend: z.object({
    todayUsd: z.number().nullable().default(null),
    weekUsd: z.number().nullable().default(null),
  }).default({ todayUsd: null, weekUsd: null }),
  breakdown: z.array(z.object({
    model: z.string(),
    tokens: z.number(),
    costUsd: z.number().nullable().default(null),
  })).optional(),
  lastSampleAt: z.string().nullable().default(null),
  health: z.enum(['ok', 'stale', 'error', 'unconfigured']).default('ok'),
  message: z.string().nullable().default(null),
})

function authorized(request: Request): boolean {
  const expected = process.env.INGEST_TOKEN
  // Without a configured token the endpoint stays closed rather than open.
  if (!expected) return false
  const header = request.headers.get('authorization') ?? ''
  return header === `Bearer ${expected}`
}

export async function POST(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json(
      { error: process.env.INGEST_TOKEN ? 'Invalid token.' : 'Ingest is disabled. Set INGEST_TOKEN to enable it.' },
      { status: 401 },
    )
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 })
  }

  const parsed = StateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: z.prettifyError(parsed.error) }, { status: 400 })
  }

  const state = parsed.data
  ingest({ ...state, configId: state.configId ?? state.accountId })
  return NextResponse.json({ ok: true, accountId: state.accountId })
}
