import type { HistoryPoint } from '@/lib/history'

interface SparklineProps {
  points: HistoryPoint[]
  color: string
  /** The chart grows into spare card height, between these bounds. */
  minHeight?: number
  maxHeight?: number
}

/**
 * Six hours of the primary window, drawn edge to edge. Deliberately unlabelled:
 * its job is to show the *shape* of the last few hours — a steady climb versus
 * a burst versus a flat line — not to be read for values.
 */
export function Sparkline({ points, color, minHeight = 30, maxHeight = 104 }: SparklineProps) {
  const usable = points.filter((p) => p.five != null) as (HistoryPoint & { five: number })[]
  if (usable.length < 2) {
    return <div className="flex-1" style={{ minHeight, maxHeight }} aria-hidden="true" />
  }

  // Drawn in a fixed coordinate space and stretched by CSS, so the same path
  // works whether the card is 30px tall or fills a quarter of a 4K screen.
  const width = 100
  const height = 30
  const minT = usable[0].t
  const maxT = usable[usable.length - 1].t
  const span = Math.max(1, maxT - minT)

  const coords = usable.map((p) => ({
    x: ((p.t - minT) / span) * width,
    // The series is a percentage, so the vertical scale is fixed at 0-100 —
    // autoscaling would make a quiet hour look identical to a busy one.
    y: height - (Math.max(0, Math.min(100, p.five)) / 100) * height,
  }))

  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(2)} ${c.y.toFixed(2)}`).join(' ')
  const area = `${line} L${width} ${height} L0 ${height} Z`
  const last = coords[coords.length - 1]

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className="block w-full flex-1"
      // Capped so context never outgrows the headline gauge it supports.
      style={{ minHeight, maxHeight }}
      aria-hidden="true"
    >
      <path d={area} fill={color} opacity={0.14} />
      <path d={line} fill="none" stroke={color} strokeWidth={1.6} vectorEffect="non-scaling-stroke" />
      <circle cx={last.x} cy={last.y} r={2} fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
