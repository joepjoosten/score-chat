/**
 * Score Chat on Cloudflare: one Worker that serves the Foldkit client and
 * the API, a DocumentAgent Durable Object (SQLite) per document, a D1
 * database for accounts, and Cloudflare Email Service for sign-in links.
 *
 *   npx alchemy dev                 # local workerd, Vite with live reload
 *   npx alchemy deploy --stage prod # build and deploy
 *
 * Configuration comes from the environment or `.env` (see `.env.example`).
 */
import * as Alchemy from 'alchemy'
import * as Cloudflare from '@alchemy.run/cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import type { DocumentAgent } from './server/DocumentAgent.ts'
import type { Env } from './server/env.ts'

export const Accounts = Cloudflare.D1.Database('Accounts', {
  migrations: './migrations',
})

export const Web = Cloudflare.Website.Foldkit('ScoreChat', {
  main: 'server/worker.ts',
  compatibility: { date: '2026-10-01', flags: ['nodejs_compat'] },
  // The API and document sockets reach the Worker; everything else is the
  // client build, with /d/<id> and /login falling back to index.html.
  assets: { runWorkerFirst: ['/api/*'] },
  env: {
    DB: Accounts,
    DOCUMENT_AGENT: Cloudflare.DurableObject<DocumentAgent>('DocumentAgent'),
    MAILER: Cloudflare.Email.SendEmail('MAILER'),
    EMAIL_FROM: Config.String('EMAIL_FROM'),
    // Not an Alchemy.Random: losing it would make every stored key unreadable.
    KEY_ENCRYPTION_SECRET: Config.Redacted('KEY_ENCRYPTION_SECRET'),
    // Tests point the agent at a stand-in for OpenRouter; empty means OpenRouter.
    OPENROUTER_URL: process.env.OPENROUTER_URL ?? '',
  },
})

// The Worker's code is typed against server/env.ts; keep the two in step.
type Inferred = Cloudflare.InferEnv<typeof Web>
type Missing = Exclude<keyof Env, keyof Inferred | 'ALCHEMY_STAGE'>
const bindingsMatch: [Missing] extends [never] ? true : Missing = true
void bindingsMatch

export default Alchemy.Stack(
  'ScoreChat',
  {
    providers: Cloudflare.providers(),
    // `alchemy dev` keeps its state in .alchemy/ and needs no account;
    // deploys share Alchemy's state store on the Cloudflare account.
    state:
      process.env.ALCHEMY_DEV === 'true'
        ? Alchemy.localState()
        : Cloudflare.state(),
  },
  Effect.gen(function* () {
    // With a zone on Cloudflare, onboard the sender's domain for Email Service.
    const zoneId = yield* Config.String('EMAIL_ZONE_ID').pipe(
      Config.withDefault(''),
    )
    if (zoneId) {
      const from = yield* Config.String('EMAIL_FROM')
      yield* Cloudflare.Email.SendingSubdomain('SignInMail', {
        zoneId,
        name: from.replace(/^.*@/, '').replace(/>$/, ''),
      })
    }
    const web = yield* Web
    return { url: web.url }
  }),
)
