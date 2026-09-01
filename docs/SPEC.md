# AI Usage Dashboard — Product & Technical Spec

เวอร์ชัน 0.1 · 2026-09-01

---

## 1. เป้าหมาย

จอมอนิเตอร์ (wallboard) ที่เปิดทิ้งไว้ตลอดเวลา แสดงว่า **AI account แต่ละตัวที่เราใช้อยู่ ตอนนี้ใช้ไปเท่าไหร่ เหลือเท่าไหร่ และจะรีเซ็ตเมื่อไหร่** เพื่อให้ตัดสินใจได้ทันทีว่าจะสั่งงานหนักต่อกับ account ไหน

### ต้องตอบคำถามพวกนี้ได้ภายใน 2 วินาทีที่มอง
1. account ไหนใกล้เต็ม limit แล้ว
2. limit ปัจจุบันจะรีเซ็ตอีกกี่นาที/ชั่วโมง
3. ด้วย burn rate ตอนนี้ จะใช้หมดก่อนรีเซ็ตไหม
4. วันนี้/สัปดาห์นี้เผา token กับเงินไปเท่าไหร่ แยกตาม model

### Non-goals (เวอร์ชันแรก)
- ไม่ทำ billing/invoice reconciliation
- ไม่ทำ multi-tenant / SaaS (ใช้ภายในทีมเดียว)
- ไม่ proxy request ของ AI จริง (ไม่ใช่ LLM gateway)

---

## 2. ข้อจำกัดสำคัญที่กำหนดสถาปัตยกรรม (อ่านก่อน)

นี่คือข้อเท็จจริงที่ตรวจสอบจากเครื่องจริงแล้ว และเป็นตัวกำหนดว่าทำไม design ถึงออกมาแบบนี้:

| ผู้ให้บริการ | มี API บอก limit คงเหลือไหม | ความจริง |
|---|---|---|
| **Codex CLI (ChatGPT plan)** | ✅ **มี และแม่นยำ** | ทุกไฟล์ `~/.codex/sessions/**/rollout-*.jsonl` มี event `token_count` ที่แนบ `rate_limits` มาด้วย: `primary` (หน้าต่าง 300 นาที) และ `secondary` (10080 นาที = 7 วัน) พร้อม `used_percent`, `resets_at` (epoch), `plan_type`, `credits.balance` — **นี่คือตัวเลขจริงจาก server** |
| **Claude Desktop app (Pro/Max)** | ✅ **มี และเป็นตัวเลขจริง** | `~/Library/Application Support/Claude/plan-usage-history.json` — แอปเก็บ % การใช้งานของ plan ไว้เองทุก ~15 นาที ย้อนหลัง 30 วัน: `fh` = หน้าต่าง 5 ชม. (0–100), `sd` = หน้าต่าง 7 วัน, `xu` = โควตา extra usage, `org` = UUID ของ account, `t` = epoch ms |
| **Claude บน browser (claude.ai)** | ❌ **ไม่มีอะไรเลยในเครื่อง** | ใช้ผ่าน browser = ไม่มีไฟล์ local ให้อ่าน — ต้องย้าย account นั้นไปรันบน desktop app instance ที่สอง (ดู §4 A2) |
| **Claude Code (CLI / ในแอป)** | ⚠️ token ครบ แต่ไม่มี % | `~/.claude/projects/**/*.jsonl` เก็บ `usage` ต่อ message ครบ (input / output / cache_creation / cache_read / thinking_tokens / model / requestId / timestamp) แต่ **ไม่เก็บ % ที่ใช้ไป** → ใช้เป็นแหล่ง breakdown ต่อ model และ cost ไม่ใช่แหล่ง %. มี ground truth ตอนชนลิมิต: record error ที่มี `"rateLimitType":"five_hour"` |
| **Anthropic API (Console / org)** | ✅ มี | Admin API: `/v1/organizations/usage_report/messages` และ `/v1/organizations/cost_report` (ต้องใช้ Admin key `sk-ant-admin…`) + response header `anthropic-ratelimit-*-remaining` / `-reset` |
| **OpenAI Platform (org)** | ✅ มี | `/v1/organization/usage/completions`, `/v1/organization/costs` (Admin key) |
| **OpenRouter** | ✅ มี | `GET /api/v1/key` คืน usage / limit / limit_remaining |
| **Gemini / Copilot / อื่นๆ** | ⚠️ บางส่วน | Copilot มี org metrics API (ต้อง org admin), Gemini ต้องผ่าน Cloud Monitoring quota metrics |

