import { describe, it, expect } from 'vitest'
import { encodeHeader } from './notify'

describe('encodeHeader', () => {
  it('leaves plain ASCII untouched', () => {
    expect(encodeHeader('AI usage 91%')).toBe('AI usage 91%')
  })

  it('encodes Thai account names, which would otherwise throw in fetch', () => {
    const encoded = encodeHeader('Claude · งาน')
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/)
    const base64 = encoded.slice('=?UTF-8?B?'.length, -2)
    expect(Buffer.from(base64, 'base64').toString('utf8')).toBe('Claude · งาน')
  })

  it('encodes an em dash', () => {
    expect(encodeHeader('AI usage — 3 รายการ')).toContain('=?UTF-8?B?')
  })

  it('produces a value fetch will accept', () => {
    // ByteString means every code unit must fit in a byte.
    for (const char of encodeHeader('เตือน — 95%')) {
      expect(char.charCodeAt(0)).toBeLessThan(256)
    }
  })
})
