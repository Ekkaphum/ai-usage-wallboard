# แยกจอออกจากเครื่องทำงาน

เอา wallboard ไปขึ้นเครื่องที่**ไม่ได้ล็อกอิน** account ไหนเลย

```
Mac / เครื่องที่ล็อกอินจริง              Windows mini PC (จอ)
┌──────────────────────────┐          ┌──────────────────────────┐
│ Claude.app  ×2 profile   │          │  next start :4000        │
│ Codex CLI                │          │  0.0.0.0 (LAN)           │
│                          │          │                          │
│ scripts/collect.ts       │──POST──▶ │  /api/ingest             │
│  probeAll() ทุก 60 วิ     │  Bearer  │       ↓                  │
│  launchd KeepAlive       │  token   │  kiosk เต็มจอ             │
└──────────────────────────┘          └──────────────────────────┘
  มี credential                          ไม่มี credential เลย
```

## ทำไมต้อง push ไม่ใช่ pull

โควต้าของ subscription (Claude Pro/Max, ChatGPT Plus) **ไม่มี public API** ตัวเลข
เหล่านั้นเกิดจากแอปคำนวณแล้วเขียนลงไฟล์ในเครื่องตัวเอง ไม่มี endpoint ไหนบน
อินเทอร์เน็ตที่ตอบได้ว่า "5-hour limit เหลือกี่ %"

เครื่องที่ล็อกอินอยู่จึงเป็นเครื่องเดียวที่รู้ และต้องเป็นฝ่ายส่ง

ผลพลอยได้คือความปลอดภัย: **สิ่งที่วิ่งข้ามเน็ตคือตัวเลขสำเร็จรูป ไม่ใช่ credential**
เครื่องจอไม่เคยเห็น token — ใครยึดเครื่องจอไปก็ได้แค่ %

## ติดตั้ง

### 1. สร้าง token ร่วม (ทำที่เครื่อง Mac)

```bash
echo "INGEST_TOKEN=$(openssl rand -hex 24)" >> .env.local
grep INGEST_TOKEN .env.local
```

ค่านี้ต้องเหมือนกันทั้งสองเครื่อง ถ้าไม่ตรง ingest จะตอบ 401

### 2. เครื่องจอ (Windows) — บรรทัดเดียว

เครื่องเปล่าๆ ไม่ต้องลงอะไรมาก่อน เปิด PowerShell ธรรมดาแล้ววาง:

```powershell
irm https://raw.githubusercontent.com/Ekkaphum/ai-usage-wallboard/main/deploy/windows/bootstrap.ps1 | iex
```

ลง git ให้ถ้ายังไม่มี → clone ไป `C:\ai-wallboard` → เรียก `install.ps1` ต่อ

`install.ps1` ยกสิทธิ์ตัวเองเป็น Administrator และถามแค่สองอย่าง — token กับ IP
ของเครื่อง Mac (เอาไว้จำกัด firewall) นอกนั้นจัดการเองหมด:

| ทำอะไร | ทำไม |
|---|---|
| ติดตั้ง Node 20+ ถ้ายังไม่มี (winget) | — |
| `npm ci` + `npm run build` | — |
| เขียน `config/accounts.json` = `{"accounts": []}` | ถ้าไม่มีไฟล์นี้ แอปจะ fallback ไปหา path ของ macOS แล้วขึ้นการ์ดพัง 3 ใบ |
| เขียน `.env.local` พร้อม `WALLBOARD_READONLY=1` | ทุกอย่างบนจอมาจากที่อื่น จึงไม่ควรแก้จาก browser บน LAN ได้ |
| firewall inbound TCP 4000 จำกัด remote address | กันไม่ให้ทั้งวงเห็น |
| scheduled task `AI Wallboard Server` (at startup, SYSTEM) | ขึ้นเองหลังไฟดับ |
| scheduled task `AI Wallboard Kiosk` (at logon) | เปิดเต็มจอเอง |
| `powercfg` monitor/standby/hibernate = 0 | จอไม่ดับ |
| ยิงทดสอบ `/api/ingest` ด้วย token ตัวเอง | token ไม่ตรงคือสาเหตุที่ระบบดูเหมือนตายเงียบบ่อยที่สุด — จับตั้งแต่ตอนติดตั้ง |
| เปิด kiosk เต็มจอ | — |

