import { openSync, readSync, closeSync, statSync } from 'node:fs'

const DEFAULT_TAIL_BYTES = 512 * 1024

/**
 * Scans a JSONL file backwards for the last line matching `predicate`.
 *
 * Session logs grow to megabytes and the interesting record is almost always
 * near the end, so this reads a tail chunk first and only widens to the whole
 * file if nothing matched. Chunk boundaries can split a line, so the first
 * (possibly partial) line of a non-initial chunk is always discarded.
 */
export function findLastLine<T>(
  path: string,
  predicate: (value: unknown) => value is T,
  tailBytes = DEFAULT_TAIL_BYTES,
): T | null {
  const size = statSync(path).size
  if (size === 0) return null

  const fd = openSync(path, 'r')
  try {
    for (const want of [tailBytes, size]) {
      const length = Math.min(want, size)
      const start = size - length
      const buf = Buffer.allocUnsafe(length)
      readSync(fd, buf, 0, length, start)

      const lines = buf.toString('utf8').split('\n')
      // A chunk that does not begin at byte 0 starts mid-line.
      if (start > 0) lines.shift()

      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i].trim()
        if (!line) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          continue
        }
        if (predicate(parsed)) return parsed
      }

      if (length >= size) break
    }
    return null
  } finally {
    closeSync(fd)
  }
}
