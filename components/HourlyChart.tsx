import type { HourlyPoint } from '@/lib/reports/account'
import { formatTokens } from '@/lib/ui/format'

/**
 * Hourly token volume over a week. Drawn as bars on a fixed hour grid so gaps
 * read as idle time rather than being closed up — a week with two busy days
 * should look like two busy days, not a continuous line.
 */
export function HourlyChart({ points }: { points: HourlyPoint[] }) {
  if (points.length === 0) return null

  const HOUR = 3_600_000
  const start = points[0].hour
  const end = points[points.length - 1].hour
  const slots = Math.max(1, Math.round((end - start) / HOUR) + 1)
  const peak = Math.max(...points.map((p) => p.tokens))
  const byHour = new Map(points.map((p) => [p.hour, p]))

  const bars = Array.from({ length: slots }, (_, i) => {
    const hour = start + i * HOUR
    return { hour, tokens: byHour.get(hour)?.tokens ?? 0 }
  })

  const dayMarks = bars
    .map((b, i) => ({ i, date: new Date(b.hour) }))
    .filter(({ date }) => date.getHours() === 0)

  return (
    <figure className="flex flex-col gap-2 rounded-md border border-line bg-panel p-4">
      <div className="flex items-end gap-px" style={{ height: 140 }} role="img" aria-label={`token ต่อชั่วโมง สูงสุด ${formatTokens(peak)}`}>
        {bars.map((bar) => (
          <div
            key={bar.hour}
            className="flex-1 rounded-t-[1px] bg-accent transition-[height]"
            style={{
              // A floor of 1px keeps hours with a trickle of usage visible
              // against hours with none at all.
              height: bar.tokens === 0 ? 0 : `${Math.max(1, (bar.tokens / peak) * 100)}%`,
              opacity: bar.tokens === 0 ? 0 : 0.85,
            }}
            title={`${new Date(bar.hour).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit' })} · ${formatTokens(bar.tokens)}`}
          />
        ))}
      </div>
      <figcaption className="flex justify-between font-mono text-[10.5px] text-dim">
        <span>{new Date(start).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span>
        <span>สูงสุด {formatTokens(peak)} / ชม. · {dayMarks.length} วัน</span>
        <span>{new Date(end).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}</span>
      </figcaption>
    </figure>
  )
}
