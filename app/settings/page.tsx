import Link from 'next/link'
import { loadConfig, CONFIG_PATH } from '@/lib/config'
import { diagnose } from '@/lib/diagnose'
import { loadAlertConfig, ALERTS_PATH } from '@/lib/alerts/config'
import { SettingsForm } from '@/components/SettingsForm'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export default async function SettingsPage() {
  const config = loadConfig()
  const alerts = loadAlertConfig()
  const diagnoses = Object.fromEntries(config.accounts.map((a) => [a.id, diagnose(a)]))
  const readOnly = process.env.WALLBOARD_READONLY === '1'

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-8 px-6 py-8">
      <header className="flex items-baseline justify-between gap-4 border-b border-line pb-4">
        <h1 className="text-[15px] font-bold uppercase tracking-[0.14em]">ตั้งค่า</h1>
        <Link href="/" className="font-mono text-[12px] text-accent hover:underline">
          ← กลับไปหน้าจอ
        </Link>
      </header>

      <SettingsForm
        initial={config.accounts}
        diagnoses={diagnoses}
        configPath={CONFIG_PATH}
        readOnly={readOnly}
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em]">การแจ้งเตือน</h2>
        <p className="font-mono text-[11.5px] text-dim">{ALERTS_PATH}</p>
        <div className="rounded-md border border-line bg-panel p-4 text-[13px]">
          <p className="mb-3 text-dim">
            เกณฑ์: <span className="text-text">{alerts.thresholds.join('%, ')}%</span>
            <span className="text-dim"> — แจ้งครั้งเดียวต่อหนึ่งหน้าต่าง ไม่ยิงซ้ำทุกรอบ poll</span>
          </p>
          {alerts.channels.length === 0 ? (
            <p className="text-dim">
              ยังไม่มีช่องทาง — คัดลอก <code className="text-accent">config/alerts.example.json</code> เป็น{' '}
              <code className="text-accent">config/alerts.json</code> แล้วเปิดใช้ทีละช่อง
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5 font-mono text-[12px]">
              {alerts.channels.map((channel) => (
                <li key={channel.id} className="flex items-center gap-2">
                  <span style={{ color: channel.enabled ? 'var(--ok)' : 'var(--dim)' }}>
                    {channel.enabled ? '●' : '○'}
                  </span>
                  <span className="text-text">{channel.id}</span>
                  <span className="text-dim">
                    {channel.kind}
                    {channel.kind === 'webhook' ? ` · ${channel.format}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 border-t border-line pt-3 font-mono text-[11.5px] text-dim">
            ทดสอบส่งจริง: <span className="text-text">npm run alerts -- --send</span>
          </p>
        </div>
      </section>
    </div>
  )
}