> **ผลลัพธ์ต่อ design:** ระบบต้องรองรับ "ความน่าเชื่อถือของตัวเลข" เป็น first-class concept ไม่ใช่แสดง % ปนกันแล้วทำเหมือนแม่นเท่ากันหมด → ทุกตัวเลขมี field `confidence`
>
> **แต่ข่าวดี:** เมื่อเจอ `plan-usage-history.json` แล้ว ทั้ง Claude และ Codex ให้ตัวเลข `reported` ได้ทั้งคู่ → ไม่ต้องพึ่ง heuristic calibration เป็นทางหลักอีกต่อไป (ยังเก็บไว้เป็น fallback เท่านั้น)

**ห้ามทำ:** เวอร์ชันแรกจะ **ไม่** ไป scrape หน้าเว็บ claude.ai / chatgpt.com ด้วย headless browser และไม่เรียก private endpoint ที่ไม่ได้ documented — เพราะเปราะ, เสี่ยงผิด ToS, และพังเงียบ (แสดงเลขเก่าโดยไม่รู้ตัว = อันตรายกว่าไม่แสดง)

---

## 3. Core Domain Model

### 3.1 แนวคิดกลาง: `LimitWindow`

ทุกผู้ให้บริการถูก normalize ให้เหลือรูปเดียว:

```ts
type Confidence =
  | 'reported'   // server บอกมาตรงๆ (Codex, OpenRouter, Admin API)
  | 'derived'    // คำนวณจาก log ที่ครบถ้วน (token รวมของ Claude)
  | 'estimated'  // ประมาณจาก budget ที่ calibrate เอง (% ของ Claude 5h)

interface LimitWindow {
  key: 'five_hour' | 'weekly' | 'daily' | 'monthly' | 'credit'
  label: string              // "5-hour session", "Weekly"
  windowMinutes: number      // 300 / 10080
  usedPercent: number | null // 0..100
  usedTokens: number | null
  budgetTokens: number | null
  resetsAt: string | null    // ISO8601
  confidence: Confidence
  hitAt: string | null       // เคยชนลิมิตในหน้าต่างนี้เมื่อไหร่
}

interface AccountState {
  accountId: string          // "claude-personal", "claude-work", "codex-main"
  provider: 'anthropic' | 'openai' | 'openrouter' | 'google' | 'github' | 'custom'
  surface: 'claude-code' | 'codex-cli' | 'api' | 'web'
  displayName: string
  planType: string | null    // "max20", "plus", "team"
  windows: LimitWindow[]
  burn: {
    tokensPerHour: number
    percentPerHour: number | null
    projectedExhaustAt: string | null   // null = ไม่หมดก่อนรีเซ็ต
  }
  spend: { todayUsd: number | null; weekUsd: number | null }
  lastSampleAt: string
  health: 'ok' | 'stale' | 'error' | 'unconfigured'
  errorMessage: string | null
}
```

### 3.2 Storage schema (SQLite)

```
accounts(id, provider, surface, display_name, plan_type, config_json, enabled)
samples(id, account_id, taken_at, windows_json, burn_json, health, error)   -- time series
usage_events(id, account_id, ts, model, input, output, cache_read, cache_write,
             thinking, request_id UNIQUE, session_id, cost_usd)             -- token ละเอียด
limit_hits(id, account_id, ts, window_key, resets_at)                       -- ground truth
calibration(account_id, window_key, observed_max_tokens, p95_tokens, updated_at)
alerts(id, account_id, window_key, threshold, fired_at, resolved_at)
```

