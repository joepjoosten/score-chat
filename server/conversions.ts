/**
 * PDF to LilyPond, in the background. The upload stores the PDF in R2 and
 * queues a message; the queue's consumer hands the PDF to the converter
 * container, one at a time, and turns its answer into a new document.
 *
 * Browsers follow along by polling the `conversions` table, so an outcome
 * also reaches someone who closed the tab in between.
 */
import { Container } from '@cloudflare/containers'
import { Cause, Data, Effect } from 'effect'
import { SqlClient } from 'effect/sql'
import { D1Client } from '@effect/sql-d1'
import {
  MAX_SOURCE_LENGTH,
  scoreTitle,
  type Conversion,
  type ConversionStatus,
} from '../shared/protocol.ts'
import { insertDocument } from './accounts.ts'
import type { Env } from './env.ts'

/** What runs at once for one person; the rest of the queue is everyone else's. */
const MAX_ACTIVE_PER_USER = 3
/** Well past any queue wait, so a job lost to an outage doesn't stay active forever. */
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000
/** A queue consumer gets 15 minutes. Past this the PDF won't finish on a later try either. */
const CONVERT_TIMEOUT_MS = 13 * 60 * 1000
/** Attempts before an unexpected failure is reported. Below the consumer's maxRetries in alchemy.run.ts. */
const MAX_ATTEMPTS = 3
const RETRY_DELAY_SECONDS = 30

export const CONVERTER_NAME = 'converter'

export interface ConversionMessage {
  readonly id: string
}

/** The sheet-to-ly recognizer, which sleeps when nothing has come in for a while. */
export class Converter extends Container<Env> {
  override defaultPort = 8080
  // Long enough to catch the next job in the queue with the models still loaded.
  override sleepAfter = '2m'
  // It reads untrusted PDFs and needs nothing from outside.
  override enableInternet = false
}

export class TooManyConversions extends Data.TaggedError(
  'TooManyConversions',
) {}

export const conversionsEnabled = (env: Env) =>
  Boolean(env.CONVERTER_URL || env.CONVERTER)

const pdfKey = (id: string) => `conversions/${id}.pdf`

const isPdf = (bytes: ArrayBuffer) =>
  new TextDecoder().decode(bytes.slice(0, 1024)).includes('%PDF-')

/** The browser's file name, kept to what's fit to show. */
export const cleanFileName = (name: string) =>
  name
    .replace(/[\p{Cc}/\\]/gu, ' ')
    .trim()
    .slice(0, 200) || 'score.pdf'

const titleFromFileName = (name: string) =>
  name.replace(/\.pdf$/i, '').trim() || 'Untitled score'

interface Row {
  id: string
  owner_id: string
  file_name: string
  status: ConversionStatus
  error: string | null
}

const toConversion = (row: Row): Conversion => ({
  id: row.id,
  fileName: row.file_name,
  status: row.status,
  error: row.error,
})

export const listConversions = (userId: string, now = Date.now()) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      UPDATE conversions
      SET status = 'failed', error = 'This conversion took too long. Try again.', updated_at = ${now}
      WHERE owner_id = ${userId} AND status IN ('queued', 'converting')
        AND created_at < ${now - ABANDONED_AFTER_MS}`
    const rows = yield* sql<Row>`
      SELECT id, owner_id, file_name, status, error FROM conversions
      WHERE owner_id = ${userId} ORDER BY created_at`
    return rows.map(toConversion)
  })

/** Takes in a PDF and queues it. Fails with InvalidPdf or TooManyConversions. */
export const startConversion = (
  env: Env,
  userId: string,
  fileName: string,
  pdf: ArrayBuffer,
  now = Date.now(),
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    if (!isPdf(pdf)) return yield* new InvalidPdf()
    const [active] = yield* sql<{ count: number }>`
      SELECT COUNT(*) AS count FROM conversions
      WHERE owner_id = ${userId} AND status IN ('queued', 'converting')
        AND created_at >= ${now - ABANDONED_AFTER_MS}`
    if ((active?.count ?? 0) >= MAX_ACTIVE_PER_USER)
      return yield* new TooManyConversions()
    const id = crypto.randomUUID()
    const name = cleanFileName(fileName)
    yield* Effect.promise(() => env.CONVERSION_UPLOADS.put(pdfKey(id), pdf))
    yield* sql`
      INSERT INTO conversions (id, owner_id, file_name, status, created_at, updated_at)
      VALUES (${id}, ${userId}, ${name}, 'queued', ${now}, ${now})`
    yield* Effect.promise(() =>
      env.CONVERSION_QUEUE.send({ id } satisfies ConversionMessage),
    )
    return {
      id,
      fileName: name,
      status: 'queued',
      error: null,
    } satisfies Conversion
  })

export class InvalidPdf extends Data.TaggedError('InvalidPdf') {}

/** Forgets a finished conversion. Its document, if any, stays. */
export const dismissConversion = (userId: string, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      DELETE FROM conversions
      WHERE id = ${id} AND owner_id = ${userId} AND status IN ('done', 'failed')`
  })

