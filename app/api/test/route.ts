import { NextResponse } from 'next/server'
import { loadConfig } from '@/lib/config'
import { diagnose } from '@/lib/diagnose'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Reports what each configured account can actually see on disk right now. */
export async function GET() {
  const config = loadConfig()
  return NextResponse.json({
    results: config.accounts.map((account) => ({
      id: account.id,
      displayName: account.displayName,
      adapter: account.adapter,
      enabled: account.enabled,
      ...diagnose(account),
    })),
  }, { headers: { 'Cache-Control': 'no-store' } })
}