`usage_events.request_id UNIQUE` คือหัวใจของการกัน double-count เวลา re-scan ไฟล์ JSONL ซ้ำ

---

## 4. Adapter Specifications

Adapter ทุกตัว implement interface เดียว:

```ts
interface ProviderAdapter {
  id: string
  probe(cfg: AccountConfig): Promise<AccountState>
  watch?(cfg: AccountConfig, onChange: () => void): Disposable  // file watcher
}
```

### A1. `codex-local` — ความสำคัญสูงสุด (ได้ตัวเลขจริง)

- **อ่าน:** ไฟล์ `rollout-*.jsonl` ที่ใหม่ที่สุดใน `$CODEX_HOME/sessions/YYYY/MM/DD/` (default `~/.codex`)
- **ดึง:** บรรทัดสุดท้ายที่ `payload.type === "token_count"` → `payload.rate_limits`
- **Map:**
  - `primary` → `LimitWindow{ key:'five_hour', windowMinutes:300, usedPercent, resetsAt: epoch→ISO, confidence:'reported' }`
  - `secondary` → `LimitWindow{ key:'weekly', windowMinutes:10080, … }`
  - `credits.balance` → `LimitWindow{ key:'credit' }` ถ้า `has_credits`
  - `plan_type` → `AccountState.planType`
- **token รวม:** `payload.info.total_token_usage` ต่อ session
- **ข้อควรระวัง:** ตัวเลขจะ "ค้าง" ถ้าไม่มี session รันอยู่ → ต้องแสดง age ของ sample และ mark `health='stale'` เมื่อเกิน N นาที (default 30 นาที) เพราะ `resets_at` ยังใช้นับถอยหลังได้ถูกแต่ `used_percent` อาจเก่า
- **Multi-account:** แยกด้วย `CODEX_HOME` คนละ path

### A2. `claude-desktop-plan-usage` — **ตัวหลักของ Claude** (ตัวเลขจริง)

- **อ่าน:** `<CLAUDE_APP_DATA>/plan-usage-history.json` (default `~/Library/Application Support/Claude`)
- **โครงสร้าง (ยืนยันจากเครื่องจริง — 1,851 samples ย้อนหลัง 30 วัน):**
  ```jsonc
  { "version": 2,
    "samples": [
      { "t": 1788230844516,                        // epoch ms
        "org": "f99b3e24-…",                       // UUID ของ account → ใช้แยก account
        "u": { "fh": 74,        // % หน้าต่าง 5 ชั่วโมง
               "sd": 57,        // % หน้าต่าง 7 วัน
               "xu": 100 } }    // โควตา extra usage (โผล่เฉพาะบาง sample)
    ] }
  ```
- **Map:**
  - `fh` → `LimitWindow{ key:'five_hour', windowMinutes:300, usedPercent, confidence:'reported' }`
  - `sd` → `LimitWindow{ key:'weekly', windowMinutes:10080, usedPercent, confidence:'reported' }`
  - `xu` → `LimitWindow{ key:'credit' }` เมื่อมีค่า
  - `org` → account identity (ไม่ต้องเดาจาก path)
- **`resetsAt`:** ไฟล์นี้ **ไม่บอกเวลารีเซ็ต** → ต้อง derive: หา sample ที่ `fh` ตกจากค่าสูงลงมา 0 = จุดเริ่ม block ล่าสุด แล้ว `resetsAt = blockStart + 5h`
  (ตรวจแล้วว่าจับได้จริง — พบ 8 ครั้งใน 30 วันล่าสุด) → `confidence` ของ **countdown** เป็น `derived` แม้ % จะเป็น `reported`
