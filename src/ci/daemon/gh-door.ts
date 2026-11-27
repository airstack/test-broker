// The GitHub door: a second socket for the runners (split only), with its own handler and route list. Every field
// of a request is a claim; trust.ts checks each one with the daemon's own token (checks 1–15). Only the routes below
// exist; everything else is 404. The read routes need a ticket (an HMAC over the job and the run): a missing or
// wrong one is 404, never "forbidden" (don't confirm that a job exists). The daemon decides the job's fields: the
// client's label, source, tree, detach and force are ignored.
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { lookupId } from '../install-conf.ts'
import { PROTOCOL } from '../client/http.ts'
import type { Daemon } from './daemon.ts'
import { sendFilesTar } from './files-tar.ts'
import { HttpError } from './jobs.ts'
import { DoorClosed, events, fail, listen, pathParts, PROTOCOL_ERROR, readJson, send, type DirCheck } from './server.ts'

/** a runner's request is small: its claims, a sha, a mode, ≤ 64 KiB of args */
const GH_BODY_MAX = 80 * 1024

const protocolOk = (h: unknown) => h === String(PROTOCOL) || h === String(PROTOCOL - 1)

function ghJobView(d: Daemon, id: number) {
  const v = d.jobDetail(id)
  // the runner can't read the job dir: no path, no key, no events (files.tar and the stream carry what it needs)
  const { dir: _dir, key: _key, events: _events, ...rest } = v as any
  return { ...rest, dir: '' }
}

export function ghHandler(d: Daemon) {
  const c = d.c
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x')
    const m = req.method ?? 'GET'
    const nope = () => send(res, 404, { error: `no route ${m} ${url.pathname.slice(0, 200)}` })
    const parts = pathParts(url.pathname)
    if (!parts) return nope()
    try {
      if (parts[0] !== 'gh') return nope()
      if (m === 'GET' && url.pathname === '/gh/hello') return send(res, 200, { protocol: PROTOCOL, daemonId: c.cfg.daemonId })
      if (c.githubDoor !== 'open') return send(res, 503, { error: `the GitHub door is ${c.githubDoor}` })
      if (!protocolOk(req.headers['x-cib-protocol']))
        return send(res, 426, { error: PROTOCOL_ERROR(req.headers['x-cib-protocol']) })
      if (m === 'POST' && url.pathname === '/gh/admit') {
        const b = await readJson(req, GH_BODY_MAX)
        d.reloadConfig('github')
        const adm = await c.trust.admitGithub({ repo: b.repo, runId: b.runId, runAttempt: b.runAttempt, ref: b.ref }, 'admit')
        c.trust.admitted(adm, null)
        return send(res, 200, { admitted: true, lane: adm.lane })
      }
      if (m === 'POST' && url.pathname === '/gh/jobs') {
        // a drain answers before the admission: a waiting runner spends no rate slot and no API call
        if (c.switchDrain || c.awaitSeed) return send(res, 503, { error: 'draining for switch: the daemon takes no new jobs; the client waits' })
        const b = await readJson(req, GH_BODY_MAX)
        d.reloadConfig('github')
        const req2 = { repo: b.repo, runId: b.runId, runAttempt: b.runAttempt, ref: b.ref, sha: b.sha, mode: b.mode, args: b.args ?? [], ...(b.profile !== undefined ? { profile: b.profile } : {}) }
        const adm = await c.trust.admitGithub(req2, 'submit')
        try {
          const r = await c.jobs.submit({
            repo: req2.repo, profile: adm.profile.name, mode: req2.mode, args: req2.args, commit: req2.sha, tree: null, headCandidates: [],
            source: 'github', label: `github run ${req2.runId}.${req2.runAttempt} by ${adm.actor}`, detach: false, wantStatus: true, force: false,
            lane: 'full', env: adm.env, door: 'github', ghRun: adm.ghRun,
          })
          if (r.needBundle) throw new HttpError(400, 'the GitHub door runs pushed commits only')
          c.trust.recordRunUse(adm.runKey, r.id, r.reused ? 'reused' : r.joined ? 'joined' : 'new')
          c.trust.admitted(adm, r.id, req2.sha)
          const job = c.db.job(r.num)!
          return send(res, 200, { ...r, ticket: c.trust.ticket(job.id, job.createdAt, req2.runId, req2.runAttempt) })
        } finally {
          c.trust.releaseRun(adm.runKey)
        }
      }
      if (parts[1] === 'jobs' && parts[2]) {
        let id: number
        try {
          id = c.jobs.parseId(parts[2])
        } catch {
          return nope()
        }
        const job = c.db.job(id)
        if (!c.trust.ticketOk(url.searchParams.get('ticket'), job)) return send(res, 404, { error: `no job ${parts[2]}` })
        if (m === 'GET' && parts.length === 3) return send(res, 200, ghJobView(d, id))
        if (m === 'GET' && parts[3] === 'events' && parts.length === 4) {
          // interest=<token> must be this job's (events() checks it)
          return events(d, id, url, req, res)
        }
        if (m === 'DELETE' && parts[3] === 'interest' && parts[4] && parts.length === 5) {
          const i = c.db.interest(parts[4])
          if (!i || i.jobId !== id) return send(res, 404, { error: 'no such interest for this job' })
          c.jobs.withdraw(parts[4])
          return send(res, 200, { ok: true })
        }
        if (m === 'GET' && parts[3] === 'files.tar' && parts.length === 4) return sendFilesTar(c.streams.dir(id), res)
      }
      return nope()
    } catch (e) {
      fail(c, m, url, res, e)
    }
  }
}

/**
 * Open the GitHub door. Its dir (`<STATE_DIR>/sock`) must already be <daemon user>:<runner group> 2750 (made by
 * install; the setgid bit gives the socket the runner group without the daemon joining it). A wrong dir keeps the
 * door closed (status says why); the daemon keeps running.
 */
export async function openGithubDoor(d: Daemon, o: { gid?: number } = {}): Promise<Server[]> {
  const c = d.c
  if (!c.cfg.githubSocketPath) return []
  const gid = o.gid ?? (c.cfg.installConf ? lookupId('group', c.cfg.installConf.RUNNER_USER) : null)
  const check: DirCheck = { uid: process.getuid!(), gid: gid ?? -1, mode: 0o2750 }
  try {
    const s = await listen(d, c.cfg.githubSocketPath, { dirCheck: check, sockMode: 0o660, handler: ghHandler(d) })
    c.githubDoor = 'open'
    return [s]
  } catch (e) {
    if (!(e instanceof DoorClosed)) throw e
    c.githubDoor = `closed: ${e.message}`
    c.log(`GITHUB DOOR CLOSED: ${e.message}`)
    return []
  }
}

