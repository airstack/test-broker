// Past run durations per repo + suite + where (local or boat): the last 20, for lock ETAs and status.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const KEEP = 20

export class History {
  private file: string
  private d: Record<string, number[]> = {}
  constructor(file: string) {
    this.file = file
    try {
      if (existsSync(file)) {
        const doc = JSON.parse(readFileSync(file, 'utf8'))
        if (doc && typeof doc === 'object') for (const [k, v] of Object.entries(doc)) if (Array.isArray(v)) this.d[k] = v.filter((n) => typeof n === 'number' && n >= 0)
      }
    } catch {}
  }
  static key(repo: string, suite: string, where: 'local' | 'boat') {
    return `${repo}\u0000${suite}\u0000${where}`
  }
  add(key: string, sec: number) {
    const a = (this.d[key] ??= [])
    a.push(Math.round(sec))
    if (a.length > KEEP) a.splice(0, a.length - KEEP)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.d))
      renameSync(`${this.file}.tmp`, this.file)
    } catch {}
  }
  /** the median duration in seconds, or null with no history */
  median(key: string): number | null {
    const a = this.d[key]
    if (!a?.length) return null
    const s = [...a].sort((x, y) => x - y)
    return s[Math.floor(s.length / 2)]
  }
}
