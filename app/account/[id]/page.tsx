import Link from 'next/link'
import { notFound } from 'next/navigation'
import { buildReport, listAccounts } from '@/lib/reports/account'
import { formatTokens, formatUsd } from '@/lib/ui/format'
import { HourlyChart } from '@/components/HourlyChart'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const dateTime = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

export default async function AccountPage({ params }: PageProps<'/account/[id]'>) {
  const { id } = await params
  const report = buildReport(decodeURIComponent(id))
  if (!report) notFound()

  const others = listAccounts().filter((a) => a.id !== report.accountId)

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-6 py-8">
      <header className="flex flex-wrap items-baseline justify-between gap-4 border-b border-line pb-4">
        <div>
          <h1 className="text-[17px] font-bold tracking-tight">{report.displayName}</h1>
          {(report.email || report.accountName) && (
            <p className="font-mono text-[12px] text-accent">
              {report.email ?? report.accountName}
              {report.organizationName && report.organizationName !== report.email && (
                <span className="text-dim">  {report.organizationName}</span>
              )}
            </p>
          )}
          <p className="font-mono text-[11.5px] text-dim">
            {report.provider}/{report.surface}
            {report.planType ? ` · ${report.planType}` : ''}
            {report.usageId !== report.accountId && ` · token จาก ${report.usageId}`}
          </p>
        </div>
        <nav className="flex items-center gap-4 font-mono text-[12px]">
          <a
            href={`/api/export?account=${encodeURIComponent(report.accountId)}`}
            className="text-accent hover:underline"
          >
            ↓ CSV
          </a>
          <Link href="/" className="text-dim hover:text-accent">← จอ</Link>
        </nav>
      </header>

      <section className="grid gap-px bg-line sm:grid-cols-3">
        <Stat label="token 7 วัน" value={formatTokens(report.totals.tokens)} />
        <Stat label="cost 7 วัน" value={formatUsd(report.totals.costUsd)} />
        <Stat label="ข้อความ" value={report.totals.events.toLocaleString()} />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em]">Token ต่อชั่วโมง · 7 วัน</h2>
        {report.hourly.length === 0 ? (
          <Empty>ยังไม่มีข้อมูล token สำหรับ account นี้ — มีเฉพาะ account ที่มี log ระดับ message</Empty>
        ) : (
          <HourlyChart points={report.hourly} />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em]">แยกตาม model</h2>
        {report.models.length === 0 ? <Empty>ไม่มีข้อมูล</Empty> : (
          <Table
            head={['model', 'tokens', 'cost', 'ข้อความ']}
            rows={report.models.map((m) => [
              m.model,
              formatTokens(m.tokens),
              m.costUsd == null ? '—' : formatUsd(m.costUsd),
              m.events.toLocaleString(),
            ])}
            bars={report.models.map((m) => m.tokens / Math.max(...report.models.map((x) => x.tokens)))}
          />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em]">Session ล่าสุด</h2>
        {report.sessions.length === 0 ? <Empty>ไม่มีข้อมูล</Empty> : (
          <Table
            head={['เวลา', 'project', 'tokens', 'cost']}
            rows={report.sessions.map((s) => [
              dateTime(s.endedAt),
              s.project ?? '—',
              formatTokens(s.tokens),
              s.costUsd == null ? '—' : formatUsd(s.costUsd),
            ])}
          />
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em]">
          ประวัติการชนลิมิต
          <span className="ml-2 font-mono text-[11px] font-normal normal-case text-dim">
            ใช้ calibrate budget เวลาไม่มีตัวเลขจาก server
          </span>
        </h2>
        {report.limitHits.length === 0 ? <Empty>ยังไม่เคยชนลิมิตในข้อมูลที่มี</Empty> : (
          <Table
            head={['เวลา', 'หน้าต่าง', 'รีเซ็ตเมื่อ', 'ที่มา']}
            rows={report.limitHits.map((h) => [
              dateTime(h.ts),
              h.windowKey,
              h.resetsAt ? dateTime(h.resetsAt) : '—',
              h.source,
            ])}
          />
        )}
      </section>

      {others.length > 0 && (
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line pt-4 font-mono text-[12px]">
          <span className="text-dim">account อื่น:</span>
          {others.map((a) => (
            <Link key={a.id} href={`/account/${encodeURIComponent(a.id)}`} className="text-accent hover:underline">
              {a.displayName}
              {a.email && <span className="text-dim"> ({a.email})</span>}
            </Link>
          ))}
        </footer>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-panel px-5 py-4">
      <p className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-dim">{label}</p>
      <p className="tnum mt-1 text-[24px] font-semibold">{value}</p>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-line bg-panel px-4 py-6 text-[13px] text-dim">{children}</p>
}

function Table({ head, rows, bars }: { head: string[]; rows: string[][]; bars?: number[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-panel">
      <table className="w-full min-w-[520px] text-[13px]">
        <thead>
          <tr className="border-b border-line">
            {head.map((h) => (
              <th key={h} className="px-4 py-2.5 text-left font-mono text-[10.5px] font-medium uppercase tracking-[0.1em] text-dim">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-line/60 last:border-0">
              {row.map((cell, j) => (
                <td key={j} className={`px-4 py-2 ${j === 0 ? '' : 'tnum'}`}>
                  {j === 0 && bars ? (
                    <span className="flex items-center gap-2">
                      <span className="inline-block h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-track">
                        <span className="block h-full rounded-full bg-accent" style={{ width: `${bars[i] * 100}%` }} />
                      </span>
                      {cell}
                    </span>
                  ) : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
