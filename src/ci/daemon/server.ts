// HTTP/1.1 + JSON over the unix socket. The file modes are the boundary: single: dir 0700, socket 0600; split: the
// local socket's dir is <daemon>:<operator group> 2750 (made by install, only checked here) and the socket 0660.
// Every request but /hello carries x-cib-protocol (N or N-1). A trust refusal is a 403 with `trust: { check, … }`.
// Streams are NDJSON.
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import { dirname } from 'node:path'
import { PROTOCOL } from '../client/http.ts'
import type { EnvClass, Lane } from '../db.ts'
import type { Daemon } from './daemon.ts'
import { sendFilesTar } from './files-tar.ts'
import { HttpError, type SubmitReq } from './jobs.ts'
import { admitCheck, banner, daemonLog, doctor, hello, seed, submitLocal, trustCheck, trustView } from './local-door.ts'
import { TrustRefusal } from './trust.ts'

/** The client protocols a door accepts: this one and the one before (a client mid-job during an update). */
export const protocolOk = (h: unknown) => h === String(PROTOCOL) || h === String(PROTOCOL - 1)
export const PROTOCOL_ERROR = (h: unknown) => {
  const v = typeof h === 'string' && /^[0-9]{1,6}$/.test(h) ? Number(h) : null
  const said = `the client speaks protocol ${typeof h === 'string' ? h.slice(0, 10) : '(none)'}; this daemon speaks ${PROTOCOL} and ${PROTOCOL - 1}`
  return v !== null && v > PROTOCOL
    ? `${said}: the daemon is older than the client: an admin installs the newer release (install.sh --release <sha>; ci-broker update prints the command)`
    : `${said}: the client is older than the daemon: update it (git pull in its checkout, or use /opt/ci-broker/current/bin/ci-broker)`
}
import type { StreamEvent } from './stream.ts'

export function send(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) })
  res.end(s)
}

/** A JSON object body (at most `max` bytes). Anything but an object (null, a number, an array) is a 400. */
export async function readJson(req: IncomingMessage, max = 4 * 1024 * 1024): Promise<any> {
  let s = ''
  for await (const chunk of req) {
    s += chunk
    if (s.length > max) throw new HttpError(413, 'body too large')
  }
  if (!s) return {}
  let v: unknown
  try {
    v = JSON.parse(s)
  } catch {
    throw new HttpError(400, 'body is not JSON')
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'the body must be a JSON object')
  return v
}

/** the path's parts, decoded; a bad % escape is null (the caller answers 404) */
export function pathParts(pathname: string): string[] | null {
  try {
    return pathname.split('/').filter(Boolean).map(decodeURIComponent)
  } catch {
    return null
  }
}

