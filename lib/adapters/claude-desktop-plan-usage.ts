import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ProviderAdapter } from './types'
import { UnknownSchemaError } from './types'
import type { AccountConfig } from '@/lib/config'
import { expandHome, DEFAULT_CLAUDE_APP_DATA } from '@/lib/domain/paths'
import {
  type AccountState, type LimitWindow, STALE_AFTER_MS,
  emptyBurn, makeWindow, unconfigured,
} from '@/lib/domain/types'
import { findCurrentBlock, deriveReset, percentPerHour, type PercentPoint } from '@/lib/calc/blocks'
import { claudeIdentityDirectory, desktopProfileAccountUuid, withDeclaredFallback, type AccountIdentity } from '@/lib/identity'

/**
 * Reads the plan usage history the Claude desktop app maintains for its own
 * /usage screen. This is the only local source that carries Anthropic's actual
 * percentages for a subscription account, which is why it is the primary Claude
 * adapter rather than the Claude Code token logs.
 *
 *   ~/Library/Application Support/Claude/plan-usage-history.json
 *   { version: 2, samples: [ { t, org, u: { fh, sd, xu? } } ] }
 *
 *   fh  percent of the 5-hour window consumed (0-100)
 *   sd  percent of the 7-day window consumed (0-100)
 *   xu  extra-usage quota *remaining* (0-100), only present on some samples
 *
 * The file is append-only, written roughly every 15 minutes while the app runs,
 * and retains about 30 days.
 */

const SampleSchema = z.object({
  t: z.number(),
  org: z.string(),
  u: z.object({
    fh: z.number(),
    sd: z.number(),
    xu: z.number().optional(),
  }),
})

const FileSchema = z.object({
  version: z.number(),
  samples: z.array(SampleSchema),
})

export type PlanUsageSample = z.infer<typeof SampleSchema>

const SUPPORTED_VERSION = 2
export const PLAN_USAGE_FILE = 'plan-usage-history.json'

/** The series the block maths runs on: 5-hour percentage over time. */
export function fivePercentSeries(samples: PlanUsageSample[]): PercentPoint[] {
  return samples.map((s) => ({ t: s.t, percent: s.u.fh }))
}

function readFile(dir: string) {
  const file = join(dir, PLAN_USAGE_FILE)
  if (!existsSync(file)) return null
  const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
  const version = (raw as { version?: unknown })?.version
  if (version !== SUPPORTED_VERSION) throw new UnknownSchemaError(file, version)
  const parsed = FileSchema.safeParse(raw)
  if (!parsed.success) throw new UnknownSchemaError(file, `version ${version} but unexpected shape: ${parsed.error.issues[0]?.message}`)
  return { file, mtimeMs: statSync(file).mtimeMs, data: parsed.data }
}