- **Cadence:** แอปเขียนทุก ~15 นาที (median 900 วิ) → poll ไฟล์ทุก 30 วิก็พอ + watch mtime
- **ข้อดีที่ได้ฟรี:** มีประวัติ 30 วันตั้งแต่วันแรกที่เปิดใช้ dashboard ไม่ต้องรอสะสมข้อมูล
- **ข้อควรระวัง:** ค่าจะอัปเดตเฉพาะตอนแอปเปิดอยู่ → ถ้า mtime เก่ากว่า 30 นาที ให้ `health='stale'`

### A2b. `claude-code-local` — แหล่ง breakdown (เสริม)

- **อ่าน:** `$CLAUDE_CONFIG_DIR/projects/**/*.jsonl` (default `~/.claude`) — ยืนยันแล้วว่ามี 55 ไฟล์
- **หน้าที่ใหม่:** ไม่ใช่แหล่ง % อีกต่อไป แต่เป็นแหล่งของสิ่งที่ `plan-usage-history.json` ไม่มี:
  - token แยกตาม model / project / session
  - cost เป็น USD (คูณกับตารางราคา)
  - จุดที่ชนลิมิตจริง (record `rateLimitType`) → เอาไว้ยืนยันว่า `fh` แตะ 100 จริง
- **แยกแต่ละบรรทัด** ที่ `type === "assistant"` → เก็บ `timestamp`, `requestId`, `message.model`, `message.usage.*`
- **Dedupe:** `requestId` (unique constraint ที่ DB) · **Incremental read:** เก็บ byte offset ต่อไฟล์ + `chokidar` watch
- **หมายเหตุ:** ไฟล์เหล่านี้ครอบคลุมเฉพาะ Claude Code (ทั้งจาก CLI และจากในแอป — ตรวจแล้วพบ `entrypoint` เป็น `claude-desktop` 39,894 records และ `cli` 5,198 records) **ไม่ครอบคลุมแชทธรรมดา** ในแอปหรือบนเว็บ

### A2c. Multi-account ของ Claude — วิธีที่ใช้ได้จริง

Claude.app เป็น Electron และ Electron Framework รองรับ `--user-data-dir` (ตรวจแล้ว) → รัน instance ที่สองแยก profile:

```bash
open -na Claude --args --user-data-dir="$HOME/Library/Application Support/Claude-b"
```

ผลที่ควรได้: โฟลเดอร์ `Claude-b/` ที่มี `plan-usage-history.json` ของตัวเอง และ `org` UUID คนละตัว
→ dashboard เห็นเป็นคนละการ์ดโดยอัตโนมัติ ไม่ต้องตั้งค่าอะไรเพิ่มนอกจากชี้ path

**ต้องทดสอบก่อน** — `app.asar` มีการอ้างถึง `userDataDir` อยู่ 2 จุด จึงมีโอกาสที่แอปจะ pin path ไว้เอง
ถ้าไม่ผ่าน ทางเลือกรอง:
1. ทำสำเนา `.app` แล้วแก้ `CFBundleIdentifier` (วิธีเดียวกับที่ทำให้มี `ChatGPT 2.app` อยู่แล้ว)
2. ใช้ `POST /api/ingest` + userscript ฝั่ง browser (fragile — ทางเลือกสุดท้าย)

**สิ่งที่ทำไม่ได้:** ถ้า account ที่สองอยู่บน browser อย่างเดียว จะไม่มีข้อมูลใดๆ ให้อ่านในเครื่อง

### A3. `anthropic-admin-api` (official, สำหรับ account แบบ API/org)
- `GET /v1/organizations/usage_report/messages?starting_at=…&bucket_width=1h`
- `GET /v1/organizations/cost_report`
- Header: `x-api-key: sk-ant-admin…`, `anthropic-version: 2023-06-01`
- `confidence: 'reported'` · ให้ค่า cost จริงเป็น USD

