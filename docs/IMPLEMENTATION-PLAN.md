# AI Usage Dashboard — Implementation Plan

อ้างอิง: [SPEC.md](./SPEC.md) · ประมาณการเป็น "วันทำงานเต็ม" ของ dev 1 คน

---

## หลักการของแผนนี้

1. **ไล่จากตัวที่ได้ข้อมูลจริงก่อน** — ทั้ง Claude (`plan-usage-history.json`) และ Codex (`rate_limits`) ให้ % จริงมาเลย ทำสองตัวนี้ก่อนแล้วเห็นผลทันที
2. **มี CLI ก่อนมี UI** — `npm run probe` พิมพ์ JSON ออกมาให้เห็นว่า adapter ทำงานถูก ก่อนจะไปเสียเวลากับ pixel
3. **ทุกเฟสจบด้วยของที่รันได้จริง** ไม่มีเฟสที่ส่งมอบแค่ abstraction

---

## Phase 0 — Scaffold ✅ เสร็จแล้ว (0.5 วัน)

```bash
npx create-next-app@latest . --ts --tailwind --app --eslint --no-src-dir --use-npm --yes
npm i better-sqlite3 drizzle-orm zod chokidar
npm i -D drizzle-kit @types/better-sqlite3 tsx vitest
npx shadcn@latest init
```

โครงไดเรกทอรี:
```
app/
  page.tsx                 # wall view
  account/[id]/page.tsx    # detail
  settings/page.tsx
  api/state/route.ts       # GET snapshot ล่าสุด
  api/stream/route.ts      # SSE
  api/ingest/route.ts      # รับ push จาก collector/manual
lib/
  domain/                  # types: LimitWindow, AccountState, Confidence
  adapters/
    index.ts               # registry
    codex-local.ts
    claude-code-local.ts
    openrouter.ts
    anthropic-admin.ts
    openai-admin.ts
  db/                      # drizzle schema + migrations
  calc/
    windows.ts             # 5h block / rolling week
    burn.ts                # burn rate + projection
    calibrate.ts           # หา budgetTokens จาก limit_hits + P95
    pricing.ts             # ตารางราคา → cost
  config.ts                # โหลด accounts.json + env
scripts/
  probe.ts                 # CLI: พิมพ์ AccountState ทุก account
  collect.ts               # โหมด push สำหรับ multi-machine
config/
  accounts.example.json
instrumentation.ts         # start scheduler + watchers
```

**Deliverable:** `npm run dev` ขึ้นหน้าเปล่า, `npm run probe` รันได้ (ยังไม่มี adapter)

---

## Phase 1 — Domain + สอง adapter ที่ให้ตัวเลขจริง ✅ เสร็จแล้ว (1.5 วัน)

### 1.1 Domain types
เขียน `lib/domain/types.ts` ตาม §3.1 ของ spec ให้ครบ รวม `Confidence`

### 1.2 DB
Drizzle schema ตาม §3.2 · migration แรก · เปิด WAL mode

### 1.3 `codex-local` adapter
```ts
// pseudo
const dir = cfg.codexHome ?? '~/.codex'
const latest = newestFile(`${dir}/sessions/**/rollout-*.jsonl`)
const lastTokenCount = readLastMatchingLine(latest, l => l.payload?.type === 'token_count')
const rl = RateLimitsSchema.parse(lastTokenCount.payload.rate_limits)  // zod
return {
  windows: [
    win('five_hour', rl.primary, 'reported'),
    win('weekly',    rl.secondary, 'reported'),
    ...(rl.credits?.has_credits ? [creditWin(rl.credits)] : []),
  ],
  planType: rl.plan_type,
  lastSampleAt: lastTokenCount.timestamp,
  health: ageMinutes(lastTokenCount.timestamp) > 30 ? 'stale' : 'ok',
}
```
> ต้องอ่าน **ทุก session ของวันนี้** ไม่ใช่แค่ไฟล์ล่าสุด แล้วเลือก `token_count` ที่ timestamp ใหม่สุด — เพราะอาจมีหลาย session รันพร้อมกัน