export function buildState(
  cfg: AccountConfig,
  org: string,
  samples: PlanUsageSample[],
  now: number,
  multipleOrgs: boolean,
  identity: (AccountIdentity & { verified: boolean }) | null = null,
): AccountState {
  const last = samples[samples.length - 1]
  const series = fivePercentSeries(samples)
  const block = findCurrentBlock(series)

  const windows: LimitWindow[] = []

  const fiveHour = makeWindow({
    key: 'five_hour',
    label: '5-hour session',
    windowMinutes: 300,
    usedPercent: last.u.fh,
    confidence: 'reported',
  })
  if (block) {
    // The newest sample is by definition inside the block, so the window
    // cannot already have reset before it.
    const reset = deriveReset(block, last.t)
    fiveHour.resetsAt = new Date(reset.at).toISOString()
    fiveHour.resetConfidence = 'derived'
    fiveHour.resetUncertaintyMs = reset.uncertaintyMs
    fiveHour.note = reset.exact
      ? 'Reset time is inferred — the file records no reset — but the block start falls inside one hour, so it lands exactly.'
      : 'Reset time is inferred, and the block start straddles an hour boundary, so it may be an hour out.'
  } else if (last.u.fh <= 0) {
    fiveHour.note = 'No active block — the window is empty.'
  } else {
    fiveHour.note = 'Not enough history to locate the start of this block.'
  }
  if (last.u.fh >= 100) fiveHour.hitAt = new Date(last.t).toISOString()
  windows.push(fiveHour)

  windows.push(makeWindow({
    key: 'weekly',
    label: 'Weekly',
    windowMinutes: 10080,
    usedPercent: last.u.sd,
    confidence: 'reported',
    hitAt: last.u.sd >= 100 ? new Date(last.t).toISOString() : null,
  }))

  if (last.u.xu != null) {
    windows.push(makeWindow({
      key: 'credit',
      label: 'Extra usage',
      windowMinutes: 0,
      // The file reports quota remaining; the UI everywhere else shows consumption.
      usedPercent: Math.max(0, Math.min(100, 100 - last.u.xu)),
      confidence: 'derived',
      note: 'Derived from the app\'s remaining-quota figure; the direction of this field is inferred, not documented.',
    }))
  }

  const pph = percentPerHour(series, now)
  const burn = emptyBurn()
  burn.percentPerHour = pph
  if (pph != null && pph > 0 && last.u.fh < 100) {
    const hoursLeft = (100 - last.u.fh) / pph
    const exhaustAt = now + hoursLeft * 3_600_000
    const resetMs = fiveHour.resetsAt ? Date.parse(fiveHour.resetsAt) : null
    // Only worth showing when the window would run out before it rolls over.
    if (resetMs == null || exhaustAt < resetMs) {
      burn.projectedExhaustAt = new Date(exhaustAt).toISOString()
    }
  }

  const age = now - last.t
  return {
    accountId: org,
    configId: cfg.id,
    provider: 'anthropic',
    surface: 'claude-desktop',
    displayName: multipleOrgs ? `${cfg.displayName} (${org.slice(0, 8)})` : cfg.displayName,
    identity: identity && {
      email: identity.email,
      name: identity.name,
      organizationName: identity.organizationName,
      accountUuid: identity.accountUuid,
      organizationUuid: identity.organizationUuid ?? org,
      verified: identity.verified,
    },
    // The plan the account is actually on, rather than one typed into config.
    planType: identity?.organizationType ?? null,
    windows,
    burn,
    spend: { todayUsd: null, weekUsd: null },
    lastSampleAt: new Date(last.t).toISOString(),
    health: age > STALE_AFTER_MS ? 'stale' : 'ok',
    message: age > STALE_AFTER_MS
      ? `Last update ${Math.round(age / 60000)} min ago — the Claude app only writes this file while it is running.`
      : null,
  }
}

export const claudeDesktopPlanUsage: ProviderAdapter = {
  id: 'claude-desktop-plan-usage',

  async probe(cfg: AccountConfig): Promise<AccountState[]> {
    const dir = expandHome(cfg.appDataDir ?? DEFAULT_CLAUDE_APP_DATA)
    const loaded = readFile(dir)

    if (!loaded) {
      return [unconfigured(
        cfg.id, cfg.displayName, 'anthropic', 'claude-desktop',
        [
          `ยังไม่ได้เชื่อมต่อ — ไม่พบ ${PLAN_USAGE_FILE} ใน ${dir}`,
          'account นี้ต้องเปิดผ่าน Claude desktop จึงจะมีข้อมูล (ใช้ผ่าน browser อย่างเดียวจะไม่มีไฟล์ให้อ่าน)',
          `เปิด instance แยก:  open -na Claude --args --user-data-dir="${dir}"`,
        ].join('\n'), cfg.expectedEmail,
      )]
    }

    const now = Date.now()
    const byOrg = new Map<string, PlanUsageSample[]>()
    for (const s of loaded.data.samples) {
      if (cfg.org && s.org !== cfg.org) continue
      const list = byOrg.get(s.org)
      if (list) list.push(s)
      else byOrg.set(s.org, [s])
    }

    if (byOrg.size === 0) {
      return [unconfigured(
        cfg.id, cfg.displayName, 'anthropic', 'claude-desktop',
        cfg.org
          ? `No samples for org ${cfg.org} in ${loaded.file}.`
          : `${loaded.file} has no samples yet.`,
        cfg.expectedEmail,
      )]
    }

    /*
     * The usage file knows the org but not who is signed in. Claude Code's
     * config knows all three ids, so joining on the org — or, failing that, on
     * the account uuid this desktop profile registered — recovers the email.
     */
    const directory = claudeIdentityDirectory(cfg.claudeConfigDir ? [cfg.claudeConfigDir] : [])
    const profileAccountUuid = desktopProfileAccountUuid(dir)

    const multiple = byOrg.size > 1
    return [...byOrg.entries()].map(([org, samples]) => {
      samples.sort((a, b) => a.t - b.t)
      const resolved = directory.get(org)
        ?? (profileAccountUuid ? directory.get(profileAccountUuid) : undefined)
        ?? null
      // A profile signed in only through the desktop app keeps its credentials
      // encrypted, so the address may be unavailable even though the card is
      // fully working. Fall back to what the config declares.
      const identity = withDeclaredFallback(resolved, cfg.expectedEmail, org, profileAccountUuid)
      return buildState(cfg, org, samples, now, multiple, identity)
    })
  },
}
