/**
 * The Score Chat Worker: serves the client build, the account and document
 * API, and forwards document WebSockets to their DocumentAgent.
 */
import { env as workerEnv } from 'cloudflare:workers'
import { Cause, Data, Effect, Layer, Option, Schema } from 'effect'
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http'
import { D1Client } from '@effect/sql-d1'
import {
  CreateDocument,
  MAX_PDF_BYTES,
  RequestLogin,
  UpdateSettings,
  VerifyLogin,
  scoreTitle,
  type SignInConfig,
  type Me,
} from '../shared/protocol.ts'
import {
  LOGIN_LINK_MINUTES,
  NotFound,
  SESSION_DAYS,
  createLoginToken,
  endSession,
  getSettings,
  insertDocument,
  listDocuments,
  redeemLoginToken,
  removeDocument,
  requireOwnDocument,
  sessionUser,
  startSession,
  updateSettings,
} from './accounts.ts'
import { ACCESS_PATH, teamOrigin, verifyAccessToken } from './access.ts'
import {
  type ConversionMessage,
  conversionsEnabled,
  dismissConversion,
  handleQueue,
  listConversions,
  startConversion,
} from './conversions.ts'
import { USER_HEADER } from './DocumentAgent.ts'
import type { Env } from './env.ts'

export { Converter } from './conversions.ts'
export { DocumentAgent } from './DocumentAgent.ts'

const env = workerEnv as unknown as Env

class PdfTooLarge extends Data.TaggedError('PdfTooLarge') {}

const SESSION_COOKIE = 'sc_session'

/** Cloudflare Access when a Zero Trust team is configured, else emailed links. */
const signInMethod = (): SignInConfig['method'] =>
  env.ACCESS_TEAM_DOMAIN ? 'access' : 'email'

const webRequest = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => request.source as Request,
)

const currentUser = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  return yield* sessionUser(request.cookies[SESSION_COOKIE])
})

const sessionCookie = (
  response: HttpServerResponse.HttpServerResponse,
  value: string,
  secure: boolean,
) =>
  HttpServerResponse.setCookie(response, SESSION_COOKIE, value, {
    httpOnly: true,
    secure,
    sameSite: 'lax',
    path: '/',
    maxAge: `${SESSION_DAYS} days`,
  })

const isSecure = Effect.map(
  webRequest,
  (request) => new URL(request.url).protocol === 'https:',
)

const signInEmail = (link: string, email: string) => ({
  subject: 'Your Score Chat sign-in link',
  text: `Open this link to sign in to Score Chat as ${email}:\n\n${link}\n\nIt works once, for ${LOGIN_LINK_MINUTES} minutes. If you didn't ask to sign in, ignore this email.`,
  html: `<p>Open this link to sign in to Score Chat as ${escapeHtml(email)}:</p><p><a href="${link}">Sign in to Score Chat</a></p><p>It works once, for ${LOGIN_LINK_MINUTES} minutes. If you didn't ask to sign in, ignore this email.</p>`,
})

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

const me = (user: { id: string; email: string }) =>
  Effect.map(getSettings(user.id), (settings): Me => ({ user, settings }))

const errorResponse = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error }, { status })

const expected: Record<string, [number, string]> = {
  Unauthorized: [401, 'Sign in to continue.'],
  NotFound: [404, 'Not found.'],
  InvalidEmail: [400, 'Enter a valid email address.'],
  InvalidLink: [
    400,
    'This sign-in link has expired or was already used. Request a new one.',
  ],
  InvalidPdf: [400, 'This file is not a PDF.'],
  PdfTooLarge: [413, 'Choose a PDF smaller than 50 MB.'],
  TooManyConversions: [
    429,
    'You have three conversions running. Wait for one to finish.',
  ],
  SchemaError: [400, 'The request was not valid.'],
  HttpServerError: [400, 'The request was not valid.'],
}

/** Expected failures become their status; anything else is logged and hidden behind a 500. */
const handleErrors = <E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  handler.pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        const error = Cause.squash(cause) as { _tag?: string } | undefined
        const known = error?._tag ? expected[error._tag] : undefined
        if (known) return errorResponse(...known)
        console.error('API request failed', String(cause).slice(0, 1000))
        return errorResponse(500, 'Something went wrong. Try again.')
      }),
    ),
  )

