# AI Usage Wallboard

จอมอนิเตอร์ usage / token limit ของ AI account หลายตัวในที่เดียว

สเปคเต็ม: [docs/SPEC.md](docs/SPEC.md) · แผนงาน: [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)

## สถานะ

| Phase | สถานะ |
|---|---|
| 0 · Scaffold | ✅ |
| 1 · Domain + DB + adapter ที่ให้ตัวเลขจริง + CLI probe | ✅ |
| 2 · Backfill 30 วัน + breakdown ต่อ model | ✅ |
| 3 · API + SSE + Wall UI | ✅ |
| 4 · Alerts + Settings | ✅ |
| 5 · Official API adapters | ✅ |
| 6 · Kiosk packaging | ✅ |
| 7 · Detail view + history | ✅ |

## เริ่มใช้

```bash
npm install
cp config/accounts.example.json config/accounts.json   # แล้วแก้ path ให้ตรงกับเครื่อง
npm run backfill      # ดึงประวัติ 30 วันที่แอป Claude เก็บไว้อยู่แล้ว
npm run dev           # http://localhost:3000
```

เปิดบนจอมอนิเตอร์:

```bash
open -a "Google Chrome" --args --kiosk --app="http://localhost:3000/?kiosk=1"
```

`?kiosk=1` ซ่อนแถบ legend กับ warning ให้เหลือแต่การ์ด

`npm run probe` อ่านทุก account ที่ `enabled` แล้วพิมพ์สถานะออกมา

```
npm run probe                     # ตาราง
npm run probe --silent -- --json  # JSON ล้วน (--silent ตัด banner ของ npm)
npm run probe -- --save           # เขียนลง SQLite ที่ data/wallboard.db ด้วย
npm run backfill                  # import ประวัติ 30 วันจาก plan-usage-history.json
npm run alerts                    # ตรวจว่ามีอะไรถึงเกณฑ์ (--send = ยิงข้อความทดสอบ)
npm run rollup                    # ยุบ event เก่ากว่า 90 วันเป็นสรุปรายชั่วโมง
npm test                          # unit + integration test
```

## หน้าจอ

| หน้า | ทำอะไร |
|---|---|
| `/` | wallboard · `?kiosk=1` ซ่อน legend/nav ให้เหลือแต่การ์ด |
| `/account/[id]` | กราฟ token รายชั่วโมง 7 วัน · แยกตาม model · session ล่าสุด · ประวัติชนลิมิต |
| `/settings` | เปิด/ปิด account, แก้ path, ดูผลตรวจว่าอ่านไฟล์ได้จริงไหม |

## API

| Endpoint | ทำอะไร |
|---|---|
| `GET /api/state` | snapshot ล่าสุด + ประวัติ 6 ชม.สำหรับ sparkline |
| `GET /api/stream` | SSE — ส่ง `snapshot` ทุกครั้งที่ข้อมูลเปลี่ยน + `ping` ทุก 15 วิ |
| `POST /api/ingest` | รับ state ที่ push มาจากเครื่องอื่น ต้องมี `Authorization: Bearer $INGEST_TOKEN` |
| `GET /api/test` | ตรวจว่าแต่ละ account อ่านไฟล์อะไรได้บ้าง เจอกี่ไฟล์ record ล่าสุดเมื่อไหร่ |
| `GET/PUT /api/config` | อ่าน/เขียน `config/accounts.json` (PUT ปิดได้ด้วย `WALLBOARD_READONLY=1`) |
| `GET /api/export?account=` | CSV ของ token รายชั่วโมง 7 วัน |

**Ingest ปิดอยู่โดย default** — ถ้าไม่ได้ตั้ง `INGEST_TOKEN` ใน `.env.local` จะตอบ 401 ทุก request
(fail closed ไม่ใช่ fail open) และ state ที่ push เข้ามาเก็บใน memory มี TTL 10 นาที
หายเมื่อ restart — collector ฝั่งโน้นต้อง push ซ้ำตามรอบของมันเอง

## การแจ้งเตือน

`config/alerts.json` (คัดจาก `.example`) — ไม่มีช่องที่เปิดใช้ = ไม่ส่งอะไรเลย
รองรับ webhook (slack / discord / ntfy / raw) และ notification ของ macOS

แจ้ง **ครั้งเดียวต่อหนึ่งหน้าต่าง** ไม่ใช่ทุกรอบ poll — ใช้เวลารีเซ็ตเป็น key ของหน้าต่างนั้น
block ถัดไปจึงแจ้งได้ใหม่ · เปอร์เซ็นต์ที่ยัง `calibrating` จะไม่ปลุกใคร

## เอาขึ้นจอจริง

```bash
deploy/install.sh    # build + ติดตั้ง launchd agent (RunAtLoad + KeepAlive)
deploy/kiosk.sh      # เปิด Chrome fullscreen + caffeinate กันจอดับ
```

server bind `127.0.0.1` เสมอ — มันอ่าน log ในเครื่องและเขียน config ได้
ถ้าจะเปิดออก LAN ให้ตั้ง `WALLBOARD_READONLY=1` ด้วย

## การอัปเดตหน้าจอ

