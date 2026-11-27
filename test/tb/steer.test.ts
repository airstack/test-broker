import '../tmp-root.ts'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { RunsDb } from '../../src/tb/runs-db.ts'
import { argsKey } from '../../src/tb/eta.ts'
import { checkMode, heavyClass, judge } from '../../src/tb/steer.ts'
import { Broker, worktreeTree } from '../../src/tb/broker.ts'
import { MACHINE_DEFAULTS, MachineConfigError, parseMachineConfig, type SteerConfig } from '../../src/tb/machine-config.ts'
import { parseRepoConfig, RepoConfigError } from '../../src/tb/repo-config.ts'
import { makeOrigin, tmp } from '../harness.ts'

const H = 3_600_000
const T0 = Date.UTC(2026, 10, 19, 0, 0, 0)
const cfgOf = (p: Partial<SteerConfig> = {}): SteerConfig => ({ ...structuredClone(MACHINE_DEFAULTS.steer), mode: 'advise', ...p })
const suiteOf = (heavy: boolean | null = null) => ({ name: 'test-all', local: { cpus: 2, minCpus: 1, memGb: 0, locks: [] }, boat: null, heavy })

/** a finished run */
function run(db: RunsDb, id: string, o: { repo?: string; root?: string; suite?: string; shape?: 'whole' | 'narrowed'; at: number; cpuMin: number; exit?: number; head?: string; tree?: string; heavy?: boolean; argsKey?: string | null; argsN?: number; whereRan?: 'boat' | 'local' | 'advised'; endedHow?: string }) {
  db.startRun({ id, repo: o.repo ?? 'o/a', root: o.root ?? '/w1', suite: o.suite ?? 'test-all', shape: o.shape ?? 'whole', argsN: o.argsN ?? 0, whereRan: o.whereRan ?? 'boat', boatWhy: null, startedAt: o.at, cpus: 8, shards: null, argsKey: o.argsKey === undefined ? '-' : o.argsKey })
  db.endRun(id, { endedAt: o.at + 60_000, exitCode: o.exit ?? 0, endedHow: o.endedHow ?? 'done', cpuMin: o.cpuMin, planHours: 0.5 })
  if (o.head || o.tree) db.setGit(id, { head: o.head ?? null, tree: o.tree ?? null })
  if (o.heavy != null) db.setSteer(id, o.heavy, null)
}

test('the heavy class is learned from the key\'s median cost; a hand override wins; a new key is not heavy', () => {
  const db = new RunsDb(':memory:')
  const c = cfgOf({ heavyCpuMin: 15 })
  assert.equal(heavyClass(db, c, { repo: 'o/a', suite: suiteOf(), shape: 'whole' }).heavy, false)
  run(db, 'r1', { at: T0, cpuMin: 40 })
  run(db, 'r2', { at: T0 + 1, cpuMin: 5 })
  run(db, 'r3', { at: T0 + 2, cpuMin: 30 })
  assert.deepEqual(heavyClass(db, c, { repo: 'o/a', suite: suiteOf(), shape: 'whole' }), { heavy: true, medianCpuMin: 30 })
  // narrowed runs of the same suite are their own key
  assert.equal(heavyClass(db, c, { repo: 'o/a', suite: suiteOf(), shape: 'narrowed' }).heavy, false)
  assert.equal(heavyClass(db, c, { repo: 'o/a', suite: suiteOf(false), shape: 'whole' }).heavy, false)
})

test('check modes: off beats all, log caps advise, a per-check mode applies under advise', () => {
  assert.equal(checkMode(cfgOf({ mode: 'off', checks: { sameTree: 'advise' } }), 'sameTree'), 'off')
  assert.equal(checkMode(cfgOf({ mode: 'log', checks: { sameTree: 'advise' } }), 'sameTree'), 'log')
  assert.equal(checkMode(cfgOf({ mode: 'advise', checks: { budget: 'log' } }), 'budget'), 'log')
  assert.equal(checkMode(cfgOf({ mode: 'advise' }), 'perWorktree'), 'advise')
})

