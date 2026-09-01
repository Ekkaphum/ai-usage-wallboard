'use client'

import type { AccountState, LimitWindow } from '@/lib/domain/types'
import type { HistoryPoint } from '@/lib/history'
import Link from 'next/link'
import { Ring } from './Ring'
import { Sparkline } from './Sparkline'
import {
  SEVERITY_COLOR, severityOf, formatTokens, formatUsd, formatCountdown, formatAge,
  formatClock, confidenceLabel, confidenceColor, HEALTH_MARK, primaryWindow, windowByKey,
} from '@/lib/ui/format'

interface AccountCardProps {
  account: AccountState
  history: HistoryPoint[]
  /** Ticks once a second so every countdown on the board moves together. */
  now: number
  /** Kiosk screens are not clicked, so the card is inert there. */
  linkToDetail?: boolean
}

export function AccountCard({ account, history, now, linkToDetail = true }: AccountCardProps) {
  const primary = primaryWindow(account.windows)
  const weekly = windowByKey(account.windows, 'weekly')
  const credit = windowByKey(account.windows, 'credit')
  const severity = severityOf(primary?.usedPercent ?? null)
  const color = SEVERITY_COLOR[severity]
  const dimmed = account.health === 'stale' || account.health === 'unconfigured'
  // The email is the thing that actually tells two accounts apart; fall back to
  // a name, then to nothing rather than repeating the card's own label.
  const identityLine = account.identity?.email ?? account.identity?.name ?? null

  return (
    <article
      className="flex flex-col gap-3 bg-panel p-5 transition-opacity duration-500"
      style={{ opacity: dimmed ? 0.5 : 1 }}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="truncate text-[13px] font-semibold uppercase tracking-[0.09em] text-text">
            {linkToDetail ? (
              <Link
                href={`/account/${encodeURIComponent(account.accountId)}`}
                className="transition-colors hover:text-accent"
              >
                {account.displayName}
              </Link>
            ) : account.displayName}
          </h2>
          {identityLine && (
            <p
              className="truncate font-mono text-[11.5px] text-accent"
              title={account.identity?.verified
                ? `${identityLine} — อ่านจาก credential ในเครื่อง`
                : `${identityLine} — ตั้งไว้ใน config, ยืนยันไม่ได้`}
            >
              {identityLine}
              {account.identity && !account.identity.verified && (
                <span className="ml-1 text-dim" aria-label="ตั้งค่าไว้เอง ยังยืนยันไม่ได้">*</span>
              )}
            </p>
          )}
          <p className="truncate font-mono text-[10.5px] text-dim">
            {account.surface}
            {account.planType ? ` · ${account.planType}` : ''}
            {!identityLine && account.identity?.organizationUuid
              ? ` · ${account.identity.organizationUuid.slice(0, 8)}…`
              : ''}
          </p>
        </div>
        <span
          className="shrink-0 text-[11px] leading-5"
          style={{ color: account.health === 'error' ? 'var(--crit)' : account.health === 'ok' ? 'var(--ok)' : 'var(--dim)' }}
          title={account.health}
          aria-label={`สถานะ: ${account.health}`}
        >
          {HEALTH_MARK[account.health]}
        </span>
      </header>

      {account.windows.length === 0 ? (
        <NoData message={account.message} />
      ) : (
        <>
          <div className="flex items-center gap-4">
            <Ring percent={primary?.usedPercent ?? null} label={primary?.label ?? 'usage'} />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-dim">
                {primary?.label ?? '—'}
              </p>
              {primary?.usedPercent == null && primary?.usedTokens != null && (
                <p className="tnum mt-1 text-[15px] font-semibold text-accent">
                  {formatTokens(primary.usedTokens)}
                  <span className="ml-1 text-[11px] font-normal text-dim">tok</span>
                </p>
              )}
              {primary && <Countdown window={primary} now={now} />}
            </div>
          </div>

          {account.burn.projectedExhaustAt && (
            <p
              className={`flex items-center gap-1.5 font-mono text-[11px] ${severity === 'crit' ? 'pulse-crit' : ''}`}
              style={{ color: severity === 'crit' ? 'var(--crit)' : 'var(--warn)' }}
            >
              <span aria-hidden="true">▲</span>
              คาดว่าเต็ม {formatClock(account.burn.projectedExhaustAt)} — ก่อนรีเซ็ต
            </p>
          )}

          {weekly && <SecondaryBar window={weekly} />}
          {credit && <SecondaryBar window={credit} />}

          <Sparkline points={history} color={color} minHeight={30} />

          {(account.spend.todayUsd != null || account.breakdown?.length) && (
            <div className="flex items-baseline justify-between gap-2 font-mono text-[11px] text-dim">
              <span>
                วันนี้ <span className="tnum text-text">{formatUsd(account.spend.todayUsd)}</span>
              </span>
              {account.breakdown?.[0] && (
                <span className="truncate">
                  {account.breakdown[0].model.replace('claude-', '')} {formatTokens(account.breakdown[0].tokens)}
                </span>
              )}
            </div>
          )}
        </>
      )}

      <footer className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-2.5">
        {primary ? (
          <span
            className="rounded-[3px] border px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.12em]"
            style={{ color: confidenceColor(primary.confidence), borderColor: 'currentColor' }}
            title={primary.note ?? undefined}
          >
            {confidenceLabel(primary.confidence)}
          </span>
        ) : (
          <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-dim">
            {account.health}
          </span>
        )}
        <span className="tnum font-mono text-[10px] text-dim">
          {formatAge(account.lastSampleAt, now)}
        </span>
      </footer>
    </article>
  )
}

