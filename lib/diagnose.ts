import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AccountConfig } from '@/lib/config'
import { expandHome, DEFAULT_CLAUDE_APP_DATA, DEFAULT_CODEX_HOME, DEFAULT_CLAUDE_CONFIG_DIR } from '@/lib/domain/paths'
import { PLAN_USAGE_FILE } from '@/lib/adapters/claude-desktop-plan-usage'

/**
 * Answers "is this account wired up correctly?" with specifics rather than a
 * green tick — which file, how many of them, how old the newest record is. A
 * test that only says "OK" is useless the moment something is subtly wrong.
 */

export interface Diagnosis {
  ok: boolean
  path: string
  facts: string[]
  problem: string | null
}

function fail(path: string, problem: string): Diagnosis {
  return { ok: false, path, facts: [], problem }
}

function newestMtime(dir: string, match: (name: string) => boolean, depth = 4): { count: number; newest: number } {
  let count = 0
  let newest = 0
  const walk = (current: string, level: number) => {
    if (level > depth) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full, level + 1)
      else if (entry.isFile() && match(entry.name)) {
        count += 1
        try {
          newest = Math.max(newest, statSync(full).mtimeMs)
        } catch { /* raced with a rotation */ }
      }
    }
  }
  walk(dir, 0)
  return { count, newest }
}

function age(ms: number): string {
  if (!ms) return 'ไม่ทราบ'
  const minutes = Math.round((Date.now() - ms) / 60_000)
  if (minutes < 1) return 'เมื่อครู่'
  if (minutes < 60) return `${minutes} นาทีที่แล้ว`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} ชม.ที่แล้ว` : `${Math.round(hours / 24)} วันที่แล้ว`
}

export function diagnose(account: AccountConfig): Diagnosis {
  switch (account.adapter) {
    case 'claude-desktop-plan-usage': {
      const dir = expandHome(account.appDataDir ?? DEFAULT_CLAUDE_APP_DATA)
      const file = join(dir, PLAN_USAGE_FILE)
      if (!existsSync(file)) {
        return fail(file, `ไม่พบไฟล์ — ล็อกอิน account นี้ในหน้าต่าง Claude ที่ชี้มาที่ ${dir} แล้วใช้งานสักครั้ง`)
      }
      try {
        const raw = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; samples?: { t: number; org: string }[] }
        if (raw.version !== 2) return fail(file, `schema version ${raw.version} ที่ไม่รู้จัก — adapter ต้องอัปเดต`)
        const samples = raw.samples ?? []
        if (samples.length === 0) return fail(file, 'ไฟล์ยังไม่มี sample')
        const orgs = new Set(samples.map((s) => s.org))
        const newest = Math.max(...samples.map((s) => s.t))
        return {
          ok: true,
          path: file,
          facts: [
            `${samples.length.toLocaleString()} samples`,
            `${orgs.size} org: ${[...orgs].map((o) => o.slice(0, 8)).join(', ')}`,
            `sample ล่าสุด ${age(newest)}`,
            `ย้อนหลังถึง ${new Date(Math.min(...samples.map((s) => s.t))).toLocaleDateString('en-GB')}`,
          ],
          problem: null,
        }
      } catch (error) {
        return fail(file, error instanceof Error ? error.message : String(error))
      }
    }

    case 'codex-local': {
      const dir = join(expandHome(account.codexHome ?? DEFAULT_CODEX_HOME), 'sessions')
      if (!existsSync(dir)) return fail(dir, `ไม่พบโฟลเดอร์ — รัน codex สักครั้งโดยตั้ง CODEX_HOME ให้ชี้มาที่นี่`)
      const { count, newest } = newestMtime(dir, (n) => n.startsWith('rollout-') && n.endsWith('.jsonl'))
      if (count === 0) return fail(dir, 'ไม่พบไฟล์ rollout-*.jsonl')
      const stale = Date.now() - newest > 48 * 3_600_000
      return {
        ok: true,
        path: dir,
        facts: [`${count} session log`, `เขียนล่าสุด ${age(newest)}`],
        // The adapter only reads logs touched in the last 48h, so an older tree
        // reads as configured-but-silent rather than working.
        problem: stale ? 'ไม่มี session ไหนถูกเขียนใน 48 ชม.ที่ผ่านมา — adapter จะไม่เห็นตัวเลขปัจจุบัน' : null,
      }
    }

    case 'claude-code-local': {
      const dir = join(expandHome(account.claudeConfigDir ?? DEFAULT_CLAUDE_CONFIG_DIR), 'projects')
      if (!existsSync(dir)) return fail(dir, 'ไม่พบโฟลเดอร์ projects')
      const { count, newest } = newestMtime(dir, (n) => n.endsWith('.jsonl'))
      if (count === 0) return fail(dir, 'ไม่พบไฟล์ .jsonl')
      return { ok: true, path: dir, facts: [`${count} ไฟล์`, `เขียนล่าสุด ${age(newest)}`], problem: null }
    }

    default:
      return fail('—', `ไม่รู้จัก adapter "${account.adapter}"`)
  }
}
