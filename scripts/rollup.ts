#!/usr/bin/env tsx
import { rollupOldEvents } from '../lib/reports/rollup'

const result = rollupOldEvents()
if (result.collapsedFrom === 0) {
  console.log(`ไม่มีอะไรให้ยุบ — ไม่มี event เก่ากว่า ${result.cutoff.slice(0, 10)}`)
} else {
  console.log(`ยุบ ${result.collapsedFrom.toLocaleString()} → ${result.collapsedTo.toLocaleString()} แถว (ก่อน ${result.cutoff.slice(0, 10)})`)
  console.log(`ลบ sample เก่า ${result.samplesDeleted.toLocaleString()} แถว`)
}
