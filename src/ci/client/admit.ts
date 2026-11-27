// `ci-broker admit`: the runner's pre-job hook (bin/cib-admit.sh runs it with a cleaned env). It asks the GitHub door
// whether this job may run on our runner (checks 1–12). Exit 0 admitted, 77 refused (the reason annotated on the run),
// 2 the door is down (also fails the job). A `runner` refusal is retried for up to 10 s (the job's runner_name may lag).
import { DaemonDown, EXIT_REFUSED, GhDoorClient, ghRunClaims, refusedAnnotation, refusedLine, TrustRefused } from './http.ts'

const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')

export async function admit(env: NodeJS.ProcessEnv, o: { out: (s: string) => void; waitMs?: number; tries?: number }): Promise<number> {
  const down = (why: string) => {
    o.out(`::error title=ci-broker GitHub door down::${esc(why)}\n`)
    o.out(`ci-broker: the GitHub door is down: ${why}\n`)
    return 2
  }
  const sock = env.CI_BROKER_GITHUB_SOCKET
  if (!sock) return down('no CI_BROKER_GITHUB_SOCKET in the runner env (runner-start writes it into .env)')
  let c: GhDoorClient
  try {
    c = new GhDoorClient(sock, ghRunClaims(env))
  } catch (e) {
    return down((e as Error).message)
  }
  const tries = o.tries ?? 5
  for (let i = 1; ; i++) {
    try {
      const r = await c.admit()
      o.out(`ci-broker: admitted (${r.lane} lane): run ${c.claims.runId}.${c.claims.runAttempt} of ${c.claims.repo}\n`)
      return 0
    } catch (e) {
      if (e instanceof TrustRefused) {
        if (e.check === 'runner' && i < tries) {
          await new Promise((r) => setTimeout(r, o.waitMs ?? 2000))
          continue
        }
        o.out(`${refusedAnnotation(e)}\n`)
        o.out(`${refusedLine(e)}\n`)
        return EXIT_REFUSED
      }
      return down(e instanceof DaemonDown ? `no answer on ${sock}` : (e as Error).message)
    }
  }
}