### 1.4 `claude-desktop-plan-usage` adapter
```ts
const dir = cfg.claudeAppData ?? '~/Library/Application Support/Claude'
const raw = JSON.parse(read(`${dir}/plan-usage-history.json`))
if (raw.version !== 2) throw new UnknownSchemaError(raw.version)   // fail ดังๆ
const samples = PlanUsageSchema.parse(raw).samples
const last = samples.at(-1)
// derive resetsAt: หา sample ที่ fh ตกลงมา 0 ล่าสุด = จุดเริ่ม block
const blockStart = findLastReset(samples)          // fh[i] > 20 && fh[i+1] === 0
return {
  accountId: last.org,                              // org UUID = identity
  windows: [
    win('five_hour', last.u.fh, blockStart + 5h, 'reported'),
    win('weekly',    last.u.sd, null,            'reported'),
    ...(last.u.xu != null ? [win('credit', 100 - last.u.xu, null, 'reported')] : []),
  ],
  lastSampleAt: new Date(last.t),
  health: ageMinutes(last.t) > 30 ? 'stale' : 'ok',
}
```
> `resetsAt` เป็น `derived` แม้ % จะเป็น `reported` — badge บนการ์ดต้องแยกสองอย่างนี้

### 1.5 CLI probe
`npm run probe` → พิมพ์ตาราง + JSON

**✅ Acceptance:**
- `npm run probe` ให้ `used_percent` ของ Codex ตรงกับที่ codex TUI แสดง
- ให้ `fh` / `sd` ของ Claude ตรงกับที่ `/usage` ในแอปแสดง
- countdown ของทั้งสองตัวถูกต้อง

---

## Phase 2 — ประวัติ 30 วัน + breakdown ต่อ model ✅ เสร็จแล้ว (1.5 วัน)

### 2.1 Backfill ประวัติ
`plan-usage-history.json` มี sample ย้อนหลัง 30 วันอยู่แล้ว → import ทั้งหมดลง `samples` ตอน start ครั้งแรก
(dedupe ด้วย `(account_id, t)`) → กราฟ history ใช้ได้ตั้งแต่วันแรก ไม่ต้องรอสะสม

### 2.2 JSONL parser (incremental) — สำหรับ breakdown
- glob `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl`
- เก็บ `{file, size, mtime, offset}` ใน `scan_state` → อ่านเฉพาะส่วนที่ต่อท้าย + `chokidar` watch
- เก็บเฉพาะ `type === 'assistant' && message.usage` → insert `usage_events`
  แบบ `ON CONFLICT(request_id) DO NOTHING`
- จับ record ที่มี `rateLimitType` → insert `limit_hits`
- **ผลลัพธ์:** token/cost แยกตาม model, project, session — สิ่งที่ `plan-usage-history.json` ไม่มี

### 2.3 Reset detection + burn
```
findLastReset(samples):  sample ที่ fh ตกจาก >20 ลงมา 0  (ตรวจแล้วพบ 8 ครั้งใน 30 วัน)
resetsAt        = blockStart + 5h
percentPerHour  = (fh_now - fh_30minago) * 2
projectedExhaustAt = now + (100 - fh_now) / percentPerHour
คืน null ถ้า projectedExhaustAt > resetsAt (= ปลอดภัย)
```

### 2.4 Calibration — ลดเหลือ fallback
เก็บ `lib/calc/calibrate.ts` ไว้ (budget จาก `limit_hits` → P95) แต่ใช้เฉพาะกรณีที่
`plan-usage-history.json` อ่านไม่ได้ / schema เปลี่ยน → การ์ดเข้าโหมด `calibrating` แทนที่จะดับ

**✅ Acceptance:**
- กราฟ 30 วันขึ้นทันทีในการรันครั้งแรก
- รัน probe สองรอบติดกัน ยอด token ไม่เพิ่มเป็นสองเท่า (dedupe ทำงาน)
- ลบ `plan-usage-history.json` ชั่วคราว → การ์ดตกไปโหมด `calibrating` ไม่ crash

---

## Phase 3 — API + SSE + Wall UI ✅ เสร็จแล้ว (2 วัน)

