#!/usr/bin/env tsx
/**
 * Evaluates alerts against the live state, or with `--send` fires one test
 * message down every enabled channel so a webhook can be verified without
 * waiting for a real threshold crossing.
 */
import { evaluate } from '../lib/alerts'
import { deliver } from '../lib/alerts/notify'
import { loadAlertConfig } from '../lib/alerts/config'
import { probeAll } from '../lib/probe'
import { recentHistory } from '../lib/history'

async function main() {
  const config = loadAlertConfig()
  const enabled = config.channels.filter((c) => c.enabled)
  console.log(`thresholds: ${config.thresholds.join(', ')}%`)
  console.log(`channels:   ${enabled.length ? enabled.map((c) => `${c.id} (${c.kind})`).join(', ') : 'ไม่มีช่องที่เปิดใช้ — จะไม่ส่งอะไรเลย'}`)

  if (process.argv.includes('--send')) {
    await deliver([{
      accountId: 'test', displayName: 'ทดสอบการแจ้งเตือน', windowKey: 'five_hour',
      windowLabel: '5-hour session', threshold: 90, usedPercent: 91.4,
      resetsAt: new Date(Date.now() + 42 * 60_000).toISOString(), confidence: 'reported',
    }], enabled)
    return
  }

  const snapshot = await probeAll()
  const fired = await evaluate({ ...snapshot, history: recentHistory(), externalCount: 0 })
  if (fired.length === 0) {
    console.log('\nไม่มีอะไรถึงเกณฑ์ (หรือเคยแจ้งไปแล้วในหน้าต่างนี้)')
    return
  }
  console.log('')
  for (const alert of fired) {
    console.log(`  ▲ ${alert.displayName} · ${alert.windowLabel} ${Math.round(alert.usedPercent)}% (เกณฑ์ ${alert.threshold}%)`)
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
