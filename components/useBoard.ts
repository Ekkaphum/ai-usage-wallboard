'use client'

import { useEffect, useRef, useState } from 'react'
import type { BoardPayload } from '@/lib/runtime/store'

export type ConnectionState = 'live' | 'polling' | 'offline'

/** Falls back to polling this often when the event stream will not stay up. */
const POLL_INTERVAL_MS = 15_000
/** Consecutive stream failures before giving up on SSE for this page load. */
const MAX_STREAM_RETRIES = 3

/**
 * Keeps the board fed. The event stream is the fast path; polling is the
 * fallback that keeps a screen honest when the stream cannot hold — a wallboard
 * showing hour-old numbers with no indication is worse than one that admits it.
 */
export function useBoard(initial: BoardPayload) {
  const [payload, setPayload] = useState(initial)
  const [connection, setConnection] = useState<ConnectionState>('live')
  const failures = useRef(0)

  useEffect(() => {
    let disposed = false
    let source: EventSource | null = null
    let pollTimer: ReturnType<typeof setInterval> | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const poll = async () => {
      try {
        const response = await fetch('/api/state', { cache: 'no-store' })
        if (!response.ok) throw new Error(String(response.status))
        if (!disposed) {
          setPayload(await response.json())
          setConnection((c) => (c === 'offline' ? 'polling' : c))
        }
      } catch {
        if (!disposed) setConnection('offline')
      }
    }

    const startPolling = () => {
      if (pollTimer) return
      setConnection('polling')
      void poll()
      pollTimer = setInterval(poll, POLL_INTERVAL_MS)
    }

    const connect = () => {
      source = new EventSource('/api/stream')

      source.addEventListener('snapshot', (event) => {
        if (disposed) return
        failures.current = 0
        setConnection('live')
        try {
          setPayload(JSON.parse((event as MessageEvent).data))
        } catch {
          // A malformed frame is not worth tearing the stream down for.
        }
      })

      source.onerror = () => {
        source?.close()
        source = null
        if (disposed) return

        failures.current += 1
        if (failures.current >= MAX_STREAM_RETRIES) {
          startPolling()
          return
        }
        setConnection('offline')
        // Back off so a server that is restarting is not hammered.
        retryTimer = setTimeout(connect, 1_000 * failures.current)
      }
    }

    connect()

    return () => {
      disposed = true
      source?.close()
      if (pollTimer) clearInterval(pollTimer)
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [])

  return { payload, connection }
}

/**
 * A single clock for the whole board, so every countdown ticks in step.
 *
 * Seeded from the snapshot's own timestamp so the server-rendered markup and
 * the first client paint agree; the real clock takes over on mount.
 */
export function useNow(seedMs: number, intervalMs = 1000): number {
  const [now, setNow] = useState(seedMs)

  useEffect(() => {
    // Deliberate: the seed is the *server's* clock, kept only so hydration
    // matches. A wallboard whose countdown is wrong by the render latency is
    // exactly the bug this exists to avoid, so the real time is adopted on the
    // first commit rather than a second later at the first tick.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}