test('same tree: a heavy run of code that already passed is advised; another tree, or an old pass, is not', async () => {
  const db = new RunsDb(':memory:')
  run(db, 'r1', { at: T0, cpuMin: 40, head: 'h1', tree: 't1' })
  const q = { repo: 'o/a', root: '/w2', suite: suiteOf(), shape: 'whole' as const, argsKey: '-', head: 'h1', now: T0 + H }
  const v = await judge(db, cfgOf(), q, async () => 't1')
  assert.equal(v.advised, true)
  assert.deepEqual(v.reasons.map((r) => r.check), ['sameTree'])
  assert.match(v.reasons[0].message, /already passed `test-all`.*r1.*from \/w1/)
  assert.equal((await judge(db, cfgOf(), q, async () => 't2')).reasons.length, 0)
  assert.equal((await judge(db, cfgOf({ sameTreeHours: 0.5 }), q, async () => 't1')).reasons.length, 0)
  // log mode: the same reason, recorded, not advised
  const l = await judge(db, cfgOf({ mode: 'log' }), q, async () => 't1')
  assert.equal(l.advised, false)
  assert.equal(l.reasons[0].mode, 'log')
  // a reason runs it anyway; a too-short one does not
  assert.equal((await judge(db, cfgOf(), { ...q, confirm: 'ok' }, async () => 't1')).advised, true)
  const c = await judge(db, cfgOf(), { ...q, confirm: 'the runner changed; verify on the merged head' }, async () => 't1')
  assert.equal(c.advised, false)
  assert.equal(c.confirm, 'the runner changed; verify on the merged head')
})

test('per worktree: the Nth heavy run in an hour from one worktree is advised', async () => {
  const db = new RunsDb(':memory:')
  run(db, 'r1', { at: T0, cpuMin: 40, heavy: true, root: '/w1' })
  run(db, 'r2', { at: T0 + 10 * 60_000, cpuMin: 40, heavy: true, root: '/w1' })
  const q = { repo: 'o/a', root: '/w1', suite: suiteOf(), shape: 'whole' as const, argsKey: '-', head: null, now: T0 + 30 * 60_000 }
  const v = await judge(db, cfgOf({ heavyPerWorktreePerHour: 2 }), q, async () => null)
  assert.deepEqual(v.reasons.map((r) => r.check), ['perWorktree'])
  assert.equal((await judge(db, cfgOf({ heavyPerWorktreePerHour: 2 }), { ...q, root: '/w9' }, async () => null)).reasons.length, 0)
})

test('budget: past softAt, a repo above its fair share is advised only while others test; past the target, every heavy run', async () => {
  const mk = (aHours: number, bHours: number) => {
    const db = new RunsDb(':memory:')
    db.plan({ t: T0, hoursLeft: 100, periodEnd: T0 + 10 * 24 * H, last24hHours: null, startsUsed: null, active: null }) // target 10 h
    run(db, 'r1', { at: T0 + 2 * H, cpuMin: 40 })
    // box a: o/a, default box (1/h) from 1h for aHours; box b: o/b
    db.boxEvent({ t: T0 + 4 * H - aHours * H, box: 'a', size: 'default', state: 'busy', repo: 'o/a' })
    db.boxEvent({ t: T0 + 4 * H, box: 'a', size: 'default', state: 'stopped', repo: 'o/a' })
    if (bHours) {
      run(db, 'b1', { repo: 'o/b', at: T0 + 3 * H, cpuMin: 1 })
      db.boxEvent({ t: T0 + 4 * H - bHours * H, box: 'b', size: 'default', state: 'busy', repo: 'o/b' })
      db.boxEvent({ t: T0 + 4 * H, box: 'b', size: 'default', state: 'stopped', repo: 'o/b' })
    }
    return db
  }
  const q = { repo: 'o/a', root: '/w1', suite: suiteOf(), shape: 'whole' as const, argsKey: '-', head: null, now: T0 + 4 * H }
  // 3 + 1 = 4 of 10 h (40% ≥ softAt 30%), o/a has 75% of the window with 2 repos active: advised
  let v = await judge(mk(3, 1), cfgOf({ fairWindowHours: 3, softAt: 0.3 }), q, async () => null)
  assert.deepEqual(v.reasons.map((r) => r.check), ['budget'])
  assert.match(v.reasons[0].message, /2 repos are testing.*fair share is about 50%/)
  // alone on Boat at 35%: no advice
  v = await judge(mk(3.5, 0), cfgOf({ fairWindowHours: 3, softAt: 0.3 }), q, async () => null)
  assert.equal(v.reasons.length, 0)
  // over the target: advised, alone or not
  v = await judge(mk(3.9, 0), cfgOf({ fairWindowHours: 3, softAt: 0.1, reserveHours: 70 }), q, async () => null)
  assert.match(v.reasons[0].message, /budget is spent/)
})