### A4. `anthropic-ratelimit-headers` (สำหรับ API key ธรรมดา)
- ยิง request จิ๋ว (`max_tokens: 1`) แล้วอ่าน header `anthropic-ratelimit-{requests,tokens,input-tokens,output-tokens}-{limit,remaining,reset}`
- ราคาถูกมาก แต่ **มีต้นทุน** → default ปิด, poll ไม่ถี่กว่า 5 นาที

### A5. `openai-admin-api`
- `/v1/organization/usage/completions`, `/v1/organization/costs` (Admin key)

### A6. `openrouter`
- `GET /api/v1/key` → `usage`, `limit`, `limit_remaining`, `is_free_tier`
- `GET /api/v1/credits`

### A7. `manual` (fallback สำหรับเจ้าอื่นๆ)
- ให้กรอก budget + เผยแพร่ endpoint `POST /api/ingest` ให้ script ภายนอกส่งตัวเลขเข้ามาเอง
- ครอบคลุม Gemini, DeepSeek, Groq, Cursor ฯลฯ โดยไม่ต้องเขียน adapter ใหม่ทุกเจ้า

### ลำดับความสำคัญในการทำ
`claude-desktop-plan-usage` → `codex-local` → `claude-code-local` (breakdown) → `manual/ingest` → `openrouter` → `anthropic-admin` → `openai-admin` → `ratelimit-headers`

---

## 5. UI Spec

### 5.1 Wall view (หน้าหลัก, default)

```
┌─────────────────────────────────────────────────────────────────┐
│  AI USAGE            เผาวันนี้ 2.4M tok · $18.30   14:32:07     │  ← header 8vh
├───────────────┬───────────────┬───────────────┬─────────────────┤
│ CLAUDE        │ CLAUDE        │ CODEX         │ OPENROUTER      │
│ personal·max20│ work·max20    │ main·plus     │ api             │
│               │               │               │                 │
│    ◕ 72%      │    ◔ 23%      │    ◕ 68%      │   $12.40        │
│   5h session  │   5h session  │   5h session  │   remaining     │
│ ▓▓▓▓▓▓▓░░░    │ ▓▓░░░░░░░░    │ ▓▓▓▓▓▓▓░░░    │ ▓▓▓▓▓▓░░░░      │
│               │               │               │                 │
│ reset 1:48    │ reset 4:12    │ reset 0:23    │ monthly         │
│ ~เต็ม 15:10 ⚠ │ ปลอดภัย       │ ปลอดภัย       │                 │
│ week ▓▓▓░ 41% │ week ▓░░░ 12% │ week ▓▓░░ 28% │                 │
│ ▁▂▅▇▆▃▂▁ burn │ ▁▁▂▁▁▁▂▁      │ ▂▅▇▇▅▂▁▁      │                 │
│ est.  ·  2m   │ est.  ·  2m   │ reported · 9s │ reported · 1m   │
└───────────────┴───────────────┴───────────────┴─────────────────┘
```

**องค์ประกอบต่อการ์ด**
| ส่วน | รายละเอียด |
|---|---|
| Ring gauge | หน้าต่างหลัก (5h) — ตัวเลขใหญ่สุดในการ์ด อ่านได้จาก 3 เมตร |
| แถบ weekly | หน้าต่างรอง แสดงเป็น bar บาง |
| Countdown | นับถอยหลังถึง `resetsAt` เป็น `H:MM` เดินทุกวินาที (client-side) |
| Projection | ถ้า `projectedExhaustAt < resetsAt` → เตือน "~เต็ม HH:MM" สีส้ม |
| Sparkline | burn rate 60 นาทีล่าสุด |
| Footer badge | `confidence` + อายุของ sample — **บังคับต้องมี** ห้ามซ่อน |