function Countdown({ window: w, now }: { window: LimitWindow; now: number }) {
  if (w.windowMinutes === 0) return null

  if (!w.resetsAt) {
    return <p className="mt-1.5 font-mono text-[11px] text-dim">รีเซ็ต — ไม่ทราบ</p>
  }

  const remaining = formatCountdown(Date.parse(w.resetsAt), now)
  const uncertainty = w.resetUncertaintyMs
    ? ` ±${Math.round(w.resetUncertaintyMs / 60_000)}m`
    : ''

  return (
    <p className="mt-1.5 font-mono text-[11px] text-dim">
      รีเซ็ตอีก{' '}
      <span className="tnum text-text">{remaining ?? 'ครบแล้ว'}</span>
      {remaining && uncertainty && <span className="text-dim">{uncertainty}</span>}
      {w.resetConfidence === 'derived' && (
        <span className="ml-1 text-dim" title="เวลารีเซ็ตคำนวณเอง ไม่ได้มาจาก server">~</span>
      )}
    </p>
  )
}

function SecondaryBar({ window: w }: { window: LimitWindow }) {
  const percent = w.usedPercent
  const color = SEVERITY_COLOR[severityOf(percent)]

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between font-mono text-[11px]">
        <span className="text-dim">{w.label.toLowerCase()}</span>
        <span className="tnum text-text">
          {percent != null
            ? `${Math.round(percent)}%`
            : w.usedTokens != null
              ? `${formatTokens(w.usedTokens)} tok`
              : '—'}
        </span>
      </div>
      <div className="h-[5px] overflow-hidden rounded-full bg-track">
        <div
          className="h-full rounded-full transition-[width] duration-700"
          style={{
            width: `${percent != null ? Math.max(0, Math.min(100, percent)) : 0}%`,
            background: color,
          }}
        />
      </div>
    </div>
  )
}

function NoData({ message }: { message: string | null }) {
  return (
    <div className="flex flex-1 flex-col gap-2.5">
      <div className="flex items-center gap-4">
        <Ring percent={null} label="usage" />
        <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-dim">ไม่มีข้อมูล</p>
      </div>
      {message && (
        // Setup instructions arrive as several lines; keep the breaks.
        <p className="whitespace-pre-line text-[11.5px] leading-relaxed text-dim">{message}</p>
      )}
    </div>
  )
}
