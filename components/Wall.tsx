'use client'

import { useMemo } from 'react'
import type { BoardPayload } from '@/lib/runtime/store'
import { AccountCard } from './AccountCard'
import { useBoard, useNow, type ConnectionState } from './useBoard'
import Link from 'next/link'
import { formatUsd, formatTokens } from '@/lib/ui/format'

interface WallProps {
  initial: BoardPayload
  kiosk: boolean
}

export function Wall({ initial, kiosk }: WallProps) {
  const { payload, connection } = useBoard(initial)
  const now = useNow(Date.parse(payload.generatedAt))

  const totals = useMemo(() => {
    let today = 0
    let hasSpend = false
    let tokens = 0
    for (const account of payload.accounts) {
      if (account.spend.todayUsd != null) { today += account.spend.todayUsd; hasSpend = true }
      for (const entry of account.breakdown ?? []) tokens += entry.tokens
    }
    return { today: hasSpend ? today : null, tokens }
  }, [payload.accounts])

  const attention = payload.accounts.filter((a) =>
    a.windows.some((w) => (w.usedPercent ?? 0) >= 80) || a.burn.projectedExhaustAt != null,
  ).length

  return (
    <div className="flex min-h-screen flex-col bg-ground">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-b border-line bg-panel-raised px-5 py-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[14px] font-bold uppercase tracking-[0.14em] text-text">AI Usage</h1>
          {attention > 0 && (
            <span className="font-mono text-[11px] text-warn">{attention} ต้องดู</span>
          )}
        </div>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 font-mono text-[12px] text-dim">
          {totals.tokens > 0 && (
            <span>สัปดาห์นี้ <span className="tnum text-text">{formatTokens(totals.tokens)}</span> tok</span>
          )}
          {totals.today != null && (
            <span>วันนี้ <span className="tnum text-text">{formatUsd(totals.today)}</span></span>
          )}
          <ConnectionDot state={connection} />
          <span className="tnum text-text">
            {new Date(now).toLocaleTimeString('en-GB')}
          </span>
          {!kiosk && (
            <Link href="/settings" className="text-dim transition-colors hover:text-accent">
              ตั้งค่า
            </Link>
          )}
        </div>
      </header>

      {payload.problems.length > 0 && !kiosk && (
        <div className="border-b border-line bg-panel px-5 py-2.5">
          {payload.problems.map((problem) => (
            <p key={problem} className="font-mono text-[11.5px] text-crit">! {problem}</p>
          ))}
        </div>
      )}

      <main
        className="grid flex-1 gap-px bg-line"
        style={{
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          // Cards take their natural height and the whole grid is centred in the
          // leftover space. Stretching rows instead would fill the screen, but
          // it does so by opening a dead band *inside* every card.
          gridAutoRows: 'min-content',
          alignContent: 'center',
        }}
      >
        {payload.accounts.length === 0 ? <Waiting /> : payload.accounts.map((account) => (
          <AccountCard
            key={account.accountId}
            account={account}
            history={payload.history[account.accountId] ?? []}
            now={now}
            linkToDetail={!kiosk}
          />
        ))}
      </main>

      {!kiosk && (
        <footer className="border-t border-line bg-panel-raised px-5 py-2 font-mono text-[10.5px] text-dim">
          <span className="text-ok">reported</span> = server บอกมา ·{' '}
          <span className="text-accent">derived</span> = คำนวณจาก log ·{' '}
          <span className="text-warn">estimated</span> = ประมาณจาก budget ·{' '}
          <span>calibrating</span> = ข้อมูลยังไม่พอ ไม่เดา %
          {payload.externalCount > 0 && ` · ${payload.externalCount} account จากเครื่องอื่น`}
        </footer>
      )}
    </div>
  )
}

/**
 * A display-only board has nothing of its own to read; every card arrives from
 * a collector on another machine. Until the first push lands the grid is empty,
 * and an empty grid on a wall is indistinguishable from a broken one.
 */
function Waiting() {
  return (
    <div className="flex flex-col items-center gap-2 bg-panel px-6 py-16 text-center">
      <p className="font-mono text-[13px] text-dim">ยังไม่มีข้อมูล</p>
      <p className="max-w-[42ch] font-mono text-[11.5px] leading-relaxed text-dim opacity-70">
        เครื่องนี้ไม่มี account ตั้งไว้ในเครื่อง — กำลังรอเครื่องเก็บส่งข้อมูลเข้ามาที่{' '}
        <span className="text-text">/api/ingest</span>
      </p>
    </div>
  )
}

function ConnectionDot({ state }: { state: ConnectionState }) {
  const config = {
    live: { color: 'var(--ok)', label: 'live' },
    polling: { color: 'var(--warn)', label: 'polling' },
    offline: { color: 'var(--crit)', label: 'offline' },
  }[state]

  return (
    <span className="flex items-center gap-1.5" title={`การเชื่อมต่อ: ${config.label}`}>
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${state === 'offline' ? 'pulse-crit' : ''}`}
        style={{ background: config.color }}
      />
      <span style={{ color: config.color }}>{config.label}</span>
    </span>
  )
}
