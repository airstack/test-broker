// Tokens never reach a log, a job record or a stream. Output is scrubbed line by line (so a token split across two
// chunks is still caught) before anything is stored or streamed.

const PATTERNS = [/gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g]

export function scrubText(s: string, secrets: Iterable<string>): string {
  let out = s
  for (const v of secrets) if (v && v.length >= 4) out = out.split(v).join('***')
  for (const re of PATTERNS) out = out.replace(re, '***')
  return out
}

/** A raw tail this long is kept at a cut: longer than any token prefix the patterns could still grow into. */
const KEEP = 512

/**
 * Where to cut a runaway line: at least max(KEEP, longest secret) before the end (so a secret or token that is only
 * partly here stays whole in the tail), moved back to the start of any secret or token match it would split. A match
 * that fills (nearly) the whole buffer is passed on whole (it is scrubbed as one).
 */
export function safeCut(buf: string, secrets: string[]): number {
  let cut = buf.length - Math.max(KEEP, ...secrets.map((v) => v.length))
  const ranges: [number, number][] = []
  for (const v of secrets) {
    if (!v || v.length < 4) continue
    for (let i = buf.indexOf(v); i >= 0; i = buf.indexOf(v, i + 1)) ranges.push([i, i + v.length])
  }
  for (const re of PATTERNS) for (const m of buf.matchAll(re)) ranges.push([m.index, m.index + m[0].length])
  // moving the cut back can land it inside an earlier match: repeat until it is inside none
  for (let moved = true; moved && cut > 0; ) {
    moved = false
    for (const [a, b] of ranges) if (a < cut && cut < b) {
      cut = a
      moved = true
    }
  }
  return cut > 0 ? cut : buf.length
}

export type Scrubber = { write(chunk: string): void; flush(): void }

/** Buffers to whole lines, scrubs them, hands them on (several lines at once when a chunk holds several). */
export function lineScrubber(secrets: () => Iterable<string>, emit: (lines: string) => void): Scrubber {
  let buf = ''
  return {
    write(chunk) {
      buf += chunk
      const nl = buf.lastIndexOf('\n')
      if (nl < 0) {
        // a runaway line with no newline: hand it on in pieces rather than holding it forever
        // (keeps a tail so a token at the cut is still seen whole next time)
        if (buf.length > 64 * 1024) {
          const sec = [...secrets()]
          const cut = safeCut(buf, sec)
          emit(scrubText(buf.slice(0, cut), sec))
          buf = buf.slice(cut)
        }
        return
      }
      const whole = buf.slice(0, nl + 1)
      buf = buf.slice(nl + 1)
      emit(scrubText(whole, secrets()))
    },
    flush() {
      if (buf) emit(scrubText(buf + '\n', secrets()))
      buf = ''
    },
  }
}
