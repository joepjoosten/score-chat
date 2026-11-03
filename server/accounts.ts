/**
 * Accounts in D1: magic-link sign-in, sessions, agent settings and each
 * user's document index. Every function needs a SqlClient over the D1 binding.
 */
import { Data, Effect, Option } from 'effect'
import { SqlClient } from 'effect/sql'
import {
  DEFAULT_MODEL,
  reasoningEfforts,
  type AgentSettings,
  type DocumentSummary,
  type ReasoningEffort,
  type UpdateSettings,
  type User,
} from '../shared/protocol.ts'
import {
  decryptSecret,
  encryptSecret,
  hashToken,
  randomToken,
} from './crypto.ts'

export const LOGIN_LINK_MINUTES = 15
export const SESSION_DAYS = 30
/** Sign-in links one address may request per hour; more are silently dropped. */
const LINKS_PER_HOUR = 5
const DAY = 24 * 60 * 60 * 1000

export class InvalidEmail extends Data.TaggedError('InvalidEmail')<{}> {}
export class InvalidLink extends Data.TaggedError('InvalidLink')<{}> {}
export class Unauthorized extends Data.TaggedError('Unauthorized')<{}> {}
export class NotFound extends Data.TaggedError('NotFound')<{}> {}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export const normalizeEmail = (email: string) => email.trim().toLowerCase()

/**
 * Creates a sign-in link for an address, or nothing when it has asked for too
 * many recently. The caller sends the link; the response never says which.
 */
export const createLoginToken = (rawEmail: string, now = Date.now()) =>
  Effect.gen(function* () {
    const email = normalizeEmail(rawEmail)
    if (!EMAIL.test(email) || email.length > 320)
      return yield* new InvalidEmail()
    const sql = yield* SqlClient.SqlClient
    const [recent] = yield* sql<{ count: number }>`
      SELECT count(*) AS count FROM login_tokens
      WHERE email = ${email} AND created_at > ${now - 60 * 60 * 1000}`
    if ((recent?.count ?? 0) >= LINKS_PER_HOUR)
      return Option.none<{ email: string; token: string }>()
    const token = randomToken()
    yield* sql`
      INSERT INTO login_tokens (token_hash, email, created_at, expires_at)
      VALUES (${yield* Effect.promise(() => hashToken(token))}, ${email}, ${now},
              ${now + LOGIN_LINK_MINUTES * 60 * 1000})`
    // Expired links are of no use to anyone.
    yield* sql`DELETE FROM login_tokens WHERE expires_at < ${now - DAY}`
    return Option.some({ email, token })
  })

/** Redeems a sign-in link once, creating the account on first use, and starts a session. */
export const redeemLoginToken = (token: string, now = Date.now()) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const hash = yield* Effect.promise(() => hashToken(token))
    // Marking it used in the same statement makes a link work exactly once.
    const [link] = yield* sql<{ email: string }>`
      UPDATE login_tokens SET used_at = ${now}
      WHERE token_hash = ${hash} AND used_at IS NULL AND expires_at > ${now}
      RETURNING email`
    if (!link) return yield* new InvalidLink()
    return yield* startSession(link.email, now)
  })

/**
 * Signs in an address someone has proven they own (a sign-in link, or
 * Cloudflare Access), creating the account on first use.
 */