test('config: steer parses with defaults and refuses bad keys; repo advice and heavy parse', () => {
  const c = parseMachineConfig({ steer: { mode: 'advise', checks: { budget: 'log' }, heavyCpuMin: 20 } })
  assert.equal(c.steer.mode, 'advise')
  assert.equal(c.steer.checks.budget, 'log')
  assert.equal(c.steer.heavyCpuMin, 20)
  assert.equal(parseMachineConfig({}).steer.mode, 'log')
  assert.throws(() => parseMachineConfig({ steer: { mode: 'loud' } }), MachineConfigError)
  assert.throws(() => parseMachineConfig({ steer: { checks: { nope: 'log' } } }), MachineConfigError)
  assert.throws(() => parseMachineConfig({ steer: { softAt: 0 } }), MachineConfigError)
  const r = parseRepoConfig({ advice: 'CI runs the full suites at landing.', suites: { t: { local: { cpus: 1 }, heavy: true } } }, '/x')
  assert.equal(r.advice, 'CI runs the full suites at landing.')
  assert.equal(r.suites.t.heavy, true)
  assert.throws(() => parseRepoConfig({ advice: 3, suites: { t: { local: { cpus: 1 } } } }, '/x'), RepoConfigError)
  assert.throws(() => parseRepoConfig({ suites: { t: { local: { cpus: 1 }, heavy: 'yes' } } }, '/x'), RepoConfigError)
})

