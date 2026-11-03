/** The client's state: one Schema-defined Model, as Foldkit requires. */
import { Schema } from 'effect'
import { defineRouteUnion } from 'foldkit/route'
import { defineTaggedUnion } from 'foldkit/schema'
import {
  ChatMessage,
  DocumentSummary,
  Me,
  Run,
  SelectedNote,
} from '../shared/protocol.ts'

export const AppRoute = defineRouteUnion({
  Home: {},
  Document: { documentId: Schema.String },
  /** `token` from an emailed link; `via=access` back from Cloudflare Access. */
  Login: {
    token: Schema.Option(Schema.String),
    via: Schema.Option(Schema.String),
  },
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type

export const Session = defineTaggedUnion({
  Checking: {},
  SignedOut: {},
  SignedIn: { me: Me },
})
export type Session = typeof Session.Type

export const SocketState = defineTaggedUnion({
  Disconnected: {},
  Connecting: { attempt: Schema.Number },
  Connected: { attempt: Schema.Number },
  WaitingToReconnect: { attempt: Schema.Number },
})
export type SocketState = typeof SocketState.Type

export const dockCorners = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const
export const DockCorner = Schema.Literals(dockCorners)
export type DockCorner = typeof DockCorner.Type

export const Size = Schema.Struct({
  width: Schema.Number,
  height: Schema.Number,
})
export type Size = typeof Size.Type

/** Preferences kept in this browser's local storage. */
export const Prefs = Schema.Struct({
  view: Schema.Literals(['score', 'source']),
  /** How rendered pages are shown: as images, or inline SVG for inspection. */
  pages: Schema.Literals(['image', 'inline']),
  /** Size of the assistant dock after the user resizes it, in pixels. */
  dock: Schema.NullOr(Size),
  /** Corner of the stage the assistant dock is pinned to. */
  corner: DockCorner,
})
export type Prefs = typeof Prefs.Type
export const defaultPrefs: Prefs = {
  view: 'score',
  pages: 'image',
  dock: null,
  corner: 'bottom-right',
}

/** Where an error is in the score: 1-based lines, UTF-16 columns. */
export const SourcePosition = Schema.Struct({
  line: Schema.Number,
  column: Schema.Number,
  endLine: Schema.Number,
  endColumn: Schema.Number,
})
export type SourcePosition = typeof SourcePosition.Type

export const Anchor = Schema.Struct({
  kind: Schema.String,
  page: Schema.Number,
  system: Schema.Number,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
  line: Schema.Number,
  column: Schema.Number,
  endLine: Schema.Number,
  endColumn: Schema.Number,
})

export const RenderResult = Schema.Struct({
  pages: Schema.Array(Schema.String),
  errors: Schema.Array(Schema.String),
  /** The position of each error, or null when it has none in the score. */
  positions: Schema.Array(Schema.NullOr(SourcePosition)),
  anchors: Schema.Array(Anchor),
})
export type RenderResult = typeof RenderResult.Type

export const Box = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
})

/** A locally stored document, for people who are not signed in. */
export const LocalDocument = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  source: Schema.String,
  updatedAt: Schema.Number,
})
export type LocalDocument = typeof LocalDocument.Type

export const Playback = Schema.Literals([
  'stopped',
  'loading',
  'playing',
  'paused',
])

export const SettingsDraft = Schema.Struct({
  model: Schema.String,
  /** `default` or a reasoning effort. */
  reasoning: Schema.String,
  pages: Schema.Literals(['image', 'inline']),
  /** A new key to store; empty keeps the stored one unless `clearKey`. */
  apiKey: Schema.String,
  clearKey: Schema.Boolean,
})
export type SettingsDraft = typeof SettingsDraft.Type

export const LoginState = Schema.Literals([
  'idle',
  'sending',
  'sent',
  'verifying',
])