### 3.0 Multi-account
account แยกด้วย `org` UUID จาก `plan-usage-history.json` โดยตรง — ถ้าสอง config ชี้ path เดียวกัน
หรือได้ `org` ซ้ำ ให้ error ชัดเจนตอน `probe` และใน Settings

### 3.1 Scheduler
`instrumentation.ts` → ทุก 60 วิเรียก `probeAll()` เขียนลง `samples` · chokidar watch สองโฟลเดอร์ → debounce 2 วิ → probe ทันที

### 3.2 API
- `GET /api/state` → `{ accounts: AccountState[], generatedAt }`
- `GET /api/stream` → SSE, push ทุกครั้งที่ snapshot เปลี่ยน + heartbeat 15 วิ
- `POST /api/ingest` → bearer token, zod validate, upsert account state

### 3.3 Wall UI
- `<AccountCard>` = ring + weekly bar + countdown + sparkline + confidence badge
- Ring เขียน SVG เอง (`stroke-dasharray`) — คุมขนาดฟอนต์กลางวงได้
- Countdown เดินฝั่ง client ด้วย `requestAnimationFrame` (1 fps) จาก `resetsAt` ที่เป็น absolute → ไม่ drift
- Grid `repeat(auto-fit, minmax(320px, 1fr))`
- `useSSE()` hook + fallback polling ทุก 15 วิถ้า SSE หลุด
- ธีมมืด default · โหมด `?kiosk=1` ซ่อน nav ทั้งหมด

**✅ Acceptance:** เปิดจอทิ้ง 1 ชม. ตัวเลขขยับตามจริง, ปิด server แล้วเปิดใหม่ UI reconnect เอง, ไม่มี memory leak

---

## Phase 4 — Alerts + Settings ✅ เสร็จแล้ว (1 วัน)

- threshold 70/90% ต่อ window → fire ครั้งเดียวต่อ window (เก็บใน `alerts`) → reset เมื่อข้ามหน้าต่างใหม่
- ช่องทาง: webhook (Slack/Discord/ntfy format), macOS `osascript` notification
- `/settings` — CRUD account, test connection ที่บอก "อ่านได้ 55 ไฟล์, record ล่าสุด 2 นาทีที่แล้ว"
- config เก็บที่ `config/accounts.json`, secrets ที่ `.env.local`

**✅ Acceptance:** ดันให้ Claude ใช้เกิน 70% แล้ว webhook ยิงจริง 1 ครั้ง ไม่ spam

---

## Phase 5 — Official API adapters ✅ เสร็จแล้ว (1 วัน)

- `openrouter` (ง่ายสุด ทำก่อน) → `GET /api/v1/key`
- `anthropic-admin` → usage_report + cost_report, cache 5 นาที
- `openai-admin` → usage/completions + costs
- `pricing.ts` → ตารางราคาต่อ 1M token แยก input/output/cache_read/cache_write ต่อ model, อ่านจาก `config/pricing.json` ที่แก้ได้เอง (ราคาเปลี่ยนบ่อย ห้าม hardcode ในโค้ด)

**✅ Acceptance:** cost ที่คำนวณจาก log เทียบกับ cost_report ต่างกัน < 5%

---

## Phase 6 — Kiosk packaging ✅ เสร็จแล้ว (0.5 วัน)

```xml
<!-- ~/Library/LaunchAgents/com.local.aidashboard.plist -->
<!-- RunAtLoad + KeepAlive → node server.js บน :4000 -->
```
```bash
open -a "Google Chrome" --args --kiosk --app=http://localhost:4000/?kiosk=1
```
- ปิด display sleep เฉพาะตอน dashboard รัน (`caffeinate -d`)
- README บอกวิธี `launchctl load/unload`
- (ทางเลือก) Dockerfile + `docker-compose.yml` ที่ mount `~/.claude:ro` และ `~/.codex:ro`

---

## Phase 7 — Detail view + history ✅ เสร็จแล้ว (1 วัน)

- `/account/[id]` — กราฟ token/ชม. 7 วัน, breakdown ตาม model, ตาราง session, ประวัติ limit hits
- Rollup job: ยุบ `usage_events` เก่ากว่า 90 วันเป็นสรุปรายชั่วโมง
- Export CSV