test('broker: an advised ask runs nothing (exit-76 answer with the repo advice, recorded); log mode runs and records; a reason runs it', async () => {
  const root = tmp('tb-steer-')
  const { work } = makeOrigin(join(root, 'origins'), 'me/app')
  const usage = new RunsDb(':memory:')
  const tree = (await worktreeTree(work))!
  const head = execFileSync('git', ['-C', work, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const now = Date.now()
  usage.startRun({ id: 'old', repo: 'me/app', root: work, suite: 'unit', shape: 'whole', argsN: 0, whereRan: 'local', boatWhy: null, startedAt: now - H, cpus: 8, shards: null })
  usage.endRun('old', { endedAt: now - H + 60_000, exitCode: 0, endedHow: 'done', cpuMin: 60, planHours: 0 })
  usage.setGit('old', { head, tree })
  const repoCfg = parseRepoConfig({ advice: 'Run the changed tests; CI runs the rest.', suites: { unit: { local: { cpus: 2 } } } }, work)
  const mk = (mode: 'log' | 'advise') => {
    const cfg = structuredClone(MACHINE_DEFAULTS)
    cfg.steer.mode = mode
    return new Broker({ cfg, stateDir: join(root, `state-${mode}`), box: () => ({ nproc: 8, load1: 0, memAvailGb: 16 }), repoOf: async () => 'me/app', loadConfig: () => repoCfg, log: () => {}, usage })
  }
  const a = await mk('advise').ask({ root: work, suite: 'unit', flags: {}, pid: 1, args: [] }, 'c1')
  assert.equal(a.decision, 'advise')
  if (a.decision === 'advise') {
    assert.match(a.advise.message, /already passed `unit`/)
    assert.match(a.advise.message, /Run the changed tests; CI runs the rest\./)
    assert.match(a.advise.message, /TEST_BROKER_CONFIRM/)
  }
  assert.equal(usage.runsSince(0).filter((r) => r.whereRan === 'advised').length, 1)
  const l = mk('log')
  const b = await l.ask({ root: work, suite: 'unit', flags: {}, pid: 2, args: [] }, 'c2')
  assert.equal(b.decision, 'local')
  const logged = usage.runsSince(0).find((r) => r.whereRan === 'local' && r.id !== 'old')!
  assert.equal(logged.heavy, true)
  assert.equal(logged.steer!.reasons[0].check, 'sameTree')
  assert.equal(logged.steer!.advised, false)
  l.release('c2')
  const c = await mk('advise').ask({ root: work, suite: 'unit', flags: { confirm: 'checking the release head before tagging' }, pid: 3, args: [] }, 'c3')
  assert.equal(c.decision, 'local')
  // a peek never steers
  const p = await mk('advise').ask({ root: work, suite: 'unit', flags: {}, pid: 4, args: [] }, 'c4', true)
  assert.notEqual(p.decision, 'advise')
})

test('same tree: a pass counts only with the same args; a row from before args were kept counts only for no args', async () => {
  const db = new RunsDb(':memory:')
  run(db, 'n1', { at: T0, cpuMin: 40, head: 'h1', tree: 't1', shape: 'narrowed', argsN: 2, argsKey: 'k1' })
  const q = { repo: 'o/a', root: '/w2', suite: suiteOf(), shape: 'narrowed' as const, argsKey: 'k2', head: 'h1', now: T0 + H }
  // other specs on the same code: not "already passed"
  assert.equal((await judge(db, cfgOf(), q, async () => 't1')).reasons.length, 0)
  const same = await judge(db, cfgOf(), { ...q, argsKey: 'k1' }, async () => 't1')
  assert.deepEqual(same.reasons.map((r) => r.check), ['sameTree'])
  assert.match(same.reasons[0].message, /already passed `test-all` with the same args/)
  // the whole suite is not passed by a narrowed run
  assert.equal((await judge(db, cfgOf(), { ...q, shape: 'whole', argsKey: '-' }, async () => 't1')).reasons.length, 0)
  // legacy rows (no args_key): a whole run counts for a whole ask; a narrowed one never
  run(db, 'old', { at: T0, cpuMin: 40, head: 'h2', tree: 't2', argsKey: null })
  run(db, 'oldn', { at: T0, cpuMin: 40, head: 'h3', tree: 't3', shape: 'narrowed', argsN: 1, argsKey: null })
  assert.equal((await judge(db, cfgOf(), { ...q, head: 'h2', shape: 'whole', argsKey: '-' }, async () => 't2')).reasons.length, 1)
  assert.equal((await judge(db, cfgOf(), { ...q, head: 'h3', argsKey: 'k1' }, async () => 't3')).reasons.length, 0)
})

test('per worktree: an advised ask and a Boat run that never started (exit 3) are not heavy runs', async () => {
  const db = new RunsDb(':memory:')
  run(db, 'r1', { at: T0, cpuMin: 40, heavy: true, root: '/w1' })
  run(db, 'a1', { at: T0 + 60_000, cpuMin: 0, heavy: true, root: '/w1', whereRan: 'advised', exit: 76, endedHow: 'advised' })
  run(db, 'n1', { at: T0 + 120_000, cpuMin: 0, heavy: true, root: '/w1', exit: 3, endedHow: 'not started' })
  run(db, 'n2', { at: T0 + 180_000, cpuMin: 0, heavy: true, root: '/w1', exit: 3, endedHow: 'not started' })
  const q = { repo: 'o/a', root: '/w1', suite: suiteOf(), shape: 'whole' as const, argsKey: '-', head: null, now: T0 + 30 * 60_000 }
  assert.equal((await judge(db, cfgOf({ heavyPerWorktreePerHour: 2 }), q, async () => null)).reasons.length, 0)
  // nor a broker error (exit 2) or a run cut by a daemon restart
  run(db, 'e1', { at: T0 + 150_000, cpuMin: 1, heavy: true, root: '/w1', exit: 2, endedHow: 'error' })
  run(db, 'd1', { at: T0 + 160_000, cpuMin: 1, heavy: true, root: '/w1', exit: 1, endedHow: 'daemon restart' })
  assert.equal((await judge(db, cfgOf({ heavyPerWorktreePerHour: 2 }), q, async () => null)).reasons.length, 0)
  // nor do they make the suite look light (they cost 0 CPU-minutes)
  assert.equal(heavyClass(db, cfgOf({ heavyCpuMin: 15 }), { repo: 'o/a', suite: suiteOf(), shape: 'whole' }).heavy, true)
  // the run it fell back to (here) does count
  run(db, 'l1', { at: T0 + 240_000, cpuMin: 40, heavy: true, root: '/w1', whereRan: 'local' })
  assert.deepEqual((await judge(db, cfgOf({ heavyPerWorktreePerHour: 2 }), q, async () => null)).reasons.map((r) => r.check), ['perWorktree'])
})

test('per worktree: a run still going counts; at daemon start, runs left open are closed as a daemon restart and stop counting', async () => {
  const db = new RunsDb(':memory:')
  run(db, 'r1', { at: T0, cpuMin: 40, heavy: true, root: '/w1' })
  db.startRun({ id: 'open', repo: 'o/a', root: '/w1', suite: 'test-all', shape: 'whole', argsN: 0, whereRan: 'local', boatWhy: null, startedAt: T0 + 60_000, cpus: 8, shards: null, argsKey: '-' })
  db.setSteer('open', true, null)
  const q = { repo: 'o/a', root: '/w1', suite: suiteOf(), shape: 'whole' as const, argsKey: '-', head: null, now: T0 + 30 * 60_000 }
  assert.deepEqual((await judge(db, cfgOf({ heavyPerWorktreePerHour: 2 }), q, async () => null)).reasons.map((r) => r.check), ['perWorktree'])
  assert.equal(db.closeOpen(T0 + 20 * 60_000), 1)
  assert.equal(db.runsSince(0).find((r) => r.id === 'open')!.endedHow, 'daemon restart')
  assert.equal((await judge(db, cfgOf({ heavyPerWorktreePerHour: 2 }), q, async () => null)).reasons.length, 0)
  assert.equal(db.closeOpen(T0 + 21 * 60_000), 0)
})

test('broker: a local run records the args key the ask was judged with, and (heavy) its tree before it starts', async () => {
  const root = tmp('tb-steer-')
  const { work } = makeOrigin(join(root, 'origins'), 'me/app')
  const usage = new RunsDb(':memory:')
  const now = Date.now()
  // a heavy history for the narrowed shape, so the ask is heavy
  for (let i = 0; i < 3; i++) {
    usage.startRun({ id: `h${i}`, repo: 'me/app', root: '/elsewhere', suite: 'unit', shape: 'narrowed', argsN: 1, argsKey: 'x', whereRan: 'local', boatWhy: null, startedAt: now - 3 * H + i, cpus: 8, shards: null })
    usage.endRun(`h${i}`, { endedAt: now - 2 * H, exitCode: 1, endedHow: 'done', cpuMin: 60, planHours: 0 })
  }
  const repoCfg = parseRepoConfig({ suites: { unit: { local: { cpus: 2 } } } }, work)
  const cfg = structuredClone(MACHINE_DEFAULTS)
  cfg.steer.mode = 'log'
  const b = new Broker({ cfg, stateDir: join(root, 'state'), box: () => ({ nproc: 8, load1: 0, memAvailGb: 16 }), repoOf: async () => 'me/app', loadConfig: () => repoCfg, log: () => {}, usage })
  const a = await b.ask({ root: work, suite: 'unit', flags: {}, pid: 1, args: ['a.test.ts', 'b.test.ts'] }, 'c1')
  assert.equal(a.decision, 'local')
  const r = usage.runsSince(0).find((x) => x.root === work)!
  assert.equal(r.argsKey, argsKey(['a.test.ts', 'b.test.ts']))
  assert.equal(r.heavy, true)
  // the tree is on the row as the ask returns (no wait for a background job)
  assert.equal(r.tree, await worktreeTree(work))
  b.release('c1')
})

test('runs.db from before args_key: the column is added, old rows read as null, the version is unchanged', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const f = join(tmp('tb-runsdb-'), 'runs.db')
  const old = new DatabaseSync(f)
  old.exec(`CREATE TABLE runs (id TEXT PRIMARY KEY, repo TEXT NOT NULL, root TEXT NOT NULL, branch TEXT, head TEXT, tree TEXT, suite TEXT NOT NULL, shape TEXT NOT NULL, args_n INTEGER NOT NULL, where_ran TEXT NOT NULL, boat_why TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, exit_code INTEGER, ended_how TEXT, cpus INTEGER NOT NULL, cpu_min REAL, plan_hours REAL, shards TEXT, heavy INTEGER, steer TEXT);
    INSERT INTO runs (id, repo, root, suite, shape, args_n, where_ran, started_at, cpus) VALUES ('o1', 'o/a', '/w', 'test-all', 'whole', 0, 'boat', 1, 8);
    PRAGMA user_version = 4;`)
  old.close()
  const db = new RunsDb(f)
  assert.equal(db.runsSince(0)[0].argsKey, null)
  assert.equal((db.raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4)
  db.close()
})
