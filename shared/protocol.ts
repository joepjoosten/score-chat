/**
 * What the browser and the Worker exchange: the HTTP API's payloads and the
 * document WebSocket's commands and events. Both sides decode with these
 * schemas, so a change here is a protocol change.
 */
import { Schema } from 'effect'

export const MAX_SOURCE_LENGTH = 150_000
export const MAX_MESSAGE_LENGTH = 20_000

export const reasoningEfforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export const ReasoningEffort = Schema.Literals(reasoningEfforts)
export type ReasoningEffort = typeof ReasoningEffort.Type

export const DEFAULT_MODEL = 'openrouter/auto'

// ---------------------------------------------------------------------------
// Chat

/** A highlighted source event as attached to a chat message. */
export const SelectedNote = Schema.Struct({
  text: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  endLine: Schema.Number,
  endColumn: Schema.Number,
  /** Readable kinds of the highlighted elements, e.g. `note` or `slur`. */
  kinds: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The full source line the event starts on. */
  context: Schema.optionalKey(Schema.String),
})
export type SelectedNote = typeof SelectedNote.Type

export const PartKind = Schema.Literals(['text', 'thinking'])
export type PartKind = typeof PartKind.Type

export const MessagePart = Schema.Struct({
  type: PartKind,
  text: Schema.String,
})
export type MessagePart = typeof MessagePart.Type

export const ChatMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(['user', 'assistant']),
  /** The reply text sent back to the model as history. */
  text: Schema.String,
  /** Score elements highlighted when a user message was sent. */
  selection: Schema.optionalKey(Schema.Array(SelectedNote)),
  /** Assistant output in arrival order: text and thinking. */
  parts: Schema.optionalKey(Schema.Array(MessagePart)),
})
export type ChatMessage = typeof ChatMessage.Type

export const RunState = Schema.Literals([
  'running',
  'done',
  'stopped',
  'failed',
])
export type RunState = typeof RunState.Type

/** One assistant turn, which keeps going on the server while browsers come and go. */
export const Run = Schema.Struct({
  id: Schema.String,
  /** The assistant message the run streams into. */
  messageId: Schema.String,
  state: RunState,
  /** What the agent is doing right now, e.g. "Reading your score…". */
  status: Schema.String,
  error: Schema.optionalKey(Schema.String),
})
export type Run = typeof Run.Type

// ---------------------------------------------------------------------------
// Documents

export const DocumentSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  updatedAt: Schema.Number,
})
export type DocumentSummary = typeof DocumentSummary.Type

export const DocumentList = Schema.Struct({
  documents: Schema.Array(DocumentSummary),
})

export const CreateDocument = Schema.Struct({
  source: Schema.String.check(Schema.isMaxLength(MAX_SOURCE_LENGTH)),
})

export const CreatedDocument = Schema.Struct({ id: Schema.String })

// ---------------------------------------------------------------------------
// Accounts

export const User = Schema.Struct({ id: Schema.String, email: Schema.String })
export type User = typeof User.Type

export const AgentSettings = Schema.Struct({
  model: Schema.String,
  /** Absent leaves the choice to the model; `none` turns thinking off. */
  reasoning: Schema.NullOr(ReasoningEffort),
  /** Whether an OpenRouter key is stored. The key itself never leaves the server. */
  hasApiKey: Schema.Boolean,
})
export type AgentSettings = typeof AgentSettings.Type

export const Me = Schema.Struct({ user: User, settings: AgentSettings })
export type Me = typeof Me.Type

export const RequestLogin = Schema.Struct({
  email: Schema.String.check(Schema.isMaxLength(320)),
})
export const VerifyLogin = Schema.Struct({ token: Schema.String })

export const UpdateSettings = Schema.Struct({
  model: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  reasoning: Schema.optionalKey(Schema.NullOr(ReasoningEffort)),
  /** A new key, or null to remove the stored one. Absent keeps it. */
  apiKey: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
  ),
})
export type UpdateSettings = typeof UpdateSettings.Type

