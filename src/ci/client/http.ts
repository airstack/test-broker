// The client's transport: HTTP over the daemon's unix socket. JSON requests, NDJSON streams, a streamed upload, a
// tar download. Every request carries x-cib-protocol: PROTOCOL (the daemon accepts it and the one before).
import { spawn } from 'node:child_process'
import { request as httpRequest, type IncomingMessage } from 'node:http'
import type { Readable } from 'node:stream'

/** The client/daemon protocol: one constant, shared with the daemon (it accepts N and N-1 on both doors). */
export const PROTOCOL = 2
/** The client's exit code for a trust refusal (never a test's exit code: those come from the job state). */
export const EXIT_REFUSED = 77

export class DaemonDown extends Error {}
export class ApiError extends Error {
  readonly status: number
  readonly body: any
  constructor(status: number, message: string, body: any = null) {
    super(message)
    this.status = status
    this.body = body
  }
}
/** A 403 with `trust: { check, … }`: the daemon refused by a trust check. */
export class TrustRefused extends ApiError {
  readonly check: string
  readonly reason: string
  constructor(body: any) {
    super(403, body.error, body)
    this.check = String(body.trust.check)
    this.reason = String(body.error).replace(/^refused \(trust\/[^)]*\): /, '')
  }
}
/** `ci-broker: REFUSED (trust/<check>): <reason>` */
export const refusedLine = (e: TrustRefused) => `ci-broker: REFUSED (trust/${e.check}): ${e.reason}`
/** for a runner job: the annotation on the run page (printed while workflow commands are not stopped) */
export const refusedAnnotation = (e: TrustRefused) => `::error title=ci-broker refused (trust/${e.check})::${e.reason.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`

export type Hello = { protocol: number; daemonId: string; layout: 'single' | 'split'; filesTar?: boolean }

