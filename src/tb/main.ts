// test-brokerd: the machine config, the broker, the socket. Runs as the dev user (a user systemd unit).
import { mkdirSync } from 'node:fs'
import { Broker } from './broker.ts'
import { loadMachineConfig, socketPath, stateDir } from './machine-config.ts'
import { BrokerServer, serverLog, setServerLogFile } from './server.ts'
import { startBoat } from './boat-side.ts'
import { join } from 'node:path'
import { RunsDb } from './runs-db.ts'

async function main() {
  const cfg = loadMachineConfig()
  const dir = stateDir()
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  setServerLogFile(join(dir, 'test-brokerd.log'))
  // usage accounting: a runs.db that won't open costs the accounting, never the daemon
  let usage: RunsDb | null = null
  try {
    usage = new RunsDb(join(dir, 'runs.db'))
  } catch (e) {
    serverLog(`usage off: ${(e as Error).message}`)
  }
  const broker = new Broker({ cfg, stateDir: dir, log: serverLog, usage })
  const boat = await startBoat(cfg, dir, serverLog, usage)
  broker.setBoat(boat?.side ?? null)
  const server = new BrokerServer(broker, boat?.runs ?? null, serverLog)
  const sock = socketPath()
  await server.listen(sock)
  // runs left open by the last daemon (a restart cut them): closed, so steering does not count them. Only once
  // the socket is ours: a second daemon started by mistake exits at listen() before it touches the live daemon's runs
  if (usage)
    try {
      const n = usage.closeOpen(Date.now())
      if (n) serverLog(`usage: ${n} run(s) left open by the last daemon closed as 'daemon restart'`)
    } catch (e) {
      serverLog(`usage: closing open runs: ${(e as Error).message}`)
    }
  serverLog(`test-brokerd listening on ${sock} (budget ${cfg.budgetFactor} × nproc; boat ${boat ? 'on' : 'off'})`)
  const stop = async (sig: string) => {
    serverLog(`${sig}: stopping`)
    await boat?.stop()
    await server.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop('SIGTERM'))
  process.on('SIGINT', () => void stop('SIGINT'))
}

main().catch((e) => {
  serverLog(`test-brokerd: ${(e as Error).stack ?? e}`)
  process.exit(1)
})
