import { SEVERITY_COLOR, severityOf } from '@/lib/ui/format'

interface RingProps {
  percent: number | null
  size?: number
  strokeWidth?: number
  label: string
}

/**
 * The card's headline number. Hand-drawn rather than pulled from a chart
 * library because the type inside the ring has to stay legible from across a
 * room, which means controlling the arc and the label together.
 */
export function Ring({ percent, size = 108, strokeWidth = 9, label }: RingProps) {
  const radius = (size - strokeWidth) / 2
  const circumference = 2 * Math.PI * radius
  const clamped = percent == null ? 0 : Math.max(0, Math.min(100, percent))
  const color = SEVERITY_COLOR[severityOf(percent)]

  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={percent == null ? `${label}: ยังไม่มีข้อมูล` : `${label}: ใช้ไป ${Math.round(percent)} เปอร์เซ็นต์`}
      >
        <circle
          cx={size / 2} cy={size / 2} r={radius}
          fill="none" stroke="var(--track)" strokeWidth={strokeWidth}
        />
        {percent == null ? (
          <circle
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke="var(--line)" strokeWidth={strokeWidth}
            strokeDasharray="6 12" strokeLinecap="round"
          />
        ) : (
          <circle
            cx={size / 2} cy={size / 2} r={radius}
            fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round"
            strokeDasharray={`${(clamped / 100) * circumference} ${circumference}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: 'stroke-dasharray 600ms ease, stroke 600ms ease' }}
          />
        )}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className="tnum font-semibold leading-none"
          style={{ color: percent == null ? 'var(--dim)' : color, fontSize: size * 0.28 }}
        >
          {percent == null ? '—' : `${Math.round(percent)}%`}
        </span>
      </div>
    </div>
  )
}