const down = (socket: string, e: NodeJS.ErrnoException) =>
  ['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes(e.code ?? '')
    ? new DaemonDown(`ci-brokerd is not running (no answer on ${socket}). Start it: split (install.conf exists): sudo -n ci-broker-runnerctl daemon start; single: systemctl --user start ci-brokerd`)
    : e

function open(socket: string, method: string, path: string, headers: Record<string, string>, signal?: AbortSignal) {
  return httpRequest({ socketPath: socket, method, path, headers: { ...headers, 'x-cib-protocol': String(PROTOCOL) }, signal })
}

async function readAll(res: IncomingMessage): Promise<string> {
  let s = ''
  for await (const c of res) s += c
  return s
}

async function jsonResponse<T>(res: IncomingMessage): Promise<T> {
  const s = await readAll(res)
  let body: any
  try {
    body = s ? JSON.parse(s) : {}
  } catch {
    throw new ApiError(res.statusCode ?? 500, s.slice(0, 300))
  }
  if (res.statusCode === 403 && body?.trust?.check) throw new TrustRefused(body)
  if ((res.statusCode ?? 500) >= 400) throw new ApiError(res.statusCode ?? 500, body.error ?? `HTTP ${res.statusCode}`, body)
  return body as T
}

export class Client {
  readonly socket: string
  /** GET /hello's answer once asked (null: an old daemon without it) */
  hello: Hello | null = null
  constructor(socket: string) {
    this.socket = socket
  }

  /** GET /hello; null for an old `single` daemon (404). Throws DaemonDown when nothing answers. */
  async sayHello(): Promise<Hello | null> {
    try {
      this.hello = await this.request<Hello>('GET', '/hello')
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) this.hello = null
      else throw e
    }
    return this.hello
  }

  /** GET a text stream; `out` gets each chunk. Resolves at its end or on abort. */
  text(path: string, out: (s: string) => void, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = open(this.socket, 'GET', path, {}, signal)
      req.on('error', (e: NodeJS.ErrnoException) => (e.name === 'AbortError' || signal?.aborted ? resolve() : reject(down(this.socket, e))))
      req.on('response', (res) => {
        if ((res.statusCode ?? 500) >= 400) return void jsonResponse(res).then(() => reject(new ApiError(res.statusCode ?? 500, 'error')), reject)
        res.setEncoding('utf8')
        res.on('data', out)
        res.on('end', () => resolve())
        res.on('close', () => resolve())
      })
      req.end()
    })
  }

  /** GET a tar (files.tar) and extract it into `dest` as the caller (no owner or mode from the archive). */
  download(path: string, dest: string, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const req = open(this.socket, 'GET', path, {}, signal)
      req.on('error', (e) => reject(down(this.socket, e)))
      req.on('response', (res) => {
        if ((res.statusCode ?? 500) >= 400) return void jsonResponse(res).then(() => reject(new ApiError(res.statusCode ?? 500, 'error')), reject)
        const tar = spawn('/usr/bin/tar', ['-x', '-f', '-', '--no-same-owner', '--no-same-permissions', '-C', dest], { stdio: ['pipe', 'ignore', 'pipe'] })
        let err = ''
        tar.stderr.on('data', (d: Buffer) => (err += d))
        res.pipe(tar.stdin)
        tar.on('error', reject)
        tar.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar -x: exit ${code}: ${err.trim().slice(0, 300)}`))))
      })
      req.end()
    })
  }

  /** `signal` aborts the request (it rejects with an AbortError). */
  request<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const req = open(this.socket, method, path, data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}, signal)
      req.on('error', (e) => reject(down(this.socket, e)))
      req.on('response', (res) => jsonResponse<T>(res).then(resolve, reject))
      req.end(data)
    })
  }

  /** Stream a body (a bundle) to the daemon. */
  upload<T = any>(path: string, body: Readable, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const req = open(this.socket, 'PUT', path, { 'content-type': 'application/octet-stream', 'transfer-encoding': 'chunked' }, signal)
      req.on('error', (e) => reject(down(this.socket, e)))
      req.on('response', (res) => jsonResponse<T>(res).then(resolve, reject))
      body.on('error', (e) => req.destroy(e))
      body.pipe(req)
    })
  }

  /**
   * Read an NDJSON stream; `onEvent` gets each object. Resolves when the stream ends: `ended` = the server closed it
   * (after `done`, or a non-follow replay), false = aborted or dropped. `post` sends a JSON body with POST.
   */
  stream(path: string, onEvent: (e: any) => void, signal?: AbortSignal, post?: unknown): Promise<{ ended: boolean }> {
    return new Promise((resolve, reject) => {
      const data = post === undefined ? undefined : JSON.stringify(post)
      const req = open(this.socket, data ? 'POST' : 'GET', path, data ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(data)) } : {}, signal)
      let settled = false
      const finish = (v: { ended: boolean }) => !settled && ((settled = true), resolve(v))
      req.on('error', (e: NodeJS.ErrnoException) => {
        if (settled) return
        if (e.name === 'AbortError' || signal?.aborted) return finish({ ended: false })
        settled = true
        reject(down(this.socket, e))
      })
      req.on('response', async (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          settled = true
          return jsonResponse(res).then(() => reject(new ApiError(res.statusCode ?? 500, 'error')), reject)
        }
        let buf = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          buf += chunk
          let nl
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl)
            buf = buf.slice(nl + 1)
            if (line) onEvent(JSON.parse(line))
          }
        })
        res.on('end', () => finish({ ended: true }))
        res.on('aborted', () => finish({ ended: false }))
        res.on('error', () => finish({ ended: false }))
        res.on('close', () => finish({ ended: !res.errored && res.complete }))
      })
      req.end(data)
    })
  }
}

/**
 * The daemon to talk to: the first socket that answers. `split`'s socket (from install.conf) first, then `single`'s:
 * the choice follows the daemon that answers, not which socket file exists (during the switch both may).
 */
export async function pickClient(sockets: string[]): Promise<Client> {
  let last: Client | null = null
  for (const s of sockets) {
    const c = new Client(s)
    last = c
    try {
      await c.sayHello()
      return c
    } catch (e) {
      if (!(e instanceof DaemonDown)) throw e
    }
  }
  // none answered: the first socket (split's, when there is an install) names the error
  void last
  return new Client(sockets[0] ?? '/nonexistent')
}

/** What a runner job claims about itself (the GitHub door checks every field). */
export type GhRunClaims = { repo: string; runId: string; runAttempt: string; ref: string }
export function ghRunClaims(env: NodeJS.ProcessEnv): GhRunClaims {
  const need = ['GITHUB_REPOSITORY', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_REF'].filter((k) => !env[k])
  if (need.length) throw new Error(`the runner env lacks ${need.join(', ')}`)
  return { repo: env.GITHUB_REPOSITORY!, runId: env.GITHUB_RUN_ID!, runAttempt: env.GITHUB_RUN_ATTEMPT!, ref: env.GITHUB_REF! }
}

/**
 * The GitHub door's client: the same calls as the local socket's, rewritten to /gh/*. A submit sends the run's
 * claims plus sha, mode, args (and profile); its answer's ticket goes on every read after it. Nothing else exists.
 */
export class GhDoorClient extends Client {
  ticket: string | null = null
  readonly claims: GhRunClaims
  constructor(socket: string, claims: GhRunClaims) {
    super(socket)
    this.claims = claims
    this.hello = { protocol: PROTOCOL, daemonId: '', layout: 'split', filesTar: true }
  }
  private ghPath(path: string): string {
    if (path === '/hello') return '/gh/hello'
    if (!path.startsWith('/jobs/')) return '/gh/none'
    const t = this.ticket ? `${path.includes('?') ? '&' : '?'}ticket=${encodeURIComponent(this.ticket)}` : ''
    return `/gh${path}${t}`
  }
  override async sayHello(): Promise<Hello | null> {
    const h = await super.request<Hello>('GET', '/gh/hello')
    this.hello = { ...h, layout: 'split', filesTar: true }
    return this.hello
  }
  /** POST /gh/admit: checks 1–12 for this run */
  admit(): Promise<{ admitted: true; lane: string }> {
    return super.request('POST', '/gh/admit', this.claims)
  }
  override async request<T = any>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    if (method === 'POST' && path === '/jobs') {
      const b = body as any
      const r = await super.request<any>('POST', '/gh/jobs', { ...this.claims, sha: b.commit, mode: b.mode, args: b.args ?? [], ...(b.profile ? { profile: b.profile } : {}) }, signal)
      this.ticket = r.ticket
      return r as T
    }
    return super.request<T>(method, this.ghPath(path), body, signal)
  }
  override stream(path: string, onEvent: (e: any) => void, signal?: AbortSignal, post?: unknown) {
    return super.stream(this.ghPath(path), onEvent, signal, post)
  }
  override download(path: string, dest: string, signal?: AbortSignal) {
    return super.download(this.ghPath(path), dest, signal)
  }
}