export const ApiError = Schema.Struct({ error: Schema.String })

// ---------------------------------------------------------------------------
// Document WebSocket

/** A range in the score: 1-based lines, UTF-16 columns. */
export const SourceSpan = Schema.Struct({
  line: Schema.Number,
  column: Schema.Number,
  endLine: Schema.Number,
  endColumn: Schema.Number,
})

/**
 * Browser → Durable Object. `Hello` opens (and reopens) a session: with the
 * sequence number of the last event the browser has, the server replays only
 * what it missed, so a reconnect on a slow connection resends little.
 */
export const ClientCommand = Schema.TaggedUnion({
  Hello: { since: Schema.NullOr(Schema.Number) },
  Send: {
    text: Schema.String.check(Schema.isMaxLength(MAX_MESSAGE_LENGTH)),
    selection: Schema.Array(SelectedNote),
  },
  Stop: {},
  /** A hand edit, based on the revision the browser last saw. */
  SetSource: {
    source: Schema.String.check(Schema.isMaxLength(MAX_SOURCE_LENGTH)),
    baseRevision: Schema.Number,
  },
  /** The browser's full render of a revision, which also engraves it. */
  Rendered: {
    revision: Schema.Number,
    errors: Schema.Array(Schema.String),
    /** Where each error is in the score, or null; absent from older clients. */
    positions: Schema.optionalKey(Schema.Array(Schema.NullOr(SourceSpan))),
  },
  ClearChat: {},
  Ping: {},
})
export type ClientCommand = typeof ClientCommand.Type

export const DocumentState = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  source: Schema.String,
  revision: Schema.Number,
})
export type DocumentState = typeof DocumentState.Type

export const SourceOrigin = Schema.Literals(['agent', 'user'])

/**
 * Durable Object → browser. Every event but `Pong` and `Problem` carries the
 * sequence number it was stored under.
 */
export const ServerEvent = Schema.TaggedUnion({
  /** Everything, sent when the browser has nothing or missed too much. */
  Snapshot: {
    seq: Schema.Number,
    document: DocumentState,
    messages: Schema.Array(ChatMessage),
    run: Schema.NullOr(Run),
  },
  /** Sent after a replay, so the browser knows it is up to date. */
  Replayed: { seq: Schema.Number },
  SourceChanged: {
    seq: Schema.Number,
    revision: Schema.Number,
    source: Schema.String,
    origin: SourceOrigin,
  },
  MessageAdded: { seq: Schema.Number, message: ChatMessage },
  /** Streamed output, coalesced into chunks. */
  Delta: {
    seq: Schema.Number,
    messageId: Schema.String,
    kind: PartKind,
    text: Schema.String,
  },
  /** A message replaced wholesale, e.g. when a run resumes from a checkpoint. */
  MessageReplaced: { seq: Schema.Number, message: ChatMessage },
  RunChanged: { seq: Schema.Number, run: Run },
  ChatCleared: { seq: Schema.Number },
  /** A command that could not be carried out; not stored. */
  Problem: { message: Schema.String },
  Pong: {},
})
export type ServerEvent = typeof ServerEvent.Type

export const ClientCommandJson = Schema.fromJsonString(ClientCommand)
export const ServerEventJson = Schema.fromJsonString(ServerEvent)

/** The score's title from its `\header`, as shown in the document list. */
export const scoreTitle = (source: string) =>
  source.match(/\btitle\s*=\s*"([^"\n]*)"/)?.[1] || 'Untitled score'

/** Appends a streamed chunk to an assistant message, starting a new part when the kind changes. */
export function appendChunk(
  message: ChatMessage,
  type: PartKind,
  chunk: string,
): ChatMessage {
  const parts = message.parts ?? []
  const last = parts.at(-1)
  return {
    ...message,
    text: type === 'text' ? message.text + chunk : message.text,
    parts:
      last?.type === type
        ? [...parts.slice(0, -1), { type, text: last.text + chunk }]
        : [...parts, { type, text: chunk }],
  }
}
