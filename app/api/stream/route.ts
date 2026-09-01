import { getPayload, subscribe } from '@/lib/runtime/store'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

/** Keeps proxies and browsers from treating a quiet stream as a dead one. */
const HEARTBEAT_MS = 15_000

export async function GET(request: Request) {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      let open = true
      const send = (event: string, data: unknown) => {
        if (!open) return
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          open = false
        }
      }

      // A board that has just connected should not wait for the next tick.
      send('snapshot', await getPayload())

      const unsubscribe = subscribe((payload) => send('snapshot', payload))
      const heartbeat = setInterval(() => send('ping', { t: Date.now() }), HEARTBEAT_MS)

      const close = () => {
        if (!open) return
        open = false
        clearInterval(heartbeat)
        unsubscribe()
        try {
          controller.close()
        } catch {
          // Already closed by the runtime.
        }
      }

      request.signal.addEventListener('abort', close)
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      Connection: 'keep-alive',
      // Nginx and friends will otherwise buffer the stream into uselessness.
      'X-Accel-Buffering': 'no',
    },
  })
}
