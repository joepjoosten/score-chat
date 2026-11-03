/**
 * The Score Chat Worker: serves the client build, the account and document
 * API, and forwards document WebSockets to their DocumentAgent.
 */
import { env as workerEnv } from 'cloudflare:workers'
import { Cause, Effect, Layer, Option, Schema } from 'effect'
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/http'
import { D1Client } from '@effect/sql-d1'
import {
  CreateDocument,
  RequestLogin,
  UpdateSettings,
  VerifyLogin,
  scoreTitle,
  type Me,
} from '../shared/protocol.ts'
import {
  LOGIN_LINK_MINUTES,
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
  updateSettings,
} from './accounts.ts'
import { USER_HEADER } from './DocumentAgent.ts'
import type { Env } from './env.ts'

export { DocumentAgent } from './DocumentAgent.ts'

const env = workerEnv as unknown as Env
const SESSION_COOKIE = 'sc_session'

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
    'POST',
    '/api/auth/request',
    handleErrors(
      Effect.gen(function* () {
        const { email } = yield* HttpServerRequest.schemaBodyJson(RequestLogin)
        const request = yield* webRequest
        const created = yield* createLoginToken(email)
        if (Option.isSome(created)) {
          const link = `${new URL(request.url).origin}/login?token=${created.value.token}`
          // Locally, the simulated mailer only writes a file; print the link too.
          if (env.ALCHEMY_STAGE?.startsWith('dev'))
            console.log(`Sign-in link for ${created.value.email}: ${link}`)
          yield* Effect.tryPromise(() =>
            env.MAILER.send({
              from: env.EMAIL_FROM,
              to: created.value.email,
              ...signInEmail(link, created.value.email),
            }),
          ).pipe(
            Effect.tapError((error) =>
              Effect.sync(() =>
                console.error('Sign-in email failed', String(error)),
              ),
            ),
            Effect.orElseSucceed(() => undefined),
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
} satisfies ExportedHandler<Env>