export function handler(d: Daemon) {
  const c = d.c
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const m = req.method ?? 'GET'
    const parts = pathParts(url.pathname)
    if (!parts) return send(res, 404, { error: 'bad path' })
    try {
      if (m === 'GET' && url.pathname === '/hello') return send(res, 200, hello(d))
      if (!protocolOk(req.headers['x-cib-protocol'])) return send(res, 426, { error: PROTOCOL_ERROR(req.headers['x-cib-protocol']) })
      if (m === 'POST' && url.pathname === '/jobs') return send(res, 200, await submitLocal(d, (await readJson(req)) as SubmitReq))
      if (m === 'GET' && url.pathname === '/jobs') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 20) || 20, 1000)
        const jobs = c.db.recentJobs({ repo: url.searchParams.get('repo') ?? undefined, limit }).map((j) => d.jobView(j.id))
        return send(res, 200, { jobs })
      }
      if (parts[0] === 'jobs' && parts[1]) {
        const id = c.jobs.parseId(parts[1])
        if (m === 'GET' && parts.length === 2) return send(res, 200, d.jobDetail(id))
        if (m === 'PUT' && parts[2] === 'bundle') {
          await c.jobs.receiveBundle(id, req)
          return send(res, 200, { ok: true })
        }
        if (m === 'GET' && parts[2] === 'events') return events(d, id, url, req, res)
        if (m === 'GET' && parts[2] === 'files.tar' && parts.length === 3) {
          c.jobs.get(id)
          return sendFilesTar(c.streams.dir(id), res)
        }
        if (m === 'DELETE' && parts[2] === 'interest' && parts[3]) {
          c.jobs.withdraw(parts[3])
          return send(res, 200, { ok: true })
        }
        if (m === 'POST' && parts[2] === 'cancel') {
          c.jobs.get(id)
          c.jobs.cancel(id, 'cancelled by request')
          return send(res, 200, { ok: true, state: c.db.job(id)!.state })
        }
      }
      if (m === 'GET' && url.pathname === '/status') return send(res, 200, { ...d.status(), trust: { banner: banner(d), doors: { local: c.localDoor, github: c.githubDoor } } })
      if (m === 'GET' && url.pathname === '/trust') return send(res, 200, trustView(d))
      if (m === 'GET' && url.pathname === '/trust/log') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 10000)
        return send(res, 200, { events: c.tdb.events({ limit, repo: url.searchParams.get('repo') ?? undefined }) })
      }
      if (m === 'POST' && url.pathname === '/trust/check') return send(res, 200, await trustCheck(d, await readJson(req)))
      if (m === 'POST' && url.pathname === '/trust/unblock') return send(res, 200, await d.unblock(String((await readJson(req)).repo ?? '')))
      if (m === 'GET' && url.pathname === '/doctor') return send(res, 200, await doctor(d, url.searchParams.get('operatorTokenSha')))
      if (m === 'GET' && url.pathname === '/daemon-log') return daemonLog(d, url, res)
      if (m === 'POST' && url.pathname === '/admin/seed') return send(res, 200, seed(d, (await readJson(req)).nextId))
      if (m === 'POST' && parts[0] === 'resources' && parts[1] && parts[2] === 'reset') {
        try {
          return send(res, 200, d.resetResource(parts[1]))
        } catch (e) {
          throw new HttpError(404, (e as Error).message)
        }
      }
      if (m === 'POST' && parts[0] === 'resources' && parts[1] && parts[2] === 'check') {
        const body = await readJson(req)
        const lanes = await admitCheck(d, parts[1], typeof body.profile === 'string' ? body.profile : undefined)
        return await check(d, parts[1], { profile: body.profile, useReserve: body.useReserve, lanes: lanes ?? new Map() }, res)
      }
      if (m === 'POST' && url.pathname === '/drain') {
        const body = await readJson(req)
        if (body.cancel) {
          if (c.switchDrain) c.log('drain for switch cancelled: submits are accepted again')
          c.switchDrain = false
          return send(res, 200, { cancelled: true })
        }
        if (body.forSwitch) {
          if (!c.switchDrain) c.log('drain for switch: new submits get 503; placed and queued work goes on')
          c.switchDrain = true
          return send(res, 200, { forSwitch: true, active: c.jobs.activeJobs().length, maxJobId: c.db.maxJobId() })
        }
        return send(res, 200, d.drain())
      }
      if (m === 'POST' && url.pathname === '/gc') return send(res, 200, await d.timers.all())
      throw new HttpError(404, `no route ${m} ${url.pathname}`)
    } catch (e) {
      fail(c, m, url, res, e)
    }
  }
}

/** Errors → JSON: a trust refusal is a 403 with its check; anything unexpected is a 500 and a log line. */
export function fail(c: Daemon['c'], m: string, url: URL, res: ServerResponse, e: unknown) {
  if (e instanceof TrustRefusal) {
    if (!res.headersSent) send(res, 403, { error: e.message, trust: e.info })
    else res.end()
    return
  }
  const status = e instanceof HttpError ? e.status : 500
  if (status === 500) c.log(`server: ${m} ${url.pathname}: ${(e as Error).stack ?? e}`)
  if (!res.headersSent) send(res, status, { error: c.scrub((e as Error).message) })
  else res.end()
}

/** A health check, streamed as NDJSON (`log`, `result` per profile, `done` with the exit code). The client going away
 * cancels it. Bad requests (unknown resource or profile) are a 404 before the stream starts. */
async function check(d: Daemon, id: string, body: { profile?: string; useReserve?: boolean; lanes: Map<string, { lane: Lane; env: EnvClass }> }, res: ServerResponse) {
  const r = d.c.resources.find((x) => x.id === id)
  if (!r) throw new HttpError(404, `no resource ${id}`)
  if (body.profile && !r.profiles.includes('*') && !r.profiles.includes(body.profile)) throw new HttpError(400, `resource ${id} is not set up for profile ${body.profile} (profiles: ${r.profiles.join(', ')})`)
  const ac = new AbortController()
  let ended = false
  res.on('close', () => !ended && ac.abort())
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  try {
    await d.c.checks.run(id, { profile: body.profile, useReserve: !!body.useReserve, lanes: body.lanes }, (e) => res.write(JSON.stringify(e) + '\n'), ac.signal)
  } catch (e) {
    res.write(JSON.stringify({ t: 'done', code: 2, error: (e as Error).message }) + '\n')
  }
  ended = true
  res.end()
}

