/**
 * One Durable Object per document. It owns the score, the conversation and
 * the agent: a turn runs here, independent of any browser, and every change
 * is stored as a numbered event. Browsers connect over a hibernatable
 * WebSocket and catch up from the last event they saw, so a slow or dropped
 * connection only delays what the user sees, never the work.
 */
import { DurableObject } from 'cloudflare:workers'
import { Cause, Effect, Exit, Fiber, Schema } from 'effect'
import { Prompt } from 'effect/ai'
import { D1Client } from '@effect/sql-d1'
import {
  appendChunk,
  ClientCommandJson,
  scoreTitle,
  type ChatMessage,
  type ClientCommand,
  type MessagePart,
  type PartKind,
  type Run,
  type SelectedNote,
  type ServerEvent,
} from '../shared/protocol.ts'
import { agentCredentials, touchDocument } from './accounts.ts'
import { describeFailure, runAgent } from './agent.ts'
import { assetFetcher, check, loadDocs } from './assets.ts'
import type { Env } from './env.ts'
import { history, systemPrompt } from './prompt.ts'
import { classifyErrors, type CheckPosition } from './renderer/check.js'
import type { ApplyOutcome } from './tools.ts'

/** The header the Worker sets to the signed-in user it checked. */
export const USER_HEADER = 'x-score-chat-user'

/** While a run is active, an alarm this often keeps it going, or resumes it after a restart. */
const HEARTBEAT = 15_000
/** How long an applied edit waits for a browser to engrave it. */
const RENDER_WAIT = 15_000
/** Streamed output is batched into events this often. */
const FLUSH_INTERVAL = 100
/** Events kept for replay; a browser further behind gets a snapshot. */
const KEEP_EVENTS = 4000
const SNAPSHOT_MESSAGES = 200
/** Resumes per run after restarts, before giving up. */
const MAX_RESUMES = 3
/** The document index is updated at most this often while the score changes. */
const TOUCH_DELAY = 2000

const PING = JSON.stringify({ _tag: 'Ping' })
const PONG = JSON.stringify({ _tag: 'Pong' })

type Stored = Exclude<
  ServerEvent,
  { _tag: 'Snapshot' | 'Replayed' | 'Problem' | 'Pong' }
>
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never

const PromptJson = Schema.fromJsonString(Prompt.Prompt)

/** Where a run can resume from: the prompt after its last finished step and what it had shown. */
interface Checkpoint {
  prompt: string
  text: string
  parts: MessagePart[]
  step: number
  spoke: boolean
  resumes: number
}

/** A browser's full render of an applied edit. */
interface RenderReport {
  errors: readonly string[]
  positions: readonly (CheckPosition | null)[]
}

interface Attachment {
  userId: string
  /** Set once the socket has caught up, so live events follow the replay. */
  ready: boolean
}

class MissingKey {
  readonly _tag = 'MissingKey'
}

