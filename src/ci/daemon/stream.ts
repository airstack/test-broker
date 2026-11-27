// Every event of a job, in order, with a sequence number, in <jobDir>/stream.ndjson: the replay source for late
// joiners and reconnects. Live subscribers get the same events as they are appended.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type StreamEvent =
  | { seq: number; t: 'log'; shard: string; data: string }
  | { seq: number; t: 'state'; shard?: string; state: string; message?: string }
  | { seq: number; t: 'done'; summary: unknown }

/** An event before it gets its sequence number. */
export type NewEvent = { t: 'log'; shard: string; data: string } | { t: 'state'; shard?: string; state: string; message?: string } | { t: 'done'; summary: unknown }

export class JobStreams {
  private seqs = new Map<number, number>()
  private subs = new Map<number, Set<(e: StreamEvent) => void>>()
  readonly jobsDir: string
  private onError: (msg: string) => void
  constructor(jobsDir: string, onError: (msg: string) => void = () => {}) {
    this.jobsDir = jobsDir
    this.onError = onError
  }

  dir(jobId: number): string {
    return join(this.jobsDir, String(jobId))
  }
  private file(jobId: number) {
    return join(this.dir(jobId), 'stream.ndjson')
  }

  private lastSeq(jobId: number): number {
    let s = this.seqs.get(jobId)
    if (s === undefined) {
      s = this.read(jobId).at(-1)?.seq ?? 0
      this.seqs.set(jobId, s)
    }
    return s
  }

  append(jobId: number, e: NewEvent): StreamEvent {
    const seq = this.lastSeq(jobId) + 1
    this.seqs.set(jobId, seq)
    const ev = { seq, ...e } as StreamEvent
    // never throws: append runs inside child-process data listeners, where a throw would kill the daemon
    try {
      mkdirSync(this.dir(jobId), { recursive: true })
      appendFileSync(this.file(jobId), JSON.stringify(ev) + '\n')
    } catch (e) {
      this.onError(`job ${jobId}: writing ${this.file(jobId)} failed: ${(e as Error).message}`)
    }
    for (const fn of this.subs.get(jobId) ?? []) {
      try {
        fn(ev)
      } catch (e) {
        this.onError(`job ${jobId}: a follower failed: ${(e as Error).message}`)
      }
    }
    return ev
  }

  /** Events with seq > from. */
  read(jobId: number, from = 0): StreamEvent[] {
    const f = this.file(jobId)
    if (!existsSync(f)) return []
    const out: StreamEvent[] = []
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (!l) continue
      try {
        const e = JSON.parse(l) as StreamEvent
        if (e.seq > from) out.push(e)
      } catch {} // a torn last line from a crash
    }
    return out
  }

  /** The last event (from the file's tail, so a long log is not read whole), or null. */
  lastEvent(jobId: number): StreamEvent | null {
    const f = this.file(jobId)
    if (!existsSync(f)) return null
    let text: string
    try {
      const size = statSync(f).size
      const n = Math.min(size, 256 * 1024)
      const fd = openSync(f, 'r')
      try {
        const buf = Buffer.alloc(n)
        readSync(fd, buf, 0, n, size - n)
        text = buf.toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return null
    }
    const lines = text.split('\n').filter(Boolean)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        return JSON.parse(lines[i]) as StreamEvent
      } catch {} // a torn last line, or the cut first one
    }
    return null
  }

  /**
   * Replay from `from`, then live. Replay and subscribe happen in the same tick (appends are synchronous), so nothing
   * is missed or doubled. Returns an unsubscribe function.
   */
  follow(jobId: number, from: number, fn: (e: StreamEvent) => void): () => void {
    for (const e of this.read(jobId, from)) fn(e)
    let set = this.subs.get(jobId)
    if (!set) this.subs.set(jobId, (set = new Set()))
    set.add(fn)
    return () => {
      set.delete(fn)
      if (!set.size) this.subs.delete(jobId)
    }
  }

  forget(jobId: number) {
    this.seqs.delete(jobId)
  }
}
