/** The Worker's HTTP API, decoded with the shared schemas. */
import { Effect, Schema } from 'effect'
import {
  ApiError,
  CreatedDocument,
  DocumentList,
  Me,
  type UpdateSettings,
} from '../shared/protocol.ts'

/** A failed request, with a message fit to show. */
export class ApiFailure {
  readonly _tag = 'ApiFailure'
  constructor(
    readonly message: string,
    readonly status: number,
  ) {}
}

const OFFLINE =
  'Score Chat could not reach its server. Check your connection and try again.'

function request<A>(
  schema: Schema.Codec<A, any>,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Effect.Effect<A, ApiFailure> {
  return Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(path, {
        method: init.method ?? 'GET',
        credentials: 'same-origin',
        signal,
        headers:
          init.body === undefined ? {} : { 'Content-Type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      })
      const text = await response.text()
      const json = text ? JSON.parse(text) : null
      if (!response.ok) {
        const error = Schema.decodeUnknownOption(ApiError)(json)
        throw new ApiFailure(
          error._tag === 'Some'
            ? error.value.error
            : `The server answered with HTTP ${response.status}.`,
          response.status,
        )
      }
      return Schema.decodeUnknownSync(schema)(json)
    },
    catch: (error) =>
      error instanceof ApiFailure ? error : new ApiFailure(OFFLINE, 0),
  })
}

const Ok = Schema.Unknown

export const fetchMe = request(Me, '/api/me')
export const requestLoginLink = (email: string) =>
  request(Ok, '/api/auth/request', { method: 'POST', body: { email } })
export const verifyLogin = (token: string) =>
  request(Me, '/api/auth/verify', { method: 'POST', body: { token } })
export const logout = request(Ok, '/api/auth/logout', { method: 'POST' })
export const saveSettings = (update: UpdateSettings) =>
  request(Me, '/api/settings', { method: 'PUT', body: update })
export const fetchDocuments = request(DocumentList, '/api/documents')
export const createDocument = (source: string) =>
  request(CreatedDocument, '/api/documents', {
    method: 'POST',
    body: { source },
  })
export const deleteDocument = (id: string) =>
  request(Ok, `/api/documents/${encodeURIComponent(id)}`, { method: 'DELETE' })

export const socketUrl = (id: string) => {
  const url = new URL(
    `/api/documents/${encodeURIComponent(id)}/socket`,
    location.href,
  )
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
