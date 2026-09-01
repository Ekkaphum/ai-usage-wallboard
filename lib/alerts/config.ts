import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'

const ChannelSchema = z.discriminatedUnion('kind', [
  z.object({
    id: z.string().min(1),
    kind: z.literal('webhook'),
    format: z.enum(['slack', 'discord', 'ntfy', 'raw']).default('raw'),
    url: z.string().url(),
    enabled: z.boolean().default(false),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal('macos'),
    enabled: z.boolean().default(false),
  }),
])

export type AlertChannel = z.infer<typeof ChannelSchema>

const AlertConfigSchema = z.object({
  thresholds: z.array(z.number().min(1).max(100)).default([70, 90]),
  channels: z.array(ChannelSchema).default([]),
})

export type AlertConfig = z.infer<typeof AlertConfigSchema>

export const ALERTS_PATH = resolve(/* turbopackIgnore: true */ process.cwd(), 'config/alerts.json')

/** No config file means no channels, which means nothing is ever sent. */
const NONE: AlertConfig = { thresholds: [70, 90], channels: [] }

export function loadAlertConfig(path = ALERTS_PATH): AlertConfig {
  if (!existsSync(path)) return NONE
  const parsed = AlertConfigSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
  if (!parsed.success) {
    console.error(`[alerts] ignoring invalid ${path}:\n${z.prettifyError(parsed.error)}`)
    return NONE
  }
  return parsed.data
}
