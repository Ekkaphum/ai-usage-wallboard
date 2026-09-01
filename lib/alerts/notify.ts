import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Alert } from './index'
import type { AlertChannel } from './config'

const run = promisify(execFile)

/** Never let a slow or dead webhook hold up the next probe. */
const WEBHOOK_TIMEOUT_MS = 8_000

function line(alert: Alert): string {
  const reset = alert.resetsAt
    ? ` · รีเซ็ต ${new Date(alert.resetsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : ''
  const hedge = alert.confidence === 'estimated' ? ' (ประมาณ)' : ''
  return `${alert.displayName} — ${alert.windowLabel} ${Math.round(alert.usedPercent)}%${hedge}${reset}`
}

function summary(alerts: Alert[]): { title: string; body: string } {
  const worst = Math.max(...alerts.map((a) => a.usedPercent))
  return {
    title: alerts.length === 1
      ? `AI usage ${Math.round(worst)}%`
      : `AI usage — ${alerts.length} รายการถึงเกณฑ์`,
    body: alerts.map(line).join('\n'),
  }
}

/**
 * HTTP header values are ByteStrings, so a Thai account name or an em dash
 * throws when it reaches `fetch`. RFC 2047 encoded-words are the standard way
 * to carry UTF-8 in a header, and ntfy decodes them.
 */
export function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

function payloadFor(channel: Extract<AlertChannel, { kind: 'webhook' }>, alerts: Alert[]): { body: string; headers: Record<string, string> } {
  const { title, body } = summary(alerts)
  switch (channel.format) {
    case 'slack':
      return { body: JSON.stringify({ text: `*${title}*\n${body}` }), headers: { 'content-type': 'application/json' } }
    case 'discord':
      return { body: JSON.stringify({ content: `**${title}**\n${body}` }), headers: { 'content-type': 'application/json' } }
    case 'ntfy':
      // ntfy takes the message as the raw body and everything else as headers.
      return {
        body,
        headers: {
          Title: encodeHeader(title),
          Priority: alerts.some((a) => a.usedPercent >= 90) ? 'high' : 'default',
        },
      }
    default:
      return { body: JSON.stringify({ title, body, alerts }), headers: { 'content-type': 'application/json' } }
  }
}

async function sendWebhook(channel: Extract<AlertChannel, { kind: 'webhook' }>, alerts: Alert[]): Promise<void> {
  const { body, headers } = payloadFor(channel, alerts)
  const response = await fetch(channel.url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
}

async function sendMacos(alerts: Alert[]): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('macOS notifications need darwin')
  const { title, body } = summary(alerts)
  // Passed as argv, not interpolated into a shell string, so account names
  // containing quotes cannot break out of the script.
  await run('osascript', [
    '-e',
    'on run {t, b}\ndisplay notification b with title t\nend run',
    title,
    body,
  ], { timeout: WEBHOOK_TIMEOUT_MS })
}

/**
 * Fans out to every enabled channel. One channel failing must not stop the
 * others, and no failure here may take down the probe loop that called us.
 */
export async function deliver(alerts: Alert[], channels: AlertChannel[]): Promise<void> {
  await Promise.all(channels.map(async (channel) => {
    try {
      if (channel.kind === 'webhook') await sendWebhook(channel, alerts)
      else await sendMacos(alerts)
      console.log(`[alerts] sent ${alerts.length} alert(s) via ${channel.id}`)
    } catch (error) {
      console.error(`[alerts] channel "${channel.id}" failed:`, error instanceof Error ? error.message : error)
    }
  }))
}
