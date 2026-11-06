/**
 * Score Chat on Cloudflare: one Worker that serves the Foldkit client and
 * the API, a DocumentAgent Durable Object (SQLite) per document, a D1
 * database for accounts, Cloudflare Email Service for sign-in links, and a
 * queue with a container that converts PDFs.
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
import * as Output from 'alchemy/Output'
import { ACCESS_PATH } from './server/access.ts'
import type { Converter } from './server/conversions.ts'
import type { DocumentAgent } from './server/DocumentAgent.ts'
import type { Env } from './server/env.ts'

// Alchemy loads `.env` into Config, not `process.env`, so settings are read here.
const optional = (name: string) =>
  Config.String(name).pipe(Config.withDefault(''))
// There is no Access under `alchemy dev`, where sign-in links stand in for it.
const isDev = process.env.ALCHEMY_DEV === 'true'

export const Accounts = Cloudflare.D1.Database('Accounts', {
  migrations: './migrations',
})

// PDFs wait here for the queue; each is deleted once it has been converted.
export const ConversionUploads = Cloudflare.R2.Bucket('ConversionUploads', {
  lifecycleRules: [
    {
      id: 'expire-leftovers',
      deleteObjectsTransition: {
        condition: { type: 'Age', maxAge: 7 * 24 * 60 * 60 },
      },
    },
  ],
})
export const ConversionQueue = Cloudflare.Queues.Queue('ConversionQueue')

// Only prod answers on the public hostname; other stages stay on workers.dev.
const PROD_DOMAIN = 'score-chat.joepie.dev'

export const Web = Cloudflare.Website.Foldkit(
  'ScoreChat',
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage
    // Built by `npm run converter:build`. Without it PDF conversion stays off,
    // unless CONVERTER_URL points at a stand-in.
    const converterImage = yield* optional('CONVERTER_IMAGE').pipe(Effect.orDie)
    return {
      ...(stage === 'prod' ? { domain: PROD_DOMAIN } : {}),
      main: 'server/worker.ts',
      compatibility: { date: '2026-10-01', flags: ['nodejs_compat'] },
      // The API and document sockets reach the Worker; everything else is the
      // client build, with /d/<id> and /login falling back to index.html.
      assets: { runWorkerFirst: ['/api/*'] },
      env: {
        DB: Accounts,
        DOCUMENT_AGENT:
          Cloudflare.DurableObject<DocumentAgent>('DocumentAgent'),
        MAILER: Cloudflare.Email.SendEmail('MAILER'),
        CONVERSION_UPLOADS: ConversionUploads,
        CONVERSION_QUEUE: ConversionQueue,
        CONVERTER_URL: optional('CONVERTER_URL'),
        ...(converterImage
          ? {
              CONVERTER: Cloudflare.Container<Converter>('Converter', {
                className: 'Converter',
                image: converterImage,
                instanceType: 'standard-4',
                // The queue hands out one job at a time, so one instance is all
                // it can use, and all it can cost.
                maxInstances: 1,
              }),
            }
          : {}),
        // Sign-in: through Cloudflare Access when a Zero Trust team is set,
        // otherwise by links sent from EMAIL_FROM. Neither is a secret.
        ACCESS_TEAM_DOMAIN: isDev ? '' : optional('ACCESS_TEAM_DOMAIN'),
        ACCESS_AUD: optional('ACCESS_AUD'),
        EMAIL_FROM: optional('EMAIL_FROM'),
        // Not an Alchemy.Random: losing it would make every stored key unreadable.
        KEY_ENCRYPTION_SECRET: Config.Redacted('KEY_ENCRYPTION_SECRET'),
        // Tests point the agent at a stand-in for OpenRouter; empty means OpenRouter.
        OPENROUTER_URL: optional('OPENROUTER_URL'),
      },
    }
  }),
)

// The Worker's code is typed against server/env.ts; keep the two in step.
type Inferred = Cloudflare.InferEnv<typeof Web>
type Missing = Exclude<
  keyof Env,
  keyof Inferred | 'ALCHEMY_STAGE' | 'CONVERTER'
>
const bindingsMatch: [Missing] extends [never] ? true : Missing = true
void bindingsMatch

export default Alchemy.Stack(
  'ScoreChat',
  {
    providers: Cloudflare.providers(),
    // `alchemy dev` keeps its state in .alchemy/ and needs no account;
    // deploys share Alchemy's state store on the Cloudflare account.
    state: isDev ? Alchemy.localState() : Cloudflare.state(),
  },
  Effect.gen(function* () {
    // With a zone on Cloudflare, onboard the sender's domain for Email Service.
    const zoneId = yield* optional('EMAIL_ZONE_ID')
    if (zoneId) {
      const from = yield* Config.String('EMAIL_FROM')
      yield* Cloudflare.Email.SendingSubdomain('SignInMail', {
        zoneId,
        name: from.replace(/^.*@/, '').replace(/>$/, ''),
      })
    }
    const web = yield* Web
    const queue = yield* ConversionQueue
    yield* Cloudflare.Queues.Consumer('ConversionConsumer', {
      queueId: queue.queueId,
      scriptName: web.workerName,
      settings: {
        // One PDF at a time: a job can take minutes and the container runs one.
        batchSize: 1,
        maxConcurrency: 1,
        // The consumer reports failure itself after three attempts; the spare
        // retries cover invocations that were killed before they could.
        maxRetries: 5,
        retryDelay: 30,
      },
    })
    // Access guards only the sign-in path, so signed-out use, the API and
    // the document sockets stay open to Score Chat's own sessions.
    const team = yield* optional('ACCESS_TEAM_DOMAIN')
    if (team && !isDev) {
      const idp = yield* optional('ACCESS_IDP_ID')
      const signIn = yield* Cloudflare.Access.Application('SignIn', {
        type: 'self_hosted',
        name: 'Score Chat sign-in',
        domain: Output.map(
          web.url,
          (url) => `${new URL(url ?? 'https://invalid').host}${ACCESS_PATH}`,
        ),
        // Only long enough to land on the path; Score Chat's session lasts 30 days.
        sessionDuration: '30m',
        // Anyone who proves an address, typically with the one-time PIN.
        policies: [{ decision: 'allow', include: ['everyone'] }],
        ...(idp ? { allowedIdps: [idp], autoRedirectToIdentity: true } : {}),
        appLauncherVisible: false,
      })
      return { url: web.url, accessAud: signIn.aud }
    }
    return { url: web.url }
  }),
)
