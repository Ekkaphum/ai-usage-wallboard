'use client'

import { useState } from 'react'
import type { AccountConfig } from '@/lib/config'
import type { Diagnosis } from '@/lib/diagnose'

interface SettingsFormProps {
  initial: AccountConfig[]
  diagnoses: Record<string, Diagnosis>
  configPath: string
  readOnly: boolean
}

const ADAPTERS = [
  { id: 'claude-desktop-plan-usage', label: 'Claude desktop (plan usage)', pathField: 'appDataDir' },
  { id: 'codex-local', label: 'Codex CLI', pathField: 'codexHome' },
  { id: 'claude-code-local', label: 'Claude Code (breakdown)', pathField: 'claudeConfigDir' },
] as const

type PathField = (typeof ADAPTERS)[number]['pathField']

function pathFieldFor(adapter: string): PathField {
  return ADAPTERS.find((a) => a.id === adapter)?.pathField ?? 'appDataDir'
}

export function SettingsForm({ initial, diagnoses, configPath, readOnly }: SettingsFormProps) {
  const [accounts, setAccounts] = useState(initial)
  const [status, setStatus] = useState<{ kind: 'idle' | 'saving' | 'ok' | 'error'; message?: string }>({ kind: 'idle' })

  const update = (index: number, patch: Partial<AccountConfig>) => {
    setAccounts((list) => list.map((a, i) => (i === index ? { ...a, ...patch } : a)))
    setStatus({ kind: 'idle' })
  }

  const save = async () => {
    setStatus({ kind: 'saving' })
    try {
      const response = await fetch('/api/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accounts }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      setStatus({ kind: 'ok', message: `บันทึกแล้ว — ${body.accounts} การ์ดบนจอ` })
    } catch (error) {
      setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[13px] font-semibold uppercase tracking-[0.1em]">Accounts</h2>
        <span className="font-mono text-[11.5px] text-dim">{configPath}</span>
      </div>

      <div className="flex flex-col gap-3">
        {accounts.map((account, index) => {
          const diagnosis = diagnoses[account.id]
          const pathField = pathFieldFor(account.adapter)
          return (
            <article key={account.id} className="rounded-md border border-line bg-panel p-4">
              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={account.enabled}
                    disabled={readOnly}
                    onChange={(e) => update(index, { enabled: e.target.checked })}
                    className="accent-[var(--accent)]"
                  />
                  <span className="sr-only">เปิดใช้ {account.displayName}</span>
                </label>
                <input
                  value={account.displayName}
                  disabled={readOnly}
                  onChange={(e) => update(index, { displayName: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-line bg-ground px-2.5 py-1.5 text-[13px] text-text outline-none focus:border-accent"
                  aria-label="ชื่อที่แสดง"
                />
                <span className="font-mono text-[11px] text-dim">{account.adapter}</span>
              </div>

              <input
                value={(account[pathField] as string | undefined) ?? ''}
                disabled={readOnly}
                onChange={(e) => update(index, { [pathField]: e.target.value } as Partial<AccountConfig>)}
                placeholder="path"
                className="mt-2.5 w-full rounded border border-line bg-ground px-2.5 py-1.5 font-mono text-[12px] text-text outline-none focus:border-accent"
                aria-label="path"
              />

              {diagnosis && (
                <div className="mt-3 flex flex-col gap-1 border-t border-line pt-3 font-mono text-[11.5px]">
                  <p style={{ color: diagnosis.ok ? 'var(--ok)' : 'var(--crit)' }}>
                    {diagnosis.ok ? '● อ่านได้' : '✕ อ่านไม่ได้'}
                  </p>
                  {diagnosis.facts.map((fact) => (
                    <p key={fact} className="text-dim">· {fact}</p>
                  ))}
                  {diagnosis.problem && <p className="text-warn">! {diagnosis.problem}</p>}
                </div>
              )}
            </article>
          )
        })}
      </div>

      {readOnly ? (
        <p className="font-mono text-[12px] text-warn">
          อ่านอย่างเดียว — ตั้ง WALLBOARD_READONLY ไว้
        </p>
      ) : (
        <div className="flex items-center gap-4">
          <button
            onClick={save}
            disabled={status.kind === 'saving'}
            className="rounded border border-accent px-4 py-1.5 text-[13px] text-accent transition-colors hover:bg-accent hover:text-ground disabled:opacity-50"
          >
            {status.kind === 'saving' ? 'กำลังบันทึก…' : 'บันทึก'}
          </button>
          {status.message && (
            <p
              className="font-mono text-[12px]"
              style={{ color: status.kind === 'error' ? 'var(--crit)' : 'var(--ok)' }}
            >
              {status.message}
            </p>
          )}
        </div>
      )}

      <p className="text-[12px] leading-relaxed text-dim">
        ผลตรวจด้านบนเป็นสถานะตอนโหลดหน้านี้ — รีเฟรชเพื่อดูใหม่ · การเปลี่ยน path จะมีผลกับจอทันทีที่บันทึก
      </p>
    </section>
  )
}
