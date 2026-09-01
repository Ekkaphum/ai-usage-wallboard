import { NextResponse } from 'next/server'
import { buildReport, toCsv } from '@/lib/reports/account'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(request: Request) {
  const accountId = new URL(request.url).searchParams.get('account')
  if (!accountId) {
    return NextResponse.json({ error: 'ต้องระบุ ?account=' }, { status: 400 })
  }

  const report = buildReport(accountId)
  if (!report) {
    return NextResponse.json({ error: `ไม่พบ account "${accountId}"` }, { status: 404 })
  }

  // The id can contain characters a filename should not carry.
  const safeName = accountId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return new NextResponse(toCsv(report), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="usage-${safeName}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