---

## สรุปไทม์ไลน์

| Phase | งาน | วัน | สะสม |
|---|---|---|---|
| 0 | Scaffold ✅ | 0.5 | 0.5 |
| 1 | Domain + Codex & Claude adapter + CLI probe ✅ | 1.5 | 2 |
| 2 | Backfill 30 วัน + breakdown ต่อ model ✅ | 1.5 | 3.5 |
| 3 | API + SSE + Wall UI ✅ | 2 | 5.5 |
| 4 | Alerts + Settings ✅ | 1 | 6.5 |
| 5 | Official API adapters + pricing ✅ | 1 | 7.5 |
| 6 | Kiosk packaging ✅ | 0.5 | 8 |
| 7 | Detail view + history ✅ | 1 | 9 |

**MVP ที่ใช้งานได้จริง = จบ Phase 3 (~5.5 วัน)** — เห็น Claude 2 account + Codex บนจอ พร้อม countdown และ burn projection

---

## Definition of Done (MVP)

- [ ] เปิดจอทิ้งไว้ 24 ชม. ไม่ crash ไม่ leak
- [ ] Codex แสดง % จาก server จริง (`reported`) และตรงกับที่ codex TUI บอก
- [ ] Claude 2 account แยกกันด้วย `org` UUID แสดง `fh` / `sd` เป็น % จริงจาก plan-usage-history
- [ ] ทุกการ์ดแสดง badge `reported` / `derived` / `estimated` และอายุของข้อมูล
- [ ] countdown ถึงเวลารีเซ็ต ถูกต้องถึงระดับวินาที
- [ ] adapter ตัวใดตัวหนึ่งพัง → การ์ดนั้นขึ้น error, การ์ดอื่นยังทำงาน
- [ ] ไม่มี secret ใน git · server bind 127.0.0.1
- [ ] ไม่มีการเก็บเนื้อหา prompt/response ลง DB

---

## คำตอบของคำถามก่อน Phase 1 (ปิดแล้ว)

| คำถาม | คำตอบ | ผลต่อแผน |
|---|---|---|
| จอเป็นเครื่องเดียวกับที่รัน CLI? | ใช่ | ใช้ topology T1 ตรงๆ ไม่ต้องทำ collector |
| 2 Claude account ใช้ยังไง? | คนละ browser / บ้างก็ GUI app | **ต้องย้ายทั้งสอง account ไปอยู่บน desktop app** (instance ที่สองใช้ `--user-data-dir`) — ถ้าอยู่บน browser จะไม่มีข้อมูลให้อ่านเลย |
| มี Admin API key ระดับ org? | ยังไม่แน่ใจ | เลื่อน Phase 5 ไปหลัง MVP · เช็คได้ที่ console.anthropic.com → Settings → API keys (ถ้าจ่ายแค่ Max subscription จะไม่มี) |
| เจ้าอื่นๆ? | ยังไม่ต้อง แต่ขอให้เผื่อไว้ | Phase 0–1 ทำ adapter registry + `POST /api/ingest` ไว้แล้ว → เพิ่มเจ้าใหม่ = เขียนไฟล์เดียวใน `lib/adapters/` |

## สิ่งเดียวที่ยังบล็อกอยู่

ทดสอบว่า Claude.app รับ `--user-data-dir` จริงไหม (ใช้เวลา 2 นาที):

```bash
open -na Claude --args --user-data-dir="$HOME/Library/Application Support/Claude-b"
```

จากนั้นล็อกอิน account ที่สองในหน้าต่างใหม่ แล้วเช็คว่ามีไฟล์เกิดขึ้น:

```bash
ls -la "$HOME/Library/Application Support/Claude-b/plan-usage-history.json"
```

- **ผ่าน** → ทุกอย่างในแผนนี้ใช้ได้ตามที่เขียน
- **ไม่ผ่าน** → ใช้วิธีสำเนา `.app` แล้วแก้ `CFBundleIdentifier` แทน (+0.5 วัน)
