import { getPayload } from '@/lib/runtime/store'
import { Wall } from '@/components/Wall'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/**
 * Server-renders the first frame from the in-process snapshot so a screen that
 * reloads shows real numbers immediately, rather than a spinner waiting on the
 * event stream to connect.
 */
export default async function Page({ searchParams }: PageProps<'/'>) {
  const params = await searchParams
  const kiosk = params.kiosk === '1' || params.kiosk === 'true'
  const payload = await getPayload()

  return <Wall initial={payload} kiosk={kiosk} />
}
