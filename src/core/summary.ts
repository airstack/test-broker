// Per-shard results -> the receipt (text for the job log and the agent, markdown for the GitHub job summary, JSON).
export type ShardResult = {
  name: string
  size: string
  /** e.g. "local-container", "boat:bx_123 (reused)" */
  where: string
  /** exit code; null = no result (box lost, setup failed, cancelled) */
  code: number | null
  secs: number
  log: string
  reason?: string
  /** where a failed shard's artifacts were put (test-broker) */
  artifacts?: string
}

const clean = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

export function totals(log: string): string {
  return clean(log)
    .split('\n')
    .filter((l) => /^\s+Tests\s/.test(l) || /^\s+\d+ (passed|failed|flaky|skipped|did not run)/.test(l))
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .join('; ')
}

/** The failing tests and their first error lines (vitest / Playwright), else the log's tail. */
export function excerpt(log: string): string {
  const lines = clean(log).split('\n')
  const heads = lines.filter((l) => /FAILED int packages|^\s+\d+ (failed|flaky)|^\s+Tests\s+.*failed|^\s+Test Files\s+.*failed/.test(l)).slice(0, 10)
  const hits: string[] = []
  lines.forEach((l, i) => {
    if (/^ FAIL |^\s+\d+\) \[chromium\]/.test(l)) {
      hits.push(...lines.slice(i, i + 7).filter((x) => !/^\s*\d+\s*\|/.test(x)), '--')
    }
  })
  const body = hits.length ? hits.slice(0, 80) : lines.filter((l) => l.trim()).slice(-30)
  return [...heads, ...body].join('\n')
}

/** The dev-stack log a test-e2e run writes, and where the profile's remote script and local command copy it. */
const DEV_LOG_COPY = 'ci-broker-logs/test-e2e-dev.log'
const MAX_NAMED = 5

/** Playwright's end-of-run block: `  N failed` then one `[project] › file:line:col › suite › title` line per test. */
function playwrightReason(lines: string[]): string | null {
  const at = lines.findLastIndex((l) => /^\s+\d+ failed\s*$/.test(l))
  if (at < 0) return null
  const n = Number(lines[at].trim().split(' ')[0])
  const names: string[] = []
  for (const l of lines.slice(at + 1)) {
    const m = /^\s+\[[^\]]+\] › (\S+) › (.*)$/.exec(l)
    if (!m) break
    const title = m[2].split(' › ').pop()!.trim()
    names.push(`${m[1]} ${title.length > 60 ? `${title.slice(0, 59)}…` : title}`)
  }
  const shown = names.slice(0, MAX_NAMED)
  const more = names.length > MAX_NAMED ? [`+${names.length - MAX_NAMED} more`] : []
  return `${n} Playwright test${n === 1 ? '' : 's'} failed${shown.length ? `: ${[...shown, ...more].join(', ')}` : ''}`
}

/** One line on why a failed shard failed, read from its log; null if nothing in it says. */
export function failReason(r: Pick<ShardResult, 'name' | 'code' | 'log'>): string | null {
  const lines = clean(r.log).split('\n')
  const stack = lines.find((l) => /\[test-e2e\] the stack did not become healthy/.test(l))
  if (stack) return `${stack.replace(/^.*\[test-e2e\] /, '').replace(/ — see .*$/, '').trim()} — see artifacts/${r.name}/${DEV_LOG_COPY}`
  const pw = playwrightReason(lines)
  if (pw) return pw
  const pkgs = lines.find((l) => l.startsWith('FAILED int packages: '))
  if (pkgs) return pkgs.trim()
  const vt = lines.find((l) => /^\s+Tests\s+.*\d+ failed/.test(l))
  if (vt) return `vitest: ${vt.trim().replace(/\s+/g, ' ')}`
  const phases = lines.filter((l) => /^=== \[\d+s\] /.test(l) && !/^=== \[\d+s\] done: /.test(l))
  const last = lines.findLast((l) => l.trim() && !l.startsWith('=== ') && !l.startsWith('ci-broker: ') && !/^error: recipe `[^`]+` failed/.test(l))
  if (!phases.length && !last) return null
  const where = phases.length ? ` in "${phases.at(-1)!.replace(/^=== \[\d+s\] /, '').trim()}"` : ''
  const tail = last ? `: ${last.trim().slice(0, 200)}` : ''
  return `${r.code === null ? 'no exit status' : `exit ${r.code}`}${where}${tail}`
}

const headLine = (log: string) => clean(log).split('\n').find((l) => l.startsWith('HEAD: '))

export function summarize(results: ShardResult[]) {
  const pass = results.length > 0 && results.every((r) => r.code === 0)
  const rows = results.map((r) => ({ name: r.name, size: r.size, where: r.where, code: r.code, secs: r.secs, totals: totals(r.log), reason: r.reason ?? (r.code === 0 ? null : failReason(r)), pass: r.code === 0 }))
  const head = results.map((r) => headLine(r.log)).find(Boolean)
  const status = (ok: boolean) => (ok ? 'PASS' : 'FAIL')
  const text: string[] = rows.map((r) => `  ${status(r.pass).padEnd(4)} ${r.name.padEnd(10)} ${r.size.padEnd(7)} ${String(r.secs).padStart(5)}s  ${r.where}  ${r.reason ? `(${r.reason}) ` : ''}${r.totals}`)
  if (head) text.push(`  ${head}`)
  const md: string[] = ['| | shard | size | where | time | totals |', '|---|---|---|---|---|---|']
  for (const r of rows) md.push(`| ${r.pass ? '✅' : '❌'} | ${r.name} | ${r.size} | ${r.where} | ${r.secs}s | ${r.reason ? `${r.reason}; ` : ''}${r.totals} |`)
  if (head) md.push('', `\`${head}\``)
  for (const [i, r] of results.entries()) {
    if (r.code === 0) continue
    const ex = excerpt(r.log)
    const reason = rows[i].reason
    text.push('', `---------------- ${r.name}: failures ----------------`, ...(reason ? [reason] : []), ...(r.artifacts ? [`artifacts: ${r.artifacts}`] : []), ex)
    md.push('', `<details><summary>${r.name} failures</summary>`, '', ...(r.artifacts ? [`artifacts: \`${r.artifacts}\``, ''] : []), '```', ex, '```', '</details>')
  }
  if (!results.length) text.push('  (no shards ran)')
  text.push('', `RESULT: ${status(pass)}`)
  md.unshift(`### ci-broker: ${status(pass)}`, '')
  return { pass, text: text.join('\n'), markdown: md.join('\n'), json: { pass, head: head ?? null, shards: rows } }
}
