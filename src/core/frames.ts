// `boat exec --timeout 0` (and --json) prints one JSON frame per line. Turn the frames back into the command's output
// and remember its exit code. Lines that aren't JSON pass through unchanged.

export type FrameState = { buf: string; exitCode?: number }

export const newFrameState = (): FrameState => ({ buf: '' })

function frame(line: string, s: FrameState): string {
  let f: Record<string, unknown>
  try {
    f = JSON.parse(line)
  } catch {
    return line + '\n'
  }
  if (f === null || typeof f !== 'object') return line + '\n'
  if (typeof f.data === 'string') return f.data
  if (f.type === 'exit' && typeof f.exitCode === 'number') {
    s.exitCode = f.exitCode
    return ''
  }
  if ('stdout' in f && typeof f.exitCode === 'number') {
    s.exitCode = f.exitCode
    return String(f.stdout ?? '') + String(f.stderr ?? '')
  }
  if (f.error !== undefined) return `[boat] ${typeof f.error === 'string' ? f.error : JSON.stringify(f.error)}\n`
  return ''
}

/** Feed a chunk; returns the decoded output. `flush` also decodes a trailing line with no newline. */
export function parseFrames(chunk: string, s: FrameState, flush = false): { out: string } {
  s.buf += chunk
  const lines = s.buf.split('\n')
  s.buf = lines.pop() ?? ''
  let out = ''
  for (const l of lines) if (l.length) out += frame(l, s)
  if (flush && s.buf.length) {
    const rest = s.buf
    s.buf = ''
    const decoded = frame(rest, s)
    // A non-JSON tail comes back with the newline frame() adds to whole lines; it never had one.
    out += decoded === rest + '\n' ? rest : decoded
  }
  return { out }
}
