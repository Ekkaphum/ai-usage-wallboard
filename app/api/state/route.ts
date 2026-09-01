import { NextResponse } from 'next/server'
import { getPayload } from '@/lib/runtime/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const payload = await getPayload()
  return NextResponse.json(payload, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
