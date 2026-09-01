import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { expandHome } from '@/lib/domain/paths'

/**
 * Works out *which* account a card is actually showing.
 *
 * A card's title is whatever label the config gives it, which says nothing
 * about the account behind it — two cards can read "personal" and "main" while
 * belonging to entirely different logins. This resolves the real identity from
 * the credentials already on disk so the board can show it.
 *
 * Only identifying claims are ever read out of these files. Tokens and API keys
 * are never returned, stored, or logged, and nothing here leaves the machine.
 */

export interface AccountIdentity {
  email: string | null
  name: string | null
  organizationName: string | null
  organizationType: string | null
  accountUuid: string | null
  organizationUuid: string | null
  /** Which file this came from, so the settings page can explain itself. */
  source: string
}

/** Claims we are willing to lift out of a token. Everything else is ignored. */
const ALLOWED_CLAIMS = ['email', 'name'] as const

/**
 * Reads the payload of a JWT without verifying it.
 *
 * Verification would need the issuer's keys and buys nothing here: the file is
 * already trusted local state, and the value is only ever displayed. The
 * signature segment is never touched.
 */
export function readTokenClaims(token: string): { email: string | null; name: string | null } {
  const empty = { email: null, name: null }
  const segments = token.split('.')
  if (segments.length !== 3) return empty

  try {
    const padded = segments[1] + '='.repeat((4 - (segments[1].length % 4)) % 4)
    const decoded = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as Record<string, unknown>
    const out: { email: string | null; name: string | null } = { email: null, name: null }
    for (const claim of ALLOWED_CLAIMS) {
      const value = decoded[claim]
      if (typeof value === 'string' && value.length > 0 && value.length < 200) out[claim] = value
    }
    return out
  } catch {
    return empty
  }
}

interface OAuthAccount {
  accountUuid?: string
  emailAddress?: string
  organizationUuid?: string
  organizationName?: string
  organizationType?: string
  displayName?: string
  fullName?: string
}

function readClaudeOAuthAccount(path: string): AccountIdentity | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { oauthAccount?: OAuthAccount }
    const account = raw.oauthAccount
    if (!account?.emailAddress && !account?.organizationUuid) return null
    return {
      email: account.emailAddress ?? null,
      name: account.displayName ?? account.fullName ?? null,
      organizationName: account.organizationName ?? null,
      organizationType: account.organizationType ?? null,
      accountUuid: account.accountUuid ?? null,
      organizationUuid: account.organizationUuid ?? null,
      source: path,
    }
  } catch {
    return null
  }
}

/**
 * Every Claude identity we can find, indexed by both org and account UUID.
 *
 * A desktop profile knows its own org (from the usage file) and account uuid
 * (from its device registry) but not the email; Claude Code's config knows all
 * three. Joining on either uuid is what turns an opaque `f99b3e24…` into a
 * readable address.
 */
export function claudeIdentityDirectory(extraConfigDirs: string[] = []): Map<string, AccountIdentity> {
  const directory = new Map<string, AccountIdentity>()
  const candidates = [
    join(homedir(), '.claude.json'),
    ...extraConfigDirs.map((dir) => join(expandHome(dir), '.claude.json')),
  ]

  for (const path of candidates) {
    const identity = readClaudeOAuthAccount(path)
    if (!identity) continue
    if (identity.organizationUuid) directory.set(identity.organizationUuid, identity)
    if (identity.accountUuid) directory.set(identity.accountUuid, identity)
  }
  return directory
}

/** The account uuid a Claude desktop profile is signed in as, if it records one. */
export function desktopProfileAccountUuid(appDataDir: string): string | null {
  const path = join(expandHome(appDataDir), 'ant-device-registry.json')
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const [first] = Object.keys(raw)
    return first ?? null
  } catch {
    return null
  }
}

interface CodexAuth {
  tokens?: { id_token?: string; account_id?: string }
}

export function codexIdentity(codexHome: string): AccountIdentity | null {
  const path = join(expandHome(codexHome), 'auth.json')
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as CodexAuth
    const idToken = raw.tokens?.id_token
    const claims = idToken ? readTokenClaims(idToken) : { email: null, name: null }
    if (!claims.email && !raw.tokens?.account_id) return null
    return {
      email: claims.email,
      name: claims.name,
      organizationName: null,
      organizationType: null,
      accountUuid: raw.tokens?.account_id ?? null,
      organizationUuid: null,
      source: path,
    }
  } catch {
    return null
  }
}

/** Short, stable stand-in when no readable identity exists. */
export function fallbackLabel(uuid: string | null): string | null {
  return uuid ? `${uuid.slice(0, 8)}…` : null
}