/** Asks the container, or under tests and local development, its stand-in. */
async function callConverter(env: Env, pdf: ArrayBuffer): Promise<Response> {
  const init = {
    method: 'POST',
    body: pdf,
    headers: { 'Content-Type': 'application/pdf' },
    signal: AbortSignal.timeout(CONVERT_TIMEOUT_MS),
  }
  if (env.CONVERTER_URL) return fetch(`${env.CONVERTER_URL}/convert`, init)
  const converter = env.CONVERTER!.getByName(CONVERTER_NAME)
  // A cold start pulls the image and loads the models before the port opens.
  await converter.startAndWaitForPorts({
    cancellationOptions: {
      instanceGetTimeoutMS: 120_000,
      portReadyTimeoutMS: 180_000,
    },
  })
  return converter.fetch('http://converter/convert', init)
}

type Outcome =
  | { readonly _tag: 'Converted'; readonly source: string }
  | { readonly _tag: 'Rejected'; readonly error: string }
  | { readonly _tag: 'Unavailable'; readonly reason: string }

async function convert(env: Env, pdf: ArrayBuffer): Promise<Outcome> {
  let response: Response
  try {
    response = await callConverter(env, pdf)
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      // It would keep working on the abandoned PDF and hold up the queue.
      await env.CONVERTER?.getByName(CONVERTER_NAME)
        .destroy()
        .catch(() => undefined)
      return {
        _tag: 'Rejected',
        error: 'This PDF took too long to convert. Try one with fewer pages.',
      }
    }
    return { _tag: 'Unavailable', reason: String(error) }
  }
  if (response.status === 422) {
    const { error } = (await response.json()) as { error: string }
    return { _tag: 'Rejected', error }
  }
  if (!response.ok)
    return { _tag: 'Unavailable', reason: `HTTP ${response.status}` }
  const { source } = (await response.json()) as { source: string }
  return { _tag: 'Converted', source }
}

const setStatus = (
  id: string,
  status: ConversionStatus,
  error: string | null = null,
  now = Date.now(),
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`
      UPDATE conversions SET status = ${status}, error = ${error}, updated_at = ${now}
      WHERE id = ${id}`
  })

const FAILED_UNEXPECTEDLY = 'Converting this PDF failed. Try again later.'

const handleMessage = (
  env: Env,
  message: Message<ConversionMessage>,
): Effect.Effect<void, unknown, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const { id } = message.body
    const [job] = yield* sql<Row>`
      SELECT id, owner_id, file_name, status, error FROM conversions WHERE id = ${id}`
    // Already finished by an earlier delivery, or dismissed.
    if (!job || job.status === 'done' || job.status === 'failed')
      return yield* finish(env, id, message)
    const object = yield* Effect.promise(() =>
      env.CONVERSION_UPLOADS.get(pdfKey(id)),
    )
    if (!object) {
      yield* setStatus(id, 'failed', FAILED_UNEXPECTEDLY)
      return yield* finish(env, id, message)
    }
    const pdf = yield* Effect.promise(() => object.arrayBuffer())
    yield* setStatus(id, 'converting')
    const outcome = yield* Effect.promise(() => convert(env, pdf))
    switch (outcome._tag) {
      case 'Unavailable':
        console.error('Conversion attempt failed', id, outcome.reason)
        if (message.attempts < MAX_ATTEMPTS) {
          yield* setStatus(id, 'queued')
          message.retry({ delaySeconds: RETRY_DELAY_SECONDS })
          return
        }
        yield* setStatus(id, 'failed', FAILED_UNEXPECTEDLY)
        break
      case 'Rejected':
        yield* setStatus(id, 'failed', outcome.error)
        break
      case 'Converted':
        if (outcome.source.length > MAX_SOURCE_LENGTH) {
          yield* setStatus(
            id,
            'failed',
            'The music in this PDF is too long for one document.',
          )
          break
        }
        yield* Effect.promise(() =>
          env.DOCUMENT_AGENT.getByName(id).initialize(
            id,
            job.owner_id,
            outcome.source,
          ),
        )
        yield* insertDocument(
          job.owner_id,
          id,
          documentTitle(outcome.source, job),
        )
        yield* setStatus(id, 'done')
        break
    }
    yield* finish(env, id, message)
  })

const documentTitle = (source: string, job: Row) => {
  const title = scoreTitle(source)
  return title === scoreTitle('') ? titleFromFileName(job.file_name) : title
}

const finish = (env: Env, id: string, message: Message<ConversionMessage>) =>
  Effect.promise(async () => {
    await env.CONVERSION_UPLOADS.delete(pdfKey(id))
    message.ack()
  })

/** The queue's consumer. An unforeseen failure goes back on the queue, up to a point. */
export async function handleQueue(
  batch: MessageBatch<ConversionMessage>,
  env: Env,
) {
  for (const message of batch.messages) {
    await Effect.runPromise(
      handleMessage(env, message).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            console.error('Conversion failed', Cause.pretty(cause))
            if (message.attempts < MAX_ATTEMPTS) {
              message.retry({ delaySeconds: RETRY_DELAY_SECONDS })
              return
            }
            yield* setStatus(message.body.id, 'failed', FAILED_UNEXPECTEDLY)
            message.ack()
          }),
        ),
        Effect.provide(D1Client.layer({ db: env.DB })),
        // Reporting the failure failed too: the spare retries try once more.
        Effect.catchCause(() =>
          Effect.sync(() =>
            message.retry({ delaySeconds: RETRY_DELAY_SECONDS }),
          ),
        ),
      ),
    )
  }
}