function migrate(sql: SqlStorage) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      position INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      checkpoint TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `)
}

export class DocumentAgent extends DurableObject<Env> {
  private readonly sql: SqlStorage
  /** The running turn, when it runs in this instance. */
  private fiber: Fiber.Fiber<void, unknown> | undefined
  /** The assistant message the running turn streams into. */
  private streaming: ChatMessage | undefined
  private pending: { kind: PartKind; text: string }[] = []
  private flushTimer: ReturnType<typeof setTimeout> | undefined
  private touchTimer: ReturnType<typeof setTimeout> | undefined
  private readonly renderWaiters = new Map<
    number,
    (report: RenderReport) => void
  >()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    migrate(this.sql)
    // Keepalive pings are answered without waking a hibernating object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG))
  }

  // -------------------------------------------------------------------------
  // RPC from the Worker

  /** Sets up a new document. Calling it again does nothing. */
  async initialize(documentId: string, ownerId: string, source: string) {
    if (this.meta('owner')) return
    this.setMeta('id', documentId)
    this.setMeta('owner', ownerId)
    this.setMeta('source', source)
    this.setMeta('revision', '1')
    this.setMeta('seq', '0')
  }

  /** Deletes the document: stops its run, disconnects browsers and erases storage. */
  async destroy() {
    if (this.fiber) Effect.runFork(Fiber.interrupt(this.fiber))
    this.fiber = undefined
    for (const socket of this.ctx.getWebSockets())
      socket.close(4404, 'This document was deleted.')
    await this.ctx.storage.deleteAlarm()
    await this.ctx.storage.deleteAll()
  }

  override async fetch(request: Request): Promise<Response> {
    const userId = request.headers.get(USER_HEADER)
    if (request.headers.get('Upgrade') !== 'websocket')
      return new Response('Expected a WebSocket', { status: 426 })
    if (!userId || userId !== this.meta('owner'))
      return new Response('Not found', { status: 404 })
    const [client, server] = Object.values(new WebSocketPair())
    this.ctx.acceptWebSocket(server!)
    server!.serializeAttachment({ userId, ready: false } satisfies Attachment)
    return new Response(null, { status: 101, webSocket: client })
  }

  override async webSocketMessage(
    socket: WebSocket,
    data: string | ArrayBuffer,
  ) {
    const decoded = Schema.decodeUnknownExit(ClientCommandJson)(
      typeof data === 'string' ? data : new TextDecoder().decode(data),
    )
    if (Exit.isFailure(decoded))
      return this.problem(socket, 'The server did not understand that request.')
    this.handle(socket, decoded.value)
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
  ) {
    try {
      socket.close(code, reason)
    } catch {
      // Already closed.
    }
  }

  override async alarm() {
    const run = this.activeRun()
    if (!run) return
    if (!this.fiber) this.resume(run)
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT)
  }

  // -------------------------------------------------------------------------
  // Commands

  private handle(socket: WebSocket, command: ClientCommand) {
    switch (command._tag) {
      case 'Hello':
        return this.hello(socket, command.since)
      case 'Send':
        return this.send(socket, command.text, command.selection)
      case 'Stop':
        return this.stop()
      case 'SetSource':
        return this.edit(socket, command.source, command.baseRevision)
      case 'Rendered': {
        const waiter = this.renderWaiters.get(command.revision)
        this.renderWaiters.delete(command.revision)
        return waiter?.({
          errors: command.errors,
          positions: command.positions ?? [],
        })
      }
      case 'ClearChat':
        return this.clearChat(socket)
      case 'Ping':
        return socket.send(PONG)
    }
  }

  /** Brings a socket up to date: a replay of what it missed, or a snapshot. */
  private hello(socket: WebSocket, since: number | null) {
    const seq = this.seq()
    const first = this.sql
      .exec<{ first: number | null }>('SELECT min(seq) AS first FROM events')
      .one().first
    const canReplay =
      since !== null && since <= seq && since >= (first ?? seq + 1) - 1
    if (canReplay) {
      for (const row of this.sql.exec<{ body: string }>(
        'SELECT body FROM events WHERE seq > ? ORDER BY seq',
        since,
      ))
        socket.send(row.body)
      this.sendTo(socket, { _tag: 'Replayed', seq })
    } else this.sendTo(socket, this.snapshot())
    const attachment = socket.deserializeAttachment() as Attachment
    socket.serializeAttachment({ ...attachment, ready: true })
    // A run cut off by a restart picks up from its checkpoint.
    const run = this.activeRun()
    if (run && !this.fiber) this.resume(run)
  }

  private snapshot(): ServerEvent {
    const source = this.source()
    const messages = [
      ...this.sql.exec<{ body: string }>(
        'SELECT body FROM messages ORDER BY position DESC LIMIT ?',
        SNAPSHOT_MESSAGES,
      ),
    ]
      .reverse()
      .map((row) => JSON.parse(row.body) as ChatMessage)
    return {
      _tag: 'Snapshot',
      seq: this.seq(),
      document: {
        id: this.meta('id') ?? '',
        title: scoreTitle(source),
        source,
        revision: this.revision(),
      },
      messages,
      run: this.activeRun() ?? null,
    }
  }

  private send(
    socket: WebSocket,
    text: string,
    selection: readonly SelectedNote[],
  ) {
    if (this.activeRun())
      return this.problem(
        socket,
        'The assistant is still working on the previous message.',
      )
    if (!text.trim()) return
    const earlier = this.messages()
    const user: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      text: text.trim(),
      ...(selection.length ? { selection } : {}),
    }
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: '',
      parts: [],
    }
    this.saveMessage(user)
    this.emit({ _tag: 'MessageAdded', message: user })
    this.saveMessage(assistant)
    this.emit({ _tag: 'MessageAdded', message: assistant })
    const prompt = Prompt.make([
      { role: 'system', content: systemPrompt(this.source()) },
      ...history([...earlier, user]),
    ])
    const run: Run = {
      id: crypto.randomUUID(),
      messageId: assistant.id,
      state: 'running',
      status: 'Connecting…',
    }
    const checkpoint: Checkpoint = {
      prompt: Schema.encodeSync(PromptJson)(prompt),
      text: '',
      parts: [],
      step: 1,
      spoke: false,
      resumes: 0,
    }
    this.saveRun(run, checkpoint)
    this.emit({ _tag: 'RunChanged', run })
    void this.ctx.storage.setAlarm(Date.now() + HEARTBEAT)
    this.start(run, checkpoint)
  }

  private stop() {
    if (this.fiber) {
      Effect.runFork(Fiber.interrupt(this.fiber))
      return
    }
    const run = this.activeRun()
    if (run) this.finishRun(run, 'stopped')
  }

  private edit(socket: WebSocket, source: string, baseRevision: number) {
    if (this.activeRun() || baseRevision !== this.revision()) {
      if (this.activeRun())
        this.problem(
          socket,
          'The assistant is editing the score; wait for it or stop it first.',
        )
      // The browser's copy is out of date: give it the current score.
      return this.sendTo(socket, {
        _tag: 'SourceChanged',
        seq: this.seq(),
        revision: this.revision(),
        source: this.source(),
        origin: 'user',
      })
    }
    if (source !== this.source()) this.setSource(source, 'user')
  }

  private clearChat(socket: WebSocket) {
    if (this.activeRun())
      return this.problem(
        socket,
        'Stop the assistant before clearing the chat.',
      )
    this.sql.exec('DELETE FROM messages')
    this.sql.exec('DELETE FROM runs')
    this.emit({ _tag: 'ChatCleared' })
  }

  // -------------------------------------------------------------------------
  // Runs

  private start(run: Run, checkpoint: Checkpoint) {
    const self = this
    this.streaming = this.message(run.messageId)
    const ownerId = this.meta('owner')!
    const documentId = this.meta('id')!
    const fetchAsset = assetFetcher(this.env.ASSETS)
    const program = Effect.gen(function* () {
      const credentials = yield* agentCredentials(
        ownerId,
        self.env.KEY_ENCRYPTION_SECRET,
      ).pipe(Effect.provide(D1Client.layer({ db: self.env.DB })))
      if (!credentials.apiKey) return yield* Effect.fail(new MissingKey())
      yield* runAgent({
        apiKey: credentials.apiKey,
        model: credentials.model,
        reasoning: credentials.reasoning,
        prompt: Schema.decodeSync(PromptJson)(checkpoint.prompt),
        spoke: checkpoint.spoke,
        step: checkpoint.step,
        apiUrl: self.env.OPENROUTER_URL || undefined,
        getSource: () => self.source(),
        applySource: (source, before) => self.applySource(source, before),
        check: (source) => check(fetchAsset, source),
        docs: () => loadDocs(fetchAsset),
        onStatus: (status) => self.setStatus(run.id, status),
        onText: (text) => self.queue('text', text),
        onThinking: (text) => self.queue('thinking', text),
        onCheckpoint: (prompt, step, spoke) =>
          Effect.sync(() => {
            self.flush()
            const current = self.run(run.id)
            if (!current) return
            self.saveRun(current.run, {
              prompt: Schema.encodeSync(PromptJson)(prompt),
              text: self.streaming?.text ?? '',
              parts: [...(self.streaming?.parts ?? [])],
              step,
              spoke,
              resumes: current.checkpoint.resumes,
            })
          }),
      })
    }).pipe(Effect.annotateLogs({ documentId, runId: run.id }))
    const fiber = Effect.runFork(program)
    this.fiber = fiber
    fiber.addObserver((exit) => {
      if (this.fiber !== fiber) return
      this.fiber = undefined
      this.flush()
      this.streaming = undefined
      this.renderWaiters.clear()
      const current = this.run(run.id)?.run
      if (!current || current.state !== 'running') return
      if (Exit.isSuccess(exit)) return this.finishRun(current, 'done')
      if (Cause.hasInterruptsOnly(exit.cause))
        return this.finishRun(current, 'stopped')
      const error = Cause.squash(exit.cause)
      if (error instanceof MissingKey)
        return this.finishRun(
          current,
          'failed',
          'Add your OpenRouter API key in Settings to use the assistant.',
        )
      // Provider errors can contain request details; log the kind, not the key.
      console.error('Agent run failed', documentId, String(error).slice(0, 500))
      this.finishRun(current, 'failed', describeFailure(error))
    })
  }

  /** Restarts a run that was cut off, from the checkpoint after its last finished step. */
  private resume(run: Run) {
    const stored = this.run(run.id)
    if (!stored) return
    const { checkpoint } = stored
    if (checkpoint.resumes >= MAX_RESUMES)
      return this.finishRun(
        run,
        'failed',
        'The assistant was interrupted too often. Try sending your message again.',
      )
    const resumed = { ...checkpoint, resumes: checkpoint.resumes + 1 }
    this.saveRun(run, resumed)
    // Output streamed after the checkpoint is produced again, so drop it.
    const message = this.message(run.messageId)
    if (message) {
      const restored = { ...message, text: resumed.text, parts: resumed.parts }
      this.saveMessage(restored)
      this.emit({ _tag: 'MessageReplaced', message: restored })
    }
    this.start(run, resumed)
  }

  private finishRun(run: Run, state: Run['state'], error?: string) {
    const finished: Run = {
      id: run.id,
      messageId: run.messageId,
      state,
      status: '',
      ...(error ? { error } : {}),
    }
    const stored = this.run(run.id)
    if (stored) this.saveRun(finished, stored.checkpoint)
    this.emit({ _tag: 'RunChanged', run: finished })
  }

  private setStatus(runId: string, status: string) {
    this.flush()
    const stored = this.run(runId)
    if (!stored || stored.run.status === status) return
    const run = { ...stored.run, status }
    this.saveRun(run, stored.checkpoint)
    this.emit({ _tag: 'RunChanged', run })
  }

  /** Streamed output waits a moment, so a slow connection gets fewer, larger frames. */
  private queue(kind: PartKind, text: string) {
    const last = this.pending.at(-1)
    if (last?.kind === kind) last.text += text
    else this.pending.push({ kind, text })
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_INTERVAL)
  }

  private flush() {
    clearTimeout(this.flushTimer)
    this.flushTimer = undefined
    const chunks = this.pending
    this.pending = []
    if (!this.streaming || !chunks.length) return
    for (const { kind, text } of chunks) {
      this.streaming = appendChunk(this.streaming, kind, text)
      this.emit({
        _tag: 'Delta',
        messageId: this.streaming.id,
        kind,
        text,
      })
    }
    this.saveMessage(this.streaming)
  }

  /**
   * Applies a checked score. With a browser connected, it waits for the
   * browser's engraving and takes the edit back if that fails, so only scores
   * that render stay applied.
   */
  private applySource(
    source: string,
    before: string,
  ): Effect.Effect<ApplyOutcome> {
    return Effect.suspend(() => {
      if (this.source() !== before)
        return Effect.succeed<ApplyOutcome>({ type: 'stale' })
      const revision = this.setSource(source, 'agent')
      if (!this.readySockets().length)
        return Effect.succeed<ApplyOutcome>({
          type: 'applied',
          engraved: false,
        })
      return Effect.callback<RenderReport | undefined>((resume) => {
        const timer = setTimeout(() => {
          this.renderWaiters.delete(revision)
          resume(Effect.succeed(undefined))
        }, RENDER_WAIT)
        this.renderWaiters.set(revision, (report) => {
          clearTimeout(timer)
          resume(Effect.succeed(report))
        })
        return Effect.sync(() => {
          clearTimeout(timer)
          this.renderWaiters.delete(revision)
        })
      }).pipe(
        Effect.map((report): ApplyOutcome => {
          if (report === undefined) return { type: 'applied', engraved: false }
          if (!report.errors.length) return { type: 'applied', engraved: true }
          if (this.revision() === revision) this.setSource(before, 'agent')
          // The same categories and hints as the server's own check.
          return {
            type: 'rejected',
            result: classifyErrors(source, report.errors, report.positions),
          }
        }),
      )
    })
  }

  // -------------------------------------------------------------------------
  // Storage

  private meta(key: string): string | undefined {
    return this.sql
      .exec<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)
      .toArray()[0]?.value
  }

  private setMeta(key: string, value: string) {
    this.sql.exec(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key,
      value,
    )
  }

  private source = () => this.meta('source') ?? ''
  private revision = () => Number(this.meta('revision') ?? 0)
  private seq = () => Number(this.meta('seq') ?? 0)

  private setSource(source: string, origin: 'agent' | 'user'): number {
    const revision = this.revision() + 1
    this.setMeta('source', source)
    this.setMeta('revision', String(revision))
    this.emit({ _tag: 'SourceChanged', revision, source, origin })
    this.scheduleTouch()
    return revision
  }

  private scheduleTouch() {
    clearTimeout(this.touchTimer)
    this.touchTimer = setTimeout(() => {
      const id = this.meta('id')
      if (!id) return
      Effect.runPromise(
        touchDocument(id, scoreTitle(this.source())).pipe(
          Effect.provide(D1Client.layer({ db: this.env.DB })),
        ),
      ).catch((error) =>
        console.error('Could not update the document index', String(error)),
      )
    }, TOUCH_DELAY)
  }

  private messages(): ChatMessage[] {
    return [
      ...this.sql.exec<{ body: string }>(
        'SELECT body FROM messages ORDER BY position',
      ),
    ].map((row) => JSON.parse(row.body) as ChatMessage)
  }

  private message(id: string): ChatMessage | undefined {
    const row = this.sql
      .exec<{ body: string }>('SELECT body FROM messages WHERE id = ?', id)
      .toArray()[0]
    return row && (JSON.parse(row.body) as ChatMessage)
  }

  private saveMessage(message: ChatMessage) {
    this.sql.exec(
      'INSERT INTO messages (id, body) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET body = excluded.body',
      message.id,
      JSON.stringify(message),
    )
  }

  private run(id: string): { run: Run; checkpoint: Checkpoint } | undefined {
    const row = this.sql
      .exec<{ body: string; checkpoint: string }>(
        'SELECT body, checkpoint FROM runs WHERE id = ?',
        id,
      )
      .toArray()[0]
    return (
      row && {
        run: JSON.parse(row.body) as Run,
        checkpoint: JSON.parse(row.checkpoint) as Checkpoint,
      }
    )
  }

  private activeRun(): Run | undefined {
    for (const row of this.sql.exec<{ body: string }>(
      'SELECT body FROM runs ORDER BY updated_at DESC',
    )) {
      const run = JSON.parse(row.body) as Run
      if (run.state === 'running') return run
    }
    return undefined
  }

  private saveRun(run: Run, checkpoint: Checkpoint) {
    this.sql.exec(
      `INSERT INTO runs (id, body, checkpoint, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET body = excluded.body,
         checkpoint = excluded.checkpoint, updated_at = excluded.updated_at`,
      run.id,
      JSON.stringify(run),
      JSON.stringify(checkpoint),
      Date.now(),
    )
  }

  /** Stores an event under the next sequence number and sends it to every caught-up browser. */
  private emit(event: DistributiveOmit<Stored, 'seq'>) {
    const seq = this.seq() + 1
    const body = JSON.stringify({ ...event, seq })
    this.sql.exec('INSERT INTO events (seq, body) VALUES (?, ?)', seq, body)
    this.setMeta('seq', String(seq))
    if (seq % 500 === 0)
      this.sql.exec('DELETE FROM events WHERE seq <= ?', seq - KEEP_EVENTS)
    for (const socket of this.readySockets()) {
      try {
        socket.send(body)
      } catch {
        // A closing socket catches up when it reconnects.
      }
    }
  }

  private readySockets(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter(
        (socket) =>
          (socket.deserializeAttachment() as Attachment | null)?.ready,
      )
  }

  private sendTo(socket: WebSocket, event: ServerEvent) {
    try {
      socket.send(JSON.stringify(event))
    } catch {
      // Closed meanwhile.
    }
  }

  private problem(socket: WebSocket, message: string) {
    this.sendTo(socket, { _tag: 'Problem', message })
  }
}