- probe ใหม่ทุก **60 วินาที** และทันทีที่ file watcher เห็นไฟล์เปลี่ยน (debounce 2 วิ)
- probe เกิดที่ server ครั้งเดียวแล้ว broadcast — เปิด 10 จอกินทรัพยากรเท่าเปิดจอเดียว
- ถ้า SSE หลุด client จะ retry 3 ครั้งแล้วตกไป polling ทุก 15 วิ
  ตัวบอกสถานะมุมขวาบนเปลี่ยนเป็น `polling` หรือ `offline` **จอไม่เคยแสดงเลขเก่าโดยไม่บอก**

## Adapters

| id | อ่านจาก | ความน่าเชื่อถือ |
|---|---|---|
| `claude-desktop-plan-usage` | `<appDataDir>/plan-usage-history.json` | `reported` — % จริงของหน้าต่าง 5 ชม. และ 7 วัน |
| `codex-local` | `<codexHome>/sessions/**/rollout-*.jsonl` | `reported` — ทั้ง % และเวลารีเซ็ตมาจาก server |
| `claude-code-local` | `<claudeConfigDir>/projects/**/*.jsonl` | `derived` (token) / `estimated` (%) — แหล่งของ breakdown ต่อ model และ cost |
| `openrouter` | `GET /api/v1/key` | `reported` — เครดิตคงเหลือ |
| `anthropic-admin` | Usage + Cost Admin API | `reported` — **API traffic ขององค์กร ไม่ใช่โควตา subscription** |
| `openai-admin` | Organization Usage + Costs API | `reported` — **API traffic ไม่ใช่โควตา ChatGPT** |

adapter ที่เรียก API ต้องมี key ใน `.env.local` แล้วชี้ด้วย `apiKeyEnv` ใน config
(ตัว key ไม่เคยถูกเขียนลงไฟล์ config) · ใส่ `baseUrl` เพื่อยิงผ่าน gateway หรือ mock ได้

### `attachTo`

`claude-code-local` ใช้โควตาก้อนเดียวกับ subscription ที่ `claude-desktop-plan-usage` รายงาน
ถ้าใส่ `"attachTo": "claude-personal"` มันจะ**ไม่**สร้างการ์ดแยก แต่จะเอา cost กับ model breakdown
ไปรวมกับการ์ดนั้นแทน — ตัดใส่ค่านี้ออกเมื่อไหร่ มันจะกลายเป็นการ์ดของตัวเองที่มี % แบบ `estimated`

เพิ่ม provider ใหม่ = เขียนไฟล์เดียวใน `lib/adapters/` ที่ implement `ProviderAdapter`
แล้วลงทะเบียนใน `lib/adapters/index.ts` — ไม่ต้องแก้ core

### ข้อจำกัดที่ต้องรู้

- **เวลารีเซ็ตของ Claude เป็นค่าที่ derive เอง** ไฟล์ของแอปบอกแค่ % ไม่ได้บอกเวลา
  ระบบหาจุดเริ่ม block จากจังหวะที่ `fh` ตกลงมา 0 → คลาดเคลื่อนได้ประมาณ ±7 นาที
  (ตัวเลข % ยังเป็น `reported` เต็มร้อย — badge บนการ์ดแยกสองอย่างนี้)
- **แอป Claude ต้องเปิดอยู่** ถึงจะเขียนไฟล์ ถ้าเงียบเกิน 30 นาที account จะขึ้น `stale`
- **account ที่ใช้ผ่าน browser จะไม่มีข้อมูลเลย** ต้องเปิดใน desktop app instance ของตัวเอง:
  ```bash
  open -na Claude --args --user-data-dir="$HOME/Library/Application Support/Claude-b"
  ```
- **สอง account ห้ามชี้ path เดียวกัน** — `validateConfig()` จะ error ให้ตั้งแต่ตอน probe
- **`claude-code-local` เห็นเฉพาะ Claude Code** ทั้งจาก CLI และจากในแอป — แชทธรรมดาไม่ถูกบันทึกที่นี่
  ตัวเลข cost จึงเป็นของ Claude Code เท่านั้น ไม่ใช่ทั้ง account
- **ราคาอยู่ที่ [config/pricing.json](config/pricing.json)** ไม่ได้ hardcode ในโค้ด
  model ที่ไม่มีราคาจะถูก**ตัดออกจาก cost แล้วขึ้นข้อความบอก** ไม่ใช่คิดเป็น 0

## โครงสร้าง

```
lib/domain/     types กลาง — LimitWindow, AccountState, Confidence
lib/adapters/   ตัวอ่านของแต่ละ provider + registry
lib/calc/       block math, pricing, budget calibration (+ unit tests)
lib/alerts/     threshold evaluation + delivery channels
lib/reports/    account detail queries, CSV, rollup
lib/diagnose.ts ตรวจว่า config แต่ละอันอ่านอะไรได้จริง
deploy/         launchd plist, kiosk script, Dockerfile
lib/backfill.ts import ประวัติจาก plan-usage-history.json
lib/db/         drizzle schema, migrations, snapshot recorder
lib/config.ts   โหลดและ validate config/accounts.json
lib/probe.ts    รันทุก adapter (ตัวหนึ่งพังไม่ทำให้ตัวอื่นพัง)
scripts/probe.ts  CLI
```

ฐานข้อมูลอยู่ที่ `data/wallboard.db` (gitignored) · migration สร้างด้วย `npx drizzle-kit generate`