/** NDJSON: replay from `from`, then live with follow=1. interest=1 opens one (first line `{t:"interest",token}`),
 * interest=<token> re-attaches one. A stream that closes before `done` lets its interest lapse after the grace. */
export function events(d: Daemon, id: number, url: URL, req: IncomingMessage, res: ServerResponse) {
  const c = d.c
  const job = c.jobs.get(id)
  const follow = url.searchParams.get('follow') === '1'
  const from = Number(url.searchParams.get('from') ?? 0) || 0
  const iv = url.searchParams.get('interest') ?? '0'
  let token: string | null = null
  if (iv === '1') {
    if (job.state !== 'cancelling' && ['waiting-bundle', 'queued', 'running'].includes(job.state)) token = c.jobs.openInterest(id)
  } else if (iv !== '0') {
    const i = c.db.interest(iv)
    if (!i || i.jobId !== id) throw new HttpError(404, 'no such interest for this job')
    token = iv
  }
  c.jobs.ensureDone(id) // a terminal job missing its `done` would leave a follower waiting forever
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  if (iv === '1') res.write(JSON.stringify({ t: 'interest', token }) + '\n')
  if (token && !c.jobs.connect(token)) token = null
  let done = false
  let unsub: (() => void) | null = null
  const onEvent = (e: StreamEvent) => {
    if (done) return
    res.write(JSON.stringify(e) + '\n')
    if (e.t === 'done') {
      done = true
      res.end()
    }
  }
  unsub = c.streams.follow(id, from, onEvent)
  if (done) unsub()
  else if (!follow) {
    done = true
    unsub()
    res.end()
  }
  const close = () => {
    unsub?.()
    if (token && !done) c.jobs.disconnect(token)
    token = null
  }
  res.on('close', close)
  req.on('error', close)
}

/** The socket's dir must already be exactly this (split: made by install; the daemon never creates or chmods it). */
export type DirCheck = { uid: number; gid: number; mode: number }
export class DoorClosed extends Error {}

/** null when the dir is as wanted, else why not. Never follows a link. */
export function dirProblem(dir: string, want: DirCheck): string | null {
  let st
  try {
    st = lstatSync(dir)
  } catch {
    return `${dir} is missing (run scripts/install.sh)`
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} is not a directory (run scripts/install.sh)`
  const mode = st.mode & 0o7777
  if (mode !== want.mode) return `${dir} is mode ${mode.toString(8).padStart(4, '0')}, want ${want.mode.toString(8).padStart(4, '0')} (run scripts/install.sh)`
  if (st.uid !== want.uid) return `${dir} is owned by uid ${st.uid}, want ${want.uid} (run scripts/install.sh)`
  if (st.gid !== want.gid) return `${dir} has group ${st.gid}, want ${want.gid} (run scripts/install.sh)`
  return null
}

/**
 * Listen on the socket. A stale socket file (nobody answering) is replaced; a live one means another daemon runs.
 * Without `dirCheck` (single) the dir is made 0700 and the socket 0600; with it (split) the dir is only checked
 * (DoorClosed when it is wrong) and the socket made `sockMode` (0660), checked with stat.
 */
export async function listen(d: Daemon, path: string, o: { dirCheck?: DirCheck; sockMode?: number; handler?: ReturnType<typeof handler> } = {}): Promise<Server> {
  if (o.dirCheck) {
    const why = dirProblem(dirname(path), o.dirCheck)
    if (why) throw new DoorClosed(why)
  } else {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    chmodSync(dirname(path), 0o700)
  }
  if (existsSync(path)) {
    const alive = await new Promise<boolean>((resolve) => {
      const s = connect(path)
      s.once('connect', () => (s.destroy(), resolve(true)))
      s.once('error', () => resolve(false))
    })
    if (alive) throw new Error(`another ci-brokerd is listening on ${path}`)
    unlinkSync(path)
  }
  const server = createServer(o.handler ?? handler(d))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => resolve())
  })
  const mode = o.sockMode ?? 0o600
  chmodSync(path, mode)
  if ((statSync(path).mode & 0o777) !== mode) {
    server.close()
    throw new DoorClosed(`${path} did not end up mode ${mode.toString(8)}`)
  }
  return server
}