จบแล้วจะพิมพ์คำสั่งที่ต้องไปรันบนเครื่อง Mac ออกมาให้ครบ พร้อม IP จริง

### 3. เครื่อง Mac

```bash
./deploy/collector/install-collector.sh http://192.168.1.50:4000
```

จะทดสอบ push หนึ่งครั้งก่อน แล้วค่อยติดตั้ง launchd agent ที่ยิงทุก 60 วินาที

## ตรวจว่าใช้ได้

```bash
tail -f data/collector.log
```

```
16:15:40 ส่งแล้ว 3/3 → http://192.168.1.50:4000  ·  Claude · ส่วนตัว 2%  ·  Claude · Bluesharp 18%  ·  Codex 91%
```

ฝั่งจอ เช็คว่ารับครบ:

```powershell
(Invoke-WebRequest http://127.0.0.1:4000/api/state).Content | ConvertFrom-Json | % externalCount
```

## ถ้า collector ตาย

การ์ด **ไม่หาย** — หลัง 5 นาทีที่ไม่มีข้อมูลใหม่ การ์ดจะเปลี่ยนเป็นสถานะ `stale`
พร้อมข้อความว่า "ไม่ได้รับข้อมูลจากเครื่องเก็บมา N นาที — ตัวเลขนี้ค้างอยู่"
และจะหายไปจริงก็ต่อเมื่อเงียบครบ 24 ชั่วโมง

ตั้งใจให้ห่างกันขนาดนี้ เพราะจอที่เหลือศูนย์ใบดูเหมือนวันที่ไม่ได้ใช้งาน
แยกไม่ออกจาก collector ตาย — เก็บการ์ดไว้แล้วบอกว่าค้าง ทำให้ความพังมองเห็นได้

## ข้อจำกัดที่ควรรู้

- **แอป Claude ต้องเปิดค้างบนเครื่อง Mac** ไม่งั้น `plan-usage-history.json`
  จะไม่ถูกเขียน (เขียนทุก 15 นาทีเฉพาะตอนแอปเปิด) — ส่วน Codex/Claude Code
  เขียน log ทุกครั้งที่ใช้อยู่แล้ว
- **การเชื่อมต่อเป็น HTTP ไม่ใช่ HTTPS** token จึงวิ่งเป็น plaintext บน LAN
  ถือว่ารับได้บนวงบ้าน เพราะสิ่งที่ token ทำได้คือ "ส่งตัวเลขปลอมขึ้นจอตัวเอง"
  ไม่ได้เข้าถึงอะไรของ account จริง ถ้าจะรัดกุมกว่านี้ให้วางหลัง reverse proxy
  ที่มี TLS
- **ประวัติย้อนหลังไม่ตามไปด้วย** เครื่องจอเริ่มจาก DB ว่าง sparkline จะค่อยๆ
  ก่อตัวเอง ถ้าอยากได้ของเก่าไปด้วยใช้ `/api/export` จากเครื่องเดิม
- เครื่องจอบันทึกทุกอย่างที่รับเข้ามาลง DB ตัวเอง จึงมี history ของมันเอง
  แม้จะไม่เคยอ่านไฟล์อะไรเลย

## อัปเดตทีหลัง

เครื่องจอ:

```powershell
.\deploy\windows\update.ps1
```

`git pull` + rebuild + restart โดยไม่แตะ `config/accounts.json` กับ `.env.local`
(ทั้งคู่อยู่ใน `.gitignore`) ถ้า build พัง server ตัวเก่ายังรันอยู่ ไม่ล้ม

เครื่อง Mac:

```bash
git pull && npm ci && launchctl kickstart -k "gui/$UID/com.local.aiwallboard-collector"
```

## ถอนออก

```powershell
.\deploy\windows\uninstall.ps1 -RestorePowerDefaults
```

```bash
launchctl bootout "gui/$UID/com.local.aiwallboard-collector"
```
