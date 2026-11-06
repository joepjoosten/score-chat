// Runs a command against `alchemy dev`: starts the local Worker, Durable
// Objects and D1 with OpenRouter pointed at a test stand-in, waits until the
// app answers, runs the command, then stops everything.
//
//   node scripts/with-dev-server.mjs node --experimental-strip-types tests/server/agent.e2e.ts
import { spawn } from 'node:child_process'

const APP = process.env.APP_URL ?? 'http://localhost:1337'
const MOCK_ORIGIN = `http://127.0.0.1:${process.env.MOCK_OPENROUTER_PORT ?? 8788}`
const MOCK = `${MOCK_ORIGIN}/api/v1`
const [command, ...args] = process.argv.slice(2)
if (!command) throw new Error('Pass the command to run.')

const env = {
  ...process.env,
  OPENROUTER_URL: process.env.OPENROUTER_URL ?? MOCK,
  CONVERTER_URL: process.env.CONVERTER_URL ?? MOCK_ORIGIN,
  EMAIL_FROM: process.env.EMAIL_FROM ?? 'signin@example.com',
  // Local only: `alchemy dev` never shares this secret.
  KEY_ENCRYPTION_SECRET:
    process.env.KEY_ENCRYPTION_SECRET ?? 'local-test-secret',
}
const server = spawn('npx', ['alchemy', 'dev'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
})
let log = ''
server.stdout.on('data', (data) => (log += data))
server.stderr.on('data', (data) => (log += data))
const stop = () => {
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {}
}
process.on('exit', stop)
process.on('SIGINT', () => process.exit(130))

const deadline = Date.now() + 180_000
for (;;) {
  if (server.exitCode !== null) {
    console.error(log)
    throw new Error('alchemy dev exited before the app was ready.')
  }
  const ready = await fetch(APP).then(
    (response) => response.ok,
    () => false,
  )
  if (ready && /ready at/.test(log)) break
  if (Date.now() > deadline) {
    console.error(log)
    throw new Error(`${APP} did not answer within three minutes.`)
  }
  await new Promise((resolve) => setTimeout(resolve, 500))
}

const run = spawn(command, args, { env, stdio: 'inherit' })
run.on('exit', (code) => {
  if (code) console.error(log.split('\n').slice(-60).join('\n'))
  process.exit(code ?? 1)
})