export const startSession = (rawEmail: string, now = Date.now()) =>
  Effect.gen(function* () {
    const email = normalizeEmail(rawEmail)
    if (!EMAIL.test(email)) return yield* new InvalidEmail()
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO users (id, email, created_at)
      VALUES (${crypto.randomUUID()}, ${email}, ${now})
      ON CONFLICT (email) DO NOTHING`
    const [user] = yield* sql<User>`
      SELECT id, email FROM users WHERE email = ${email}`
    const session = randomToken()
    yield* sql`
      INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
      VALUES (${yield* Effect.promise(() => hashToken(session))}, ${user!.id}, ${now},
              ${now + SESSION_DAYS * DAY})`
    return { user: { id: user!.id, email: user!.email }, session }
  })

/** The signed-in user of a session cookie. */
export const sessionUser = (session: string | undefined, now = Date.now()) =>
  Effect.gen(function* () {
    if (!session) return yield* new Unauthorized()
    const sql = yield* SqlClient.SqlClient
    const hash = yield* Effect.promise(() => hashToken(session))
    const [user] = yield* sql<User>`
      SELECT users.id, users.email FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ${hash} AND sessions.expires_at > ${now}`
    if (!user) return yield* new Unauthorized()
    return { id: user.id, email: user.email } satisfies User
  })

export const endSession = (session: string | undefined) =>
  Effect.gen(function* () {
    if (!session) return
    const sql = yield* SqlClient.SqlClient
    const hash = yield* Effect.promise(() => hashToken(session))
    yield* sql`DELETE FROM sessions WHERE token_hash = ${hash}`
  })

// ---------------------------------------------------------------------------
// Agent settings

interface SettingsRow {
  model: string
  reasoning: string | null
  api_key: string | null
}

const readSettings = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<SettingsRow>`
      SELECT model, reasoning, api_key FROM settings WHERE user_id = ${userId}`
    return row
  })

const effort = (value: string | null | undefined): ReasoningEffort | null =>
  reasoningEfforts.find((level) => level === value) ?? null

export const getSettings = (userId: string) =>
  Effect.map(readSettings(userId), (row): AgentSettings => ({
    model: row?.model ?? DEFAULT_MODEL,
    reasoning: effort(row?.reasoning),
    hasApiKey: !!row?.api_key,
  }))

export const updateSettings = (
  userId: string,
  update: UpdateSettings,
  secret: string,
  now = Date.now(),
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const current = yield* readSettings(userId)
    const model = update.model?.trim() || current?.model || DEFAULT_MODEL
    const reasoning =
      update.reasoning === undefined
        ? effort(current?.reasoning)
        : update.reasoning
    const key = update.apiKey?.trim()
    const apiKey =
      update.apiKey === undefined
        ? (current?.api_key ?? null)
        : key
          ? yield* Effect.promise(() => encryptSecret(key, secret, userId))
          : null
    yield* sql`
      INSERT INTO settings (user_id, model, reasoning, api_key, updated_at)
      VALUES (${userId}, ${model}, ${reasoning}, ${apiKey}, ${now})
      ON CONFLICT (user_id) DO UPDATE SET model = excluded.model,
        reasoning = excluded.reasoning, api_key = excluded.api_key,
        updated_at = excluded.updated_at`
    return yield* getSettings(userId)
  })

/** What an agent run needs: the model settings and the decrypted key, if one is stored. */
export const agentCredentials = (userId: string, secret: string) =>
  Effect.gen(function* () {
    const row = yield* readSettings(userId)
    const apiKey = row?.api_key
      ? yield* Effect.tryPromise(() =>
          decryptSecret(row.api_key!, secret, userId),
        ).pipe(Effect.orElseSucceed(() => undefined))
      : undefined
    return {
      model: row?.model ?? DEFAULT_MODEL,
      reasoning: effort(row?.reasoning),
      apiKey,
    }
  })

// ---------------------------------------------------------------------------
// Document index

export const listDocuments = (userId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql<{ id: string; title: string; updated_at: number }>`
      SELECT id, title, updated_at FROM documents
      WHERE owner_id = ${userId} ORDER BY updated_at DESC`
    return rows.map((row): DocumentSummary => ({
      id: row.id,
      title: row.title,
      updatedAt: row.updated_at,
    }))
  })

export const insertDocument = (
  userId: string,
  id: string,
  title: string,
  now = Date.now(),
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      INSERT INTO documents (id, owner_id, title, created_at, updated_at)
      VALUES (${id}, ${userId}, ${title}, ${now}, ${now})`
  })

export const requireOwnDocument = (userId: string, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const [row] = yield* sql<{ id: string }>`
      SELECT id FROM documents WHERE id = ${id} AND owner_id = ${userId}`
    if (!row) return yield* new NotFound()
  })

export const removeDocument = (userId: string, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`DELETE FROM documents WHERE id = ${id} AND owner_id = ${userId}`
  })

/** Keeps the index's title and order in step with the document. */
export const touchDocument = (id: string, title: string, now = Date.now()) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      UPDATE documents SET title = ${title}, updated_at = ${now} WHERE id = ${id}`
  })