export const Model = Schema.Struct({
  route: AppRoute,
  session: Session,
  prefs: Prefs,
  storageError: Schema.String,

  // The open document. Local documents live in this browser; remote ones in
  // their Durable Object, reached over the socket.
  documents: Schema.Array(DocumentSummary),
  documentsOpen: Schema.Boolean,
  documentId: Schema.NullOr(Schema.String),
  documentKind: Schema.Literals(['local', 'remote']),
  /** No score to show yet: the document is still loading. */
  loading: Schema.Boolean,
  notice: Schema.String,
  source: Schema.String,
  /** The server revision `source` is based on. */
  revision: Schema.Number,
  saveGeneration: Schema.Number,
  /** A hand edit sent to the server and not yet acknowledged. */
  saving: Schema.Boolean,
  /** Hand edits the server has not acknowledged yet. */
  dirty: Schema.Boolean,
  /** Sources sent with SetSource, to recognize their echoes. */
  sent: Schema.Array(Schema.String),
  undo: Schema.Array(Schema.String),
  redo: Schema.Array(Schema.String),

  socket: SocketState,
  /** Sequence number of the last event received, to resume from. */
  lastSeq: Schema.NullOr(Schema.Number),
  /** Failed connections since the last good one, for the reconnect delay. */
  retries: Schema.Number,

  messages: Schema.Array(ChatMessage),
  run: Schema.NullOr(Run),
  input: Schema.String,
  /** A message sent before the document's socket opened, sent once it has caught up. */
  queued: Schema.NullOr(
    Schema.Struct({
      text: Schema.String,
      selection: Schema.Array(SelectedNote),
    }),
  ),
  chatError: Schema.String,
  chatOpen: Schema.Boolean,
  chatHidden: Schema.Boolean,
  unread: Schema.Boolean,
  /** Thought processes the reader expanded, by message ID and part index. */
  expandedThinking: Schema.Array(Schema.String),

  renderGeneration: Schema.Number,
  rendering: Schema.Boolean,
  rendered: RenderResult,
  renderedSource: Schema.String,
  /** The server revision of the score being rendered. */
  renderRevision: Schema.Number,
  /** The render in progress, which a newer one cancels. */
  renderStarted: Schema.NullOr(Schema.Number),

  playback: Playback,
  playbackError: Schema.String,
  playbackErrorPosition: Schema.NullOr(SourcePosition),
  /** Anchor keys of the notes sounding right now. */
  sounding: Schema.Array(Schema.String),

  zoom: Schema.Number,
  page: Schema.Number,
  canvasWidth: Schema.Number,
  highlighting: Schema.Boolean,
  selected: Schema.Array(Schema.String),
  marquee: Schema.NullOr(Schema.Struct({ page: Schema.Number, box: Box })),
  /** A source position the editor should select, numbered so a repeat is a new request. */
  reveal: Schema.NullOr(
    Schema.Struct({ position: SourcePosition, request: Schema.Number }),
  ),
  sourceOpened: Schema.Boolean,
  fileDrag: Schema.Boolean,

  /** The stage's box in the window, which a dragged dock settles in a corner of. */
  stage: Box,
  /** The dock's measured width and conversation height. */
  dockMeasure: Size,
  dockSize: Schema.NullOr(Size),
  dockDrag: Schema.NullOr(
    Schema.Struct({
      startX: Schema.Number,
      startY: Schema.Number,
      x: Schema.Number,
      y: Schema.Number,
      moved: Schema.Boolean,
    }),
  ),
  dockResize: Schema.NullOr(
    Schema.Struct({
      startX: Schema.Number,
      startY: Schema.Number,
      width: Schema.Number,
      height: Schema.Number,
    }),
  ),
  /** The click that ends a dock drag is not a toggle. */
  ignoreToggle: Schema.Boolean,

  settingsOpen: Schema.Boolean,
  settingsDraft: SettingsDraft,
  settingsSaving: Schema.Boolean,
  settingsError: Schema.String,

  /** How this deployment signs people in, as the server says. */
  signInMethod: Schema.Literals(['access', 'email']),
  loginOpen: Schema.Boolean,
  loginEmail: Schema.String,
  loginState: LoginState,
  loginError: Schema.String,
  /** Why the sign-in dialog opened, e.g. to use the assistant. */
  loginReason: Schema.String,
})
export type Model = typeof Model.Type

export const emptyRender: RenderResult = {
  pages: [],
  errors: [],
  positions: [],
  anchors: [],
}

export const isBusy = (model: Model) => model.run?.state === 'running'