**สี** (สำคัญกับ wallboard)
- 0–59% เขียว · 60–79% เหลือง · 80–94% ส้ม · 95–100% แดง + กระพริบช้า
- `stale` → การ์ดหรี่ลง 40% + ไอคอนนาฬิกา
- `error` / `unconfigured` → เทา + ข้อความสั้นๆ ว่าต้องทำอะไร
- ธีมมืดเป็น default (จอเปิดตลอด), คอนทราสต์ตาม WCAG AA, ไม่พึ่งสีอย่างเดียว (มีไอคอน/ข้อความกำกับ)

### 5.2 Layout rules
- Grid auto-fit `minmax(320px, 1fr)` — 2 accounts ก็สวย 8 accounts ก็สวย
- **ห้าม scroll** ในโหมด wall — ถ้าการ์ดเยอะเกิน ให้ย่อขนาดฟอนต์เป็นขั้นๆ หรือสลับหน้าอัตโนมัติทุก 20 วิ
- รองรับ 1080p / 1440p / 4K แนวนอน + แนวตั้ง

### 5.3 Detail view (`/account/[id]`)
กราฟ token ต่อชั่วโมง 7 วัน · breakdown ตาม model · ตาราง session ล่าสุด · ประวัติ limit hits · cost

### 5.4 Settings (`/settings`)
เพิ่ม/ลบ account · ตั้ง path (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`) · ตั้ง budget เอง · threshold แจ้งเตือน · webhook · ปุ่ม "Test connection" ที่บอกชัดว่า adapter อ่านไฟล์ได้กี่ไฟล์/เจอ record ล่าสุดเมื่อไหร่

---

## 6. Non-functional requirements

| ด้าน | เกณฑ์ |
|---|---|
| Refresh | UI อัปเดตทุก 10 วิผ่าน SSE · re-scan ไฟล์เมื่อ file watcher ยิง หรืออย่างช้าทุก 60 วิ |
| Latency | เปลี่ยนแปลงจริง → ขึ้นจอภายใน 15 วิ |
| Cold start | สแกน JSONL ครั้งแรก (55 ไฟล์) < 5 วิ · ครั้งถัดไป incremental < 200ms |
| ทนทาน | adapter ตัวหนึ่งพัง → ตัวอื่นต้องยังแสดงผลปกติ (การ์ดนั้นขึ้น error) |
| Uptime | รันเป็น service ผ่าน launchd, auto-restart, รอด reboot |
| ความปลอดภัย | bind `127.0.0.1` เป็น default · ถ้าเปิด LAN ต้องมี bearer token · API key เก็บใน `.env.local` (gitignored) หรือ macOS Keychain · อ่านไฟล์แบบ read-only เท่านั้น |
| ความเป็นส่วนตัว | ไม่ส่งข้อมูลออกนอกเครื่อง ยกเว้น webhook ที่ user ตั้งเอง · ไม่เก็บเนื้อหา prompt/response ลง DB (เก็บแค่ตัวเลข token) |
| ความซื่อสัตย์ของตัวเลข | ถ้า sample เก่ากว่า threshold หรือ calibrate ไม่พอ → **แสดงว่าไม่รู้** ห้ามเดา % |

---

## 7. Tech stack

| ชั้น | เลือก | เหตุผล |
|---|---|---|
| Framework | **Next.js 16 App Router + TypeScript** (Node runtime, Fluid Compute) | route handler ทำ SSE ได้บน Node runtime, UI + API ในโปรเจกต์เดียว |
| UI | Tailwind CSS + shadcn/ui | คุมธีมมืด/คอนทราสต์ได้ไว |
| Charts | Recharts (sparkline/bar) + ring gauge เขียน SVG เอง | ring ต้องคุม typography เองเพื่อ wallboard |
| DB | **SQLite + better-sqlite3 + Drizzle ORM** | local-first, sync read เร็ว, ไฟล์เดียวย้ายง่าย |
| File watch | chokidar | JSONL append-only |
| Validation | zod | schema ของ log ผู้ให้บริการเปลี่ยนได้ ต้อง fail ดังๆ |
| Scheduler | `instrumentation.ts` + setInterval (in-process) | ไม่ต้องมี process แยกตอนรัน local |
| Runtime | Node 24 (เครื่องนี้ v24.14.0 ✓), npm | ตรงกับที่ติดตั้งอยู่ |
| Packaging | launchd plist + Chrome `--kiosk` | เปิดจอทิ้งไว้ |

**ไม่เลือก Postgres/Vercel deploy ในเฟสแรก** เพราะข้อมูลต้นทางอยู่บน filesystem ของเครื่อง — deploy ขึ้น cloud แล้วจะอ่าน `~/.claude` ไม่ได้ (ดู §8 ถ้าต้องการ multi-machine)

---

## 8. Deployment topologies

### T1 — Single machine (แนะนำ, เฟสแรก)
```
[Mac] ── Next.js :4000 ── SQLite ── Chrome kiosk (จอมอนิเตอร์)
         └─ อ่าน ~/.claude, ~/.codex โดยตรง
```

### T2 — Multi-machine (เฟสหลัง)
```
[Mac A] collector ─┐
[Mac B] collector ─┼─→ POST /api/ingest (bearer token) → [Home server] Next.js + SQLite → จอ
[Linux] collector ─┘
```
collector = ไบนารีเล็กๆ (`npm run collect -- --push https://…`) reuse adapter ชุดเดิม 100%

### T3 — Cloud UI (เฉพาะกรณีดูจากนอกบ้าน)
Vercel + Neon Postgres, collector push เข้ามา — ทำก็ต่อเมื่อจำเป็นจริง เพราะเพิ่ม attack surface กับข้อมูลการใช้งานภายใน

---

## 9. Risks & mitigations

| ความเสี่ยง | ผลกระทบ | ทางรับมือ |
|---|---|---|
| Anthropic/OpenAI เปลี่ยน schema ของ log | adapter พังเงียบ | zod validate ทุก record + ถ้า parse ไม่ผ่าน > 5% ให้การ์ดขึ้น `error` ไม่ใช่แสดงเลขผิด |
| % ของ Claude เป็นค่าประมาณ | user เชื่อเลขผิดแล้ววางแผนพลาด | badge `estimated` บังคับแสดง + โหมด "calibrating" ที่โชว์ token ดิบแทน % |
| Codex `used_percent` ค้างเมื่อไม่มี session | เห็นเลขเก่า | mark `stale` ตามอายุ sample + หรี่การ์ด |
| Account ที่สองอยู่บน browser อย่างเดียว | ไม่มีข้อมูลให้อ่าน | ย้ายไป desktop instance ที่สองด้วย `--user-data-dir` (ดู A2c) — ถ้าทำไม่ได้ การ์ดนั้นขึ้น `unconfigured` ตรงๆ |
| `plan-usage-history.json` เป็น internal format ของแอป | schema เปลี่ยนได้ทุกเวอร์ชัน | `version` field มีอยู่แล้ว (ตอนนี้ = 2) → เช็คก่อน parse ถ้าไม่รู้จักให้ขึ้น error พร้อมบอกเวอร์ชันที่เจอ · `claude-code-local` ยังทำงานต่อได้เป็น fallback |
| แอป Claude ปิดอยู่ | ตัวเลขไม่อัปเดต | เทียบ mtime ของไฟล์ → `stale` |
| JSONL โตขึ้นเรื่อยๆ | สแกนช้า | byte-offset incremental + prune `usage_events` เก่ากว่า 90 วันเป็น rollup รายชั่วโมง |
| นาฬิกา/timezone เพี้ยน | countdown ผิด | เก็บทุกอย่างเป็น UTC, render เป็น local ที่ client เท่านั้น |
| API key รั่ว | เสียหายจริง | bind localhost, `.env.local` gitignored, ไม่ log ค่า key, มี redaction ใน error message |