const Routes = Layer.mergeAll(
  HttpRouter.add(
    'GET',
    '/api/me',
    handleErrors(
      Effect.gen(function* () {
        const user = yield* currentUser
        return yield* HttpServerResponse.json(yield* me(user))
      }),
    ),
  ),
  HttpRouter.add(
    'GET',
    '/api/auth/config',
    handleErrors(
      HttpServerResponse.json({
        method: signInMethod(),
        conversions: conversionsEnabled(env),
      } satisfies SignInConfig),
    ),
  ),
  // Cloudflare Access guards only this path. Whoever reaches it has signed in
  // with Access; the token proves which address, and Score Chat's own session
  // takes over from there.
  HttpRouter.add(
    'GET',
    ACCESS_PATH,
    handleErrors(
      Effect.gen(function* () {
        const request = yield* webRequest
        const token = request.headers.get('Cf-Access-Jwt-Assertion')
        const claims =
          token && signInMethod() === 'access'
            ? yield* Effect.promise(() =>
                verifyAccessToken(token, teamOrigin(env.ACCESS_TEAM_DOMAIN), {
                  ...(env.ACCESS_AUD ? { audience: env.ACCESS_AUD } : {}),
                }).catch((error) => {
                  console.error('Access sign-in failed', String(error))
                  return undefined
                }),
              )
            : undefined
        // The app reads the outcome from its session, so both cases land there.
        const done = HttpServerResponse.redirect('/login?via=access', {
          status: 302,
        })
        if (!claims) return done
        const { session } = yield* startSession(claims.email)
        return yield* sessionCookie(done, session, yield* isSecure)
      }),
    ),
  ),
  HttpRouter.add(
    'POST',
    '/api/auth/request',
    handleErrors(
      Effect.gen(function* () {
        if (signInMethod() !== 'email') return yield* new NotFound()
        const { email } = yield* HttpServerRequest.schemaBodyJson(RequestLogin)
        const request = yield* webRequest
        const created = yield* createLoginToken(email)
        if (Option.isSome(created)) {
          const link = `${new URL(request.url).origin}/login?token=${created.value.token}`
          // Locally, the simulated mailer only writes a file; print the link too.
          if (env.ALCHEMY_STAGE?.startsWith('dev'))
            console.log(`Sign-in link for ${created.value.email}: ${link}`)
          // A failed send is reported: the dialog must not claim a link went out.
          yield* Effect.tryPromise(() =>
            env.MAILER.send({
              from: env.EMAIL_FROM,
              to: created.value.email,
              ...signInEmail(link, created.value.email),
            }),
          )
        }
        // The same answer whether or not the address has an account or hit the limit.
        return yield* HttpServerResponse.json({ ok: true })
      }),
    ),
  ),
  HttpRouter.add(
    'POST',
    '/api/auth/verify',
    handleErrors(
      Effect.gen(function* () {
        const { token } = yield* HttpServerRequest.schemaBodyJson(VerifyLogin)
        const { user, session } = yield* redeemLoginToken(token)
        const response = yield* HttpServerResponse.json(yield* me(user))
        return yield* sessionCookie(response, session, yield* isSecure)
      }),
    ),
  ),
  HttpRouter.add(
    'POST',
    '/api/auth/logout',
    handleErrors(
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        yield* endSession(request.cookies[SESSION_COOKIE])
        return yield* HttpServerResponse.expireCookie(
          HttpServerResponse.empty({ status: 204 }),
          SESSION_COOKIE,
          { path: '/' },
        )
      }),
    ),
  ),
  HttpRouter.add(
    'PUT',
    '/api/settings',
    handleErrors(
      Effect.gen(function* () {
        const user = yield* currentUser
        const update = yield* HttpServerRequest.schemaBodyJson(UpdateSettings)
        const settings = yield* updateSettings(
          user.id,
          update,
          env.KEY_ENCRYPTION_SECRET,
        )
        return yield* HttpServerResponse.json({ user, settings } satisfies Me)
      }),
    ),
  ),
  HttpRouter.add(
    'GET',
    '/api/documents',
    handleErrors(
      Effect.gen(function* () {
        const user = yield* currentUser
        return yield* HttpServerResponse.json({
          documents: yield* listDocuments(user.id),
        })
      }),
    ),
  ),
  HttpRouter.add(
    'POST',
    '/api/documents',
    handleErrors(
      Effect.gen(function* () {
        const user = yield* currentUser
        const { source } =
          yield* HttpServerRequest.schemaBodyJson(CreateDocument)
        const id = crypto.randomUUID()
        yield* Effect.promise(() =>
          env.DOCUMENT_AGENT.getByName(id).initialize(id, user.id, source),
        )
        yield* insertDocument(user.id, id, scoreTitle(source))
        return yield* HttpServerResponse.json({ id }, { status: 201 })
      }),
    ),
  ),
  HttpRouter.add(
    'DELETE',
    '/api/documents/:id',
    handleErrors(
      Effect.gen(function* () {
        const user = yield* currentUser
        const { id } = yield* HttpRouter.schemaPathParams(
          Schema.Struct({ id: Schema.String }),
        )
        yield* requireOwnDocument(user.id, id)
        yield* Effect.promise(() => env.DOCUMENT_AGENT.getByName(id).destroy())
        yield* removeDocument(user.id, id)
        return HttpServerResponse.empty({ status: 204 })
      }),
    ),
  ),
  HttpRouter.add(
    'GET',
    '/api/conversions',
    handleErrors(
      Effect.gen(function* () {
        const user = yield* currentUser
        return yield* HttpServerResponse.json({
          conversions: yield* listConversions(user.id),
        })
      }),
    ),
  ),
  // The body is the PDF itself, and the query its file name.
  HttpRouter.add(
    'POST',
    '/api/conversions',
    handleErrors(
      Effect.gen(function* () {
        const user = yield* currentUser
        if (!conversionsEnabled(env)) return yield* new NotFound()
        const request = yield* webRequest
        const declared = Number(request.headers.get('Content-Length') ?? 0)
        if (declared > MAX_PDF_BYTES) return yield* new PdfTooLarge()
        const pdf = yield* Effect.promise(() => request.arrayBuffer())
        if (pdf.byteLength > MAX_PDF_BYTES) return yield* new PdfTooLarge()
        const name = new URL(request.url).searchParams.get('name') ?? ''
        const conversion = yield* startConversion(env, user.id, name, pdf)
        return yield* HttpServerResponse.json(conversion, { status: 202 })
      }),
    ),
  ),
  HttpRouter.add(
    'DELETE',
    '/api/conversions/:id',
    handleErrors(
      Effect.gen(function* () {
        const user = yield* currentUser
        const { id } = yield* HttpRouter.schemaPathParams(
          Schema.Struct({ id: Schema.String }),
        )
        yield* dismissConversion(user.id, id)
        return HttpServerResponse.empty({ status: 204 })
      }),
    ),
  ),
  // A scanned staff of a converted score, for as long as its review lasts.
  HttpRouter.add(
    'GET',
    '/api/documents/:id/scans/:system/:staff',
    handleErrors(
      Effect.gen(function* () {
        const user = yield* currentUser
        const { id, system, staff } = yield* HttpRouter.schemaPathParams(
          Schema.Struct({
            id: Schema.String,
            system: Schema.String,
            staff: Schema.String,
          }),
        )
        yield* requireOwnDocument(user.id, id)
        const image = yield* Effect.promise(() =>
          env.DOCUMENT_AGENT.getByName(id).scan(Number(system), Number(staff)),
        )
        if (!image) return yield* new NotFound()
        return HttpServerResponse.uint8Array(image, {
          contentType: 'image/jpeg',
          // A scan never changes, and a document ID is never used again.
          headers: { 'Cache-Control': 'private, max-age=86400' },
        })
      }),
    ),
  ),
  HttpRouter.add(
    'GET',
    '/api/documents/:id/socket',
    handleErrors(
      Effect.gen(function* () {
        const user = yield* currentUser
        const { id } = yield* HttpRouter.schemaPathParams(
          Schema.Struct({ id: Schema.String }),
        )
        yield* requireOwnDocument(user.id, id)
        const request = yield* webRequest
        if (request.headers.get('Upgrade') !== 'websocket')
          return HttpServerResponse.text('Expected a WebSocket', {
            status: 426,
          })
        // The object trusts this header, so it is always set here, never passed through.
        const headers = new Headers(request.headers)
        headers.set(USER_HEADER, user.id)
        const response = yield* Effect.promise(() =>
          env.DOCUMENT_AGENT.getByName(id).fetch(
            new Request(request.url, { headers }),
          ),
        )
        // The 101 response carries the WebSocket, so it is passed through untouched.
        return HttpServerResponse.raw(response)
      }),
    ),
  ),
).pipe(
  HttpRouter.provideRequest(
    Layer.unwrap(Effect.sync(() => D1Client.layer({ db: env.DB }))),
  ),
)

const Api = Routes.pipe(Layer.provide(HttpServer.layerServices))

let api:
  ReturnType<typeof HttpRouter.toWebHandler<any, any, any, any>> | undefined

/** State-changing requests and WebSockets must come from this site's own pages. */
function sameOrigin(request: Request, url: URL) {
  if (
    request.method === 'GET' &&
    request.headers.get('Upgrade') !== 'websocket'
  )
    return true
  const origin = request.headers.get('Origin')
  return origin === url.origin
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname.startsWith('/api/')) {
      if (!sameOrigin(request, url))
        return Response.json({ error: 'Forbidden.' }, { status: 403 })
      api ??= HttpRouter.toWebHandler(Api, { disableLogger: true })
      return api.handler(request)
    }
    const response = await env.ASSETS.fetch(request)
    // Client routes such as /d/<id> get the app shell, in dev as well as deployed.
    if (
      response.status === 404 &&
      request.method === 'GET' &&
      !url.pathname.includes('.')
    )
      return env.ASSETS.fetch(new Request(new URL('/', url), request))
    return response
  },
  queue: handleQueue,
} satisfies ExportedHandler<Env, ConversionMessage>
