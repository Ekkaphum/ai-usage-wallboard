import { describe, it, expect } from 'vitest'
import { readTokenClaims, fallbackLabel } from './identity'

/** Builds a JWT-shaped string. The signature is never inspected. */
function token(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `header.${body}.signature`
}

describe('readTokenClaims', () => {
  it('pulls out the identifying claims', () => {
    expect(readTokenClaims(token({ email: 'a@example.com', name: 'A Person' })))
      .toEqual({ email: 'a@example.com', name: 'A Person' })
  })

  it('ignores every claim outside the allow list', () => {
    const claims = readTokenClaims(token({
      email: 'a@example.com',
      access_token: 'sk-secret',
      sub: 'google-oauth2|123',
      scope: 'openid profile',
    })) as Record<string, unknown>
    expect(Object.keys(claims).sort()).toEqual(['email', 'name'])
    expect(JSON.stringify(claims)).not.toContain('sk-secret')
  })

  it('returns nulls rather than throwing on malformed input', () => {
    for (const bad of ['', 'not-a-token', 'a.b', 'a.!!!.c', 'a.bm90LWpzb24.c']) {
      expect(readTokenClaims(bad)).toEqual({ email: null, name: null })
    }
  })

  it('rejects absurdly long values', () => {
    expect(readTokenClaims(token({ email: 'x'.repeat(500) })).email).toBeNull()
  })

  it('ignores non-string claims', () => {
    expect(readTokenClaims(token({ email: 12345, name: { first: 'A' } })))
      .toEqual({ email: null, name: null })
  })
})

describe('fallbackLabel', () => {
  it('shortens a uuid to something readable', () => {
    expect(fallbackLabel('f99b3e24-be98-4dee-aac8-326e86f1ede4')).toBe('f99b3e24…')
  })

  it('has nothing to show without a uuid', () => {
    expect(fallbackLabel(null)).toBeNull()
  })
})
