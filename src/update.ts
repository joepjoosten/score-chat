/** How each Message changes the Model, and which Commands follow. */
import { Option } from 'effect'
import { Navigation, Url, type Command, type Update } from 'foldkit'
import {
  appendChunk,
  reasoningEfforts,
  scoreTitle,
  type ChatMessage,
  type ClientCommand,
  type ServerEvent,
  type UpdateSettings,
} from '../shared/protocol.ts'
import { anchorKey, anchorsInBox, selectedNotes } from '../shared/selection.ts'
import * as Commands from './commands.ts'
import {
  RevealInEditor,
  SetEditorErrors,
  SetEditorReadOnly,
  SyncEditor,
} from './editor.ts'
import { initialScore } from './initialScore.ts'
import { Message } from './message.ts'
import {
  emptyRender,
  isBusy,
  type DockCorner,
  type Model,
  type Size,
} from './model.ts'
import { documentUrl, urlToAppRoute } from './routes.ts'
import {
  SendToDocument,
  WaitToReconnect,
  type DocumentSocketService,
} from './socket.ts'
import { isLocalId, newLocalDocument } from './storage.ts'

type Return = Update.Return<Model, Message, DocumentSocketService>
type Cmd = Command.Command<Message, never, DocumentSocketService>

const UNDO_LIMIT = 20
const STOPPED =
  'Stopped. Any completed score edits are still available to undo.'
/** Gap between pages shown side by side, in pixels; matches `.page-spread`. */
export const SPREAD_GAP = 24

// ---------------------------------------------------------------------------
// Derived state

export const pageWidth = (model: Model) => model.zoom * 8.6
export const spread = (model: Model) =>
  model.canvasWidth >= pageWidth(model) * 2 + SPREAD_GAP ? 2 : 1
export const firstPage = (model: Model) => {
  const count = model.rendered.pages.length
  const pages = spread(model)
  return (
    Math.floor(Math.min(model.page, Math.max(0, count - 1)) / pages) * pages
  )
}
/** The rendered pages show the current source, without errors. */
export const isFresh = (model: Model) =>
  model.source === model.renderedSource &&
  !model.rendering &&
  !model.rendered.errors.length
export const highlightedNotes = (model: Model) =>
  model.selected.length
    ? selectedNotes(
        model.rendered.anchors,
        new Set(model.selected),
        model.source,
      )
    : []

/** Screen directions in which dragging the resize grip grows the dock. */
export function growth(corner: DockCorner) {
  return {
    x: corner.endsWith('right') ? -1 : 1,
    y: corner.startsWith('bottom') ? -1 : 1,
  }
}

/** Keeps the dock within the stage, leaving room for its heading and composer. */
export function clampDock(size: Size, stage: Size): Size {
  return {
    width: Math.round(Math.max(300, Math.min(size.width, stage.width - 16))),
    height: Math.round(
      Math.max(120, Math.min(size.height, stage.height - 190)),
    ),
  }
}

/** The stage corner nearest to a point, which is where a dragged dock settles. */
export function nearestCorner(
  x: number,
  y: number,
  stage: { x: number; y: number; width: number; height: number },
): DockCorner {
  const vertical = y < stage.y + stage.height / 2 ? 'top' : 'bottom'
  const horizontal = x < stage.x + stage.width / 2 ? 'left' : 'right'
  return `${vertical}-${horizontal}`
}

// ---------------------------------------------------------------------------
// Helpers

const send = (model: Model, command: ClientCommand): Cmd[] =>
  model.socket._tag === 'Connected' ? [SendToDocument({ command })] : []

/** Errors to mark in the editor: the finished render's, and a playback error. */
const editorErrors = (model: Model): Cmd => {
  const errors = model.rendering ? [] : [...model.rendered.errors]
  const positions = model.rendering ? [] : [...model.rendered.positions]
  if (model.playbackError) {
    errors.push(model.playbackError)
    positions.push(model.playbackErrorPosition)
  }
  return SetEditorErrors({ source: model.source, errors, positions })
}

/** A new score in the workspace: render it again and forget what belonged to the old one. */
function withSource(
  model: Model,
  source: string,
  options: { syncEditor: boolean },
): Return {
  const generation = model.renderGeneration + 1
  const title = scoreTitle(source)
  const next: Model = {
    ...model,
    source,
    renderGeneration: generation,
    rendering: true,
    // Highlights are keyed by source position, so any change invalidates them.
    selected: [],
    marquee: null,
    playback: 'stopped',
    sounding: [],
    playbackError: '',
    playbackErrorPosition: null,
    documents: model.documents.map((document) =>
      document.id === model.documentId ? { ...document, title } : document,
    ),
  }
  return {
    model: next,
    commands: [
      Commands.DebounceRender({ generation }),
      Commands.DiscardPerformance(),
      SetEditorErrors({ source, errors: [], positions: [] }),
      ...(options.syncEditor ? [SyncEditor({ doc: source })] : []),
    ],
  }
}

const andThen = (result: Return, more: (model: Model) => Return): Return => {
  const next = more(result.model)
  return {
    model: next.model,
    commands: [...(result.commands ?? []), ...(next.commands ?? [])],
  }
}

/** Saves the score: to this browser, or to the server unless a save is in flight. */
function saveNow(model: Model): Return {
  if (!model.documentId) return { model }
  if (model.documentKind === 'local')
    return {
      model: { ...model, dirty: false },
      commands: [
        Commands.SaveLocalDocument({
          id: model.documentId,
          source: model.source,
        }),
      ],
    }
  if (model.saving || model.socket._tag !== 'Connected') return { model }
  return {
    model: {
      ...model,
      saving: true,
      sent: [...model.sent.slice(-19), model.source],
    },
    commands: send(model, {
      _tag: 'SetSource',
      source: model.source,
      baseRevision: model.revision,
    }),
  }
}

/** Replaces the score as one undoable step (a file, undo and redo). */
function replaceScore(model: Model, next: string): Return {
  if (next === model.source) return { model }
  return andThen(
    withSource(
      {
        ...model,
        undo: [...model.undo.slice(-(UNDO_LIMIT - 1)), model.source],
        redo: [],
        dirty: true,
      },
      next,
      { syncEditor: true },
    ),
    saveNow,
  )
}

/** Moves the top of one history stack into the score and the current score onto the other. */
function travel(model: Model, direction: 'undo' | 'redo'): Return {
  const from = direction === 'undo' ? model.undo : model.redo
  const target = from.at(-1)
  if (target === undefined) return { model }
  const rest = from.slice(0, -1)
  const to = [
    ...(direction === 'undo' ? model.redo : model.undo).slice(
      -(UNDO_LIMIT - 1),
    ),
    model.source,
  ]
  const stacks =
    direction === 'undo' ? { undo: rest, redo: to } : { undo: to, redo: rest }
  return andThen(
    withSource({ ...model, ...stacks, dirty: true }, target, {
      syncEditor: true,
    }),
    saveNow,
  )
}

/** Clears everything that belongs to the open document. */
function closeDocument(model: Model): Model {
  return {
    ...model,
    queued: null,
    documentId: null,
    loading: true,
    revision: 0,
    saving: false,
    dirty: false,
    sent: [],
    undo: [],
    redo: [],
    socket: { _tag: 'Disconnected' },
    lastSeq: null,
    retries: 0,
    messages: [],
    run: null,
    chatError: '',
    expandedThinking: [],
    selected: [],
    marquee: null,
    page: 0,
    playback: 'stopped',
    sounding: [],
  }
}

function openLocal(model: Model, id: string, source: string): Return {
  return withSource(
    {
      ...closeDocument(model),
      documentId: id,
      documentKind: 'local',
      loading: false,
      notice: '',
    },
    source,
    { syncEditor: true },
  )
}

/** What a route asks for, once the session is known. */
function followRoute(model: Model): Return {
  if (model.session._tag === 'Checking') return { model }
  const signedIn = model.session._tag === 'SignedIn'
  const route = model.route
  switch (route._tag) {
    case 'Home':
      return {
        model: { ...model, loading: true },
        commands: [
          signedIn ? Commands.FetchDocuments() : Commands.LoadLocalDocuments(),
        ],
      }
    case 'Document': {
      const id = route.documentId
      if (id === model.documentId) return { model }
      if (isLocalId(id))
        return {
          model: { ...model, loading: true },
          commands: [Commands.LoadLocalDocuments()],
        }
      if (!signedIn)
        return {
          model: {
            ...closeDocument(model),
            loading: false,
            notice: 'Sign in to open this document.',
            loginOpen: true,
            loginReason: 'This document is saved in a Score Chat account.',
          },
        }
      return {
        model: {
          ...closeDocument(model),
          // A message sent while the page was still starting belongs to this document.
          queued: model.documentId === null ? model.queued : null,
          documentId: id,
          documentKind: 'remote',
          notice: '',
          socket: { _tag: 'Connecting', attempt: 0 },
        },
        commands: [Commands.FetchDocuments(), Commands.DiscardPerformance()],
      }
    }
    case 'Login':
      return Option.match(route.token, {
        onSome: (token) => ({
          model: {
            ...model,
            loginState: 'verifying' as const,
            loginOpen: false,
          },
          commands: [Commands.VerifyLogin({ token })],
        }),
        onNone: () => ({
          model: { ...model, loginOpen: !signedIn },
          commands: [Commands.ReplaceUrl({ url: '/' })],
        }),
      })
    case 'NotFound':
      return { model, commands: [Commands.ReplaceUrl({ url: '/' })] }
  }
}

// ---------------------------------------------------------------------------
// Server events

function receive(model: Model, event: ServerEvent): Return {
  if (
    'seq' in event &&
    event._tag !== 'SourceChanged' &&
    model.lastSeq !== null &&
    event.seq <= model.lastSeq
  )
    return { model }
  const seen: Model =
    'seq' in event
      ? { ...model, lastSeq: Math.max(model.lastSeq ?? 0, event.seq) }
      : model
  const replace = (message: ChatMessage) =>
    seen.messages.map((existing) =>
      existing.id === message.id ? message : existing,
    )
  switch (event._tag) {
    case 'Snapshot': {
      const running = event.run?.state === 'running'
      // Edits typed while disconnected win over the stored score, unless the assistant is at work.
      if (model.dirty && !running && model.renderGeneration > 0)
        return saveNow({
          ...seen,
          lastSeq: event.seq,
          retries: 0,
          loading: false,
          revision: event.document.revision,
          saving: false,
          sent: [],
          messages: event.messages,
          run: event.run,
        })
      const base: Model = {
        ...seen,
        dirty: false,
        lastSeq: event.seq,
        retries: 0,
        loading: false,
        revision: event.document.revision,
        saving: false,
        sent: [],
        messages: event.messages,
        run: event.run,
      }
      const readOnly = SetEditorReadOnly({
        readOnly: event.run?.state === 'running',
      })
      if (event.document.source === model.source && model.renderGeneration > 0)
        return { model: base, commands: [readOnly] }
      return andThen(
        withSource(base, event.document.source, { syncEditor: true }),
        (next) => ({
          model: next,
          commands: [readOnly],
        }),
      )
    }
    case 'Replayed': {
      const caughtUp = {
        ...seen,
        lastSeq: event.seq,
        retries: 0,
        loading: false,
      }
      return caughtUp.dirty && !caughtUp.saving
        ? saveNow(caughtUp)
        : { model: caughtUp }
    }
    case 'SourceChanged': {
      const next: Model = { ...seen, revision: event.revision }
      const echo =
        event.origin === 'user' ? model.sent.indexOf(event.source) : -1
      if (echo >= 0) {
        // Our own edit, acknowledged; send what was typed since, if anything.
        const acknowledged = {
          ...next,
          saving: false,
          sent: model.sent.slice(echo + 1),
        }
        return acknowledged.source === event.source
          ? { model: { ...acknowledged, dirty: false } }
          : saveNow(acknowledged)
      }
      if (event.source === model.source)
        return { model: { ...next, saving: false, dirty: false } }
      const history =
        event.origin === 'agent'
          ? {
              undo: [...model.undo.slice(-(UNDO_LIMIT - 1)), model.source],
              redo: [],
            }
          : {}
      return withSource(
        { ...next, ...history, saving: false, sent: [], dirty: false },
        event.source,
        {
          syncEditor: true,
        },
      )
    }
    case 'MessageAdded':
      return {
        model: {
          ...seen,
          messages: seen.messages.some(
            (message) => message.id === event.message.id,
          )
            ? replace(event.message)
            : [...seen.messages, event.message],
          unread: seen.unread || seen.chatHidden,
        },
      }
    case 'Delta':
      return {
        model: {
          ...seen,
          messages: seen.messages.map((message) =>
            message.id === event.messageId
              ? appendChunk(message, event.kind, event.text)
              : message,
          ),
          unread: seen.unread || seen.chatHidden,
        },
      }
    case 'MessageReplaced':
      return { model: { ...seen, messages: replace(event.message) } }
    case 'RunChanged': {
      const running = event.run.state === 'running'
      const wasRunning = model.run?.state === 'running'
      const chatError = running
        ? ''
        : event.run.state === 'failed'
          ? (event.run.error ?? 'The assistant could not complete the request.')
          : event.run.state === 'stopped'
            ? STOPPED
            : seen.chatError
      return {
        model: {
          ...seen,
          run: event.run,
          chatError,
          unread: seen.unread || (seen.chatHidden && !running),
        },
        commands: [
          SetEditorReadOnly({ readOnly: running }),
          ...(wasRunning && !running ? [Commands.FocusComposer()] : []),
        ],
      }
    }
    case 'ChatCleared':
      return {
        model: { ...seen, messages: [], chatError: '', expandedThinking: [] },
      }
    case 'Problem':
      return { model: { ...seen, chatError: event.message, chatOpen: true } }
    case 'Pong':
      return { model: seen }
  }
}

// ---------------------------------------------------------------------------
// Update

const settingsDraft = (model: Model) => {
  const settings =
    model.session._tag === 'SignedIn' ? model.session.me.settings : null
  return {
    model: settings?.model ?? 'openrouter/auto',
    reasoning: settings?.reasoning ?? 'default',
    pages: model.prefs.pages,
    apiKey: '',
    clearKey: false,
  }
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ClickedLink: ({ request }) =>
      Navigation.UrlRequest.match<Return>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [Commands.PushUrl({ url: Url.toString(url) })],
        }),
        External: ({ href }) => ({
          model,
          commands: [Commands.LoadUrl({ href })],
        }),
      }),
    ChangedUrl: ({ url }) =>
      followRoute({ ...model, route: urlToAppRoute(url) }),
    Completed: () => ({ model }),
    StorageFailed: () => ({
      model: {
        ...model,
        storageError:
          'Browser storage is unavailable or full. Changes will only last for this session.',
      },
    }),

    // Accounts ---------------------------------------------------------------
    GotSession: ({ me }) =>
      followRoute({ ...model, session: { _tag: 'SignedIn', me } }),
    GotNoSession: () =>
      followRoute({
        ...model,
        session: { _tag: 'SignedOut' },
        // A message typed meanwhile needs an account: give it back and ask to sign in.
        ...(model.queued
          ? {
              input: model.queued.text,
              queued: null,
              loginOpen: true,
              loginState: 'idle' as const,
              loginReason:
                'Sign in to use the assistant. Your documents in this browser move to your account.',
            }
          : {}),
      }),
    ClickedSignIn: () => ({
      model: {
        ...model,
        loginOpen: true,
        loginState: 'idle',
        loginError: '',
        loginReason: '',
      },
    }),
    ClosedLogin: () => ({ model: { ...model, loginOpen: false } }),
    ChangedLoginEmail: ({ email }) => ({
      model: { ...model, loginEmail: email },
    }),
    SubmittedLogin: () =>
      model.loginState === 'sending' || !model.loginEmail.trim()
        ? { model }
        : {
            model: { ...model, loginState: 'sending', loginError: '' },
            commands: [
              Commands.RequestLoginLink({ email: model.loginEmail.trim() }),
            ],
          },
    SentLoginLink: () => ({ model: { ...model, loginState: 'sent' } }),
    FailedLogin: ({ error }) => {
      const verifying = model.loginState === 'verifying'
      return {
        model: {
          ...model,
          loginState: 'idle',
          loginError: error,
          loginOpen: true,
        },
        commands: verifying ? [Commands.ReplaceUrl({ url: '/' })] : [],
      }
    },
    VerifiedLogin: ({ me }) => ({
      model: {
        ...model,
        session: { _tag: 'SignedIn', me },
        loginState: 'idle',
        loginOpen: false,
        loading: true,
      },
      commands: [Commands.ImportLocalDocuments()],
    }),
    ImportedLocalDocuments: ({ documentId }) => ({
      model: { ...closeDocument(model) },
      commands: [
        Commands.ReplaceUrl({
          url: documentId ? documentUrl(documentId) : '/',
        }),
      ],
    }),
    ClickedSignOut: () => ({
      model: { ...model, settingsOpen: false },
      commands: [Commands.SignOut()],
    }),
    SignedOut: () =>
      andThen(
        followRoute({
          ...closeDocument(model),
          session: { _tag: 'SignedOut' },
          route: { _tag: 'Home' },
          documents: [],
        }),
        (next) => ({
          model: next,
          commands: [Commands.ReplaceUrl({ url: '/' })],
        }),
      ),

    // Documents --------------------------------------------------------------
    GotDocuments: ({ documents }) => {
      const next = { ...model, documents }
      // A deleted score, or one from another account: its socket would never open.
      const id = model.documentId
      if (
        model.route._tag === 'Document' &&
        model.documentKind === 'remote' &&
        id === model.route.documentId &&
        !documents.some((document) => document.id === id)
      )
        return {
          model: {
            ...closeDocument(next),
            notice: 'That score is not in your account.',
          },
          commands: [Commands.ReplaceUrl({ url: '/' })],
        }
      if (model.route._tag !== 'Home' || model.session._tag !== 'SignedIn')
        return { model: next }
      const newest = documents[0]
      return newest
        ? {
            model: next,
            commands: [Commands.ReplaceUrl({ url: documentUrl(newest.id) })],
          }
        : {
            model: next,
            commands: [Commands.CreateDocument({ source: initialScore })],
          }
    },
    GotLocalDocuments: ({ documents }) => {
      const next = { ...model, documents: documents.map(Commands.localSummary) }
      const route = model.route
      if (route._tag === 'Home') {
        const newest = documents[0]
        if (newest)
          return {
            model: next,
            commands: [Commands.ReplaceUrl({ url: documentUrl(newest.id) })],
          }
        const created = newLocalDocument(initialScore)
        return {
          model: next,
          commands: [
            Commands.SaveLocalDocument({
              id: created.id,
              source: created.source,
            }),
            Commands.ReplaceUrl({ url: documentUrl(created.id) }),
          ],
        }
      }
      if (route._tag === 'Document' && route.documentId !== model.documentId) {
        const document = documents.find((doc) => doc.id === route.documentId)
        if (document) return openLocal(next, document.id, document.source)
        return {
          model: { ...next, notice: 'That document is not in this browser.' },
          commands: [Commands.ReplaceUrl({ url: '/' })],
        }
      }
      return { model: next }
    },
    CreatedDocument: ({ id }) => ({
      model,
      commands: [
        model.route._tag === 'Home'
          ? Commands.ReplaceUrl({ url: documentUrl(id) })
          : Commands.PushUrl({ url: documentUrl(id) }),
      ],
    }),
    FailedApi: ({ error }) => ({
      model: { ...model, chatError: error, chatOpen: true, loading: false },
    }),
    ToggledDocuments: () => {
      const open = !model.documentsOpen
      return {
        model: { ...model, documentsOpen: open },
        commands: open
          ? [
              model.session._tag === 'SignedIn'
                ? Commands.FetchDocuments()
                : Commands.LoadLocalDocuments(),
            ]
          : [],
      }
    },
    ClickedNewDocument: () => {
      const next = { ...model, documentsOpen: false }
      if (model.session._tag === 'SignedIn')
        return {
          model: next,
          commands: [Commands.CreateDocument({ source: initialScore })],
        }
      const created = newLocalDocument(initialScore)
      return {
        model: next,
        commands: [
          Commands.SaveLocalDocument({
            id: created.id,
            source: created.source,
          }),
          Commands.PushUrl({ url: documentUrl(created.id) }),
        ],
      }
    },
    ClickedDeleteDocument: ({ id }) => ({
      model,
      commands: [
        isLocalId(id)
          ? Commands.DeleteLocalDocument({ id })
          : Commands.DeleteDocument({ id }),
      ],
    }),
    DeletedDocument: ({ id }) => {
      const next = {
        ...model,
        documents: model.documents.filter((doc) => doc.id !== id),
      }
      return id === model.documentId
        ? {
            model: closeDocument(next),
            commands: [Commands.ReplaceUrl({ url: '/' })],
          }
        : { model: next }
    },

    // Score source -------------------------------------------------------------
    EditedSource: ({ text }) => {
      if (text === model.source) return { model }
      const generation = model.saveGeneration + 1
      return andThen(
        // Typing after an undo starts a new branch; the undone replacement is no longer redoable.
        withSource(
          { ...model, redo: [], saveGeneration: generation, dirty: true },
          text,
          {
            syncEditor: false,
          },
        ),
        (next) => ({
          model: next,
          commands: [Commands.DebounceSave({ generation })],
        }),
      )
    },
    ElapsedSaveDebounce: ({ generation }) =>
      generation === model.saveGeneration ? saveNow(model) : { model },
    ClickedUndo: () => (isBusy(model) ? { model } : travel(model, 'undo')),
    ClickedRedo: () => (isBusy(model) ? { model } : travel(model, 'redo')),
    ClickedOpenFile: () => ({ model, commands: [Commands.ClickFileInput()] }),
    SelectedFiles: ({ files }) => {
      const file = files[0]
      return file && !isBusy(model)
        ? { model, commands: [Commands.ReadScoreFile({ file })] }
        : { model }
    },
    ReadFile: ({ text }) => replaceScore({ ...model, chatError: '' }, text),
    FailedReadFile: ({ error }) => ({
      model: { ...model, chatError: error, chatOpen: true },
    }),
    ChangedFileDrag: ({ active }) => ({
      model: { ...model, fileDrag: active },
    }),
    ClickedDownload: () => ({
      model,
      commands: [Commands.DownloadSource({ source: model.source })],
    }),
    ClickedErrorPosition: ({ position }) => {
      const prefs = { ...model.prefs, view: 'source' as const }
      return {
        model: {
          ...model,
          prefs,
          sourceOpened: true,
          reveal: { position, request: (model.reveal?.request ?? 0) + 1 },
        },
        commands: [RevealInEditor({ position }), Commands.SavePrefs({ prefs })],
      }
    },

    // Rendering ------------------------------------------------------------------
    ElapsedRenderDebounce: ({ generation }) => {
      if (generation !== model.renderGeneration) return { model }
      const stale = model.renderStarted
      return {
        model: {
          ...model,
          renderStarted: generation,
          renderRevision: model.revision,
        },
        commands: [
          ...(stale !== null
            ? [
                Commands.RenderScore.Interrupt({ generation: stale }, () =>
                  Message.Completed(),
                ),
              ]
            : []),
          Commands.RenderScore({ generation, source: model.source }),
        ],
      }
    },
    RenderedScore: ({ generation, result }) => {
      if (generation !== model.renderGeneration) return { model }
      const next: Model = {
        ...model,
        rendered: result,
        renderedSource: model.source,
        rendering: false,
        renderStarted: null,
        loading: false,
        page: Math.min(model.page, Math.max(0, result.pages.length - 1)),
      }
      // The full render also engraves the score, which the server's check does not.
      const report =
        model.documentKind === 'remote' &&
        model.renderRevision === model.revision
          ? send(model, {
              _tag: 'Rendered',
              revision: model.revision,
              errors: [...result.errors],
              positions: [...result.positions],
            })
          : []
      return { model: next, commands: [editorErrors(next), ...report] }
    },

    // Document socket --------------------------------------------------------------
    ConnectedSocket: () => {
      if (model.socket._tag !== 'Connecting') return { model }
      const next: Model = {
        ...model,
        socket: { _tag: 'Connected', attempt: model.socket.attempt },
      }
      return {
        model: next,
        commands: send(next, { _tag: 'Hello', since: model.lastSeq }),
      }
    },
    ReleasedSocket: () => ({ model }),
    FailedConnectSocket: () => {
      if (
        model.socket._tag !== 'Connecting' &&
        model.socket._tag !== 'Connected'
      )
        return { model }
      return {
        model: {
          ...model,
          socket: {
            _tag: 'WaitingToReconnect',
            attempt: model.socket.attempt + 1,
          },
          retries: model.retries + 1,
        },
        commands: [WaitToReconnect({ attempt: model.retries })],
      }
    },
    ClosedSocket: ({ code }) => {
      if (code === 4404)
        return {
          model: {
            ...closeDocument(model),
            notice: 'This document was deleted.',
          },
          commands: [Commands.ReplaceUrl({ url: '/' })],
        }
      if (model.socket._tag !== 'Connected') return { model }
      return {
        model: {
          ...model,
          socket: {
            _tag: 'WaitingToReconnect',
            attempt: model.socket.attempt + 1,
          },
          saving: false,
          retries: model.retries + 1,
        },
        commands: [WaitToReconnect({ attempt: model.retries })],
      }
    },
    ElapsedReconnectDelay: () =>
      model.socket._tag === 'WaitingToReconnect'
        ? {
            model: {
              ...model,
              socket: { _tag: 'Connecting', attempt: model.socket.attempt },
            },
          }
        : { model },
    ReceivedEvent: ({ event }) => {
      const result = receive(model, event)
      const queued = result.model.queued
      if (
        !queued ||
        (event._tag !== 'Snapshot' && event._tag !== 'Replayed') ||
        isBusy(result.model)
      )
        return result
      return andThen(result, (next) => ({
        model: { ...next, queued: null },
        commands: send(next, { _tag: 'Send', ...queued }),
      }))
    },
    FailedSend: () => ({ model: { ...model, saving: false } }),

    // Chat ----------------------------------------------------------------------------
    ChangedInput: ({ value }) => ({ model: { ...model, input: value } }),
    SubmittedMessage: () => {
      const text = model.input.trim()
      if (!text || isBusy(model)) return { model }
      // Still finding out who is signed in: send it once the document is open.
      if (model.session._tag === 'Checking')
        return {
          model: {
            ...model,
            input: '',
            chatOpen: true,
            queued: { text, selection: highlightedNotes(model) },
          },
        }
      if (model.session._tag !== 'SignedIn')
        return {
          model: {
            ...model,
            loginOpen: true,
            loginState: 'idle',
            loginReason:
              'Sign in to use the assistant. Your documents in this browser move to your account.',
          },
        }
      if (model.documentKind !== 'remote')
        return {
          model: {
            ...model,
            chatError:
              'Open a document from your account to use the assistant.',
          },
        }
      if (!model.session.me.settings.hasApiKey)
        return {
          model: {
            ...model,
            settingsOpen: true,
            settingsDraft: settingsDraft(model),
            settingsError: '',
          },
        }
      if (model.socket._tag !== 'Connected' || model.loading)
        return {
          model: {
            ...model,
            input: '',
            chatError: '',
            chatOpen: true,
            queued: { text, selection: highlightedNotes(model) },
          },
        }
      return {
        model: { ...model, input: '', chatError: '', chatOpen: true },
        commands: send(model, {
          _tag: 'Send',
          text,
          selection: highlightedNotes(model),
        }),
      }
    },
    PressedComposerEscape: () => ({ model: { ...model, chatOpen: false } }),
    ClickedStop: () => ({ model, commands: send(model, { _tag: 'Stop' }) }),
    ClickedClearChat: () => ({
      model: { ...model, chatError: '' },
      commands:
        model.documentKind === 'remote'
          ? send(model, { _tag: 'ClearChat' })
          : [],
    }),
    DismissedChatError: () => ({ model: { ...model, chatError: '' } }),
    ToggledChat: () =>
      model.ignoreToggle
        ? { model: { ...model, ignoreToggle: false } }
        : { model: { ...model, chatOpen: !model.chatOpen } },
    ClickedHideChat: () => ({
      model: { ...model, chatHidden: true, unread: false },
    }),
    ClickedShowChat: () => ({
      model: { ...model, chatHidden: false, unread: false },
    }),
    ToggledThinking: ({ key }) => ({
      model: {
        ...model,
        expandedThinking: model.expandedThinking.includes(key)
          ? model.expandedThinking.filter((open) => open !== key)
          : [...model.expandedThinking, key],
      },
    }),

    // Score view ----------------------------------------------------------------------
    ChangedView: ({ view }) => {
      const prefs = { ...model.prefs, view }
      return {
        model: {
          ...model,
          prefs,
          sourceOpened: model.sourceOpened || view === 'source',
          // Only for the visit it was requested for; reopening the source keeps its place.
          reveal: view === 'source' ? model.reveal : null,
        },
        commands: [Commands.SavePrefs({ prefs })],
      }
    },
    ClickedZoom: ({ step }) => ({
      model: { ...model, zoom: Math.max(45, Math.min(145, model.zoom + step)) },
    }),
    TurnedPage: ({ step }) => {
      const next = firstPage(model) + step * spread(model)
      return next >= 0 && next < model.rendered.pages.length
        ? {
            model: { ...model, page: next },
            commands: [Commands.ScrollScoreToTop()],
          }
        : { model }
    },
    MeasuredCanvas: ({ width }) => ({
      model: { ...model, canvasWidth: width },
    }),
    ToggledHighlighter: () => ({
      model: { ...model, highlighting: !model.highlighting },
    }),
    ChangedMarquee: ({ page, box }) =>
      model.highlighting && isFresh(model)
        ? { model: { ...model, marquee: box ? { page, box } : null } }
        : { model },
    Swiped: ({ page, box }) => {
      const next = { ...model, marquee: null }
      if (!model.highlighting || !isFresh(model)) return { model: next }
      const keys = anchorsInBox(model.rendered.anchors, box, page).map(
        anchorKey,
      )
      if (!keys.length) return { model: next }
      // A swipe over notes that are all highlighted already lifts the marker instead.
      const current = new Set(model.selected)
      const lift = keys.every((key) => current.has(key))
      for (const key of keys) lift ? current.delete(key) : current.add(key)
      return { model: { ...next, selected: [...current] } }
    },
    ClearedHighlights: () => ({ model: { ...model, selected: [] } }),

    // Playback --------------------------------------------------------------------------
    ClickedPlay: () => {
      if (model.playback === 'loading') return { model }
      if (model.playback === 'playing')
        return {
          model: { ...model, playback: 'paused' },
          commands: [Commands.Pause()],
        }
      return {
        model: {
          ...model,
          playback: model.playback === 'paused' ? 'paused' : 'loading',
          playbackError: '',
          playbackErrorPosition: null,
        },
        commands: [Commands.Play({ source: model.source })],
      }
    },
    ClickedRewind: () => ({
      model: { ...model, playback: 'stopped', sounding: [] },
      commands: [Commands.Rewind()],
    }),
    StartedPlayback: () =>
      model.playback === 'loading' || model.playback === 'paused'
        ? { model: { ...model, playback: 'playing' } }
        : { model },
    FailedPlayback: ({ error, position }) => {
      if (!error) return { model: { ...model, playback: 'stopped' } }
      const next: Model = {
        ...model,
        playback: 'stopped',
        playbackError: error,
        playbackErrorPosition: position,
      }
      return { model: next, commands: [editorErrors(next)] }
    },
    ChangedSounding: ({ keys }) => {
      const sounding = new Set(keys)
      // Turn to the page that is playing.
      const anchor = model.rendered.anchors.find(
        (anchor) =>
          anchor.kind === 'NoteHead' && sounding.has(anchorKey(anchor)),
      )
      const first = firstPage(model)
      const turn =
        anchor && (anchor.page < first || anchor.page >= first + spread(model))
      return {
        model: {
          ...model,
          sounding: keys,
          ...(turn ? { page: anchor.page } : {}),
        },
        commands: [
          ...(turn ? [Commands.ScrollScoreToTop()] : []),
          Commands.FollowSoundingNotes(),
        ],
      }
    },
    EndedPlayback: () => ({
      model: { ...model, playback: 'stopped', sounding: [] },
    }),

    // Assistant dock ----------------------------------------------------------------------
    MeasuredStage: ({ box }) => ({ model: { ...model, stage: box } }),
    MeasuredDock: ({ width, height }) => ({
      model: { ...model, dockMeasure: { width, height } },
    }),
    PressedDockHeading: ({ x, y }) => ({
      model: {
        ...model,
        dockDrag: { startX: x, startY: y, x: 0, y: 0, moved: false },
      },
    }),
    MovedDock: ({ x, y }) => {
      const drag = model.dockDrag
      if (!drag) return { model }
      const offset = { x: x - drag.startX, y: y - drag.startY }
      if (!drag.moved && Math.hypot(offset.x, offset.y) < 6) return { model }
      return {
        model: { ...model, dockDrag: { ...drag, ...offset, moved: true } },
      }
    },
    ReleasedDock: ({ x, y }) => {
      const drag = model.dockDrag
      if (!drag) return { model }
      if (!drag.moved) return { model: { ...model, dockDrag: null } }
      const prefs = { ...model.prefs, corner: nearestCorner(x, y, model.stage) }
      return {
        model: { ...model, dockDrag: null, ignoreToggle: true, prefs },
        commands: [Commands.SavePrefs({ prefs })],
      }
    },
    PressedDockGrip: ({ x, y }) => ({
      model: {
        ...model,
        dockResize: {
          startX: x,
          startY: y,
          width: model.dockMeasure.width,
          height: model.dockMeasure.height || model.dockSize?.height || 240,
        },
      },
    }),
    MovedDockGrip: ({ x, y }) => {
      const resize = model.dockResize
      if (!resize) return { model }
      const grow = growth(model.prefs.corner)
      return {
        model: {
          ...model,
          dockSize: clampDock(
            {
              width: resize.width + grow.x * (x - resize.startX),
              height: resize.height + grow.y * (y - resize.startY),
            },
            model.stage,
          ),
        },
      }
    },
    ReleasedDockGrip: () => {
      const prefs = { ...model.prefs, dock: model.dockSize }
      return {
        model: { ...model, dockResize: null, prefs },
        commands: [Commands.SavePrefs({ prefs })],
      }
    },
    ResetDockSize: () => {
      const prefs = { ...model.prefs, dock: null }
      return {
        model: { ...model, dockSize: null, prefs },
        commands: [Commands.SavePrefs({ prefs })],
      }
    },
    NudgedDockSize: ({ dx, dy }) => {
      const grow = growth(model.prefs.corner)
      const size = clampDock(
        {
          width: model.dockMeasure.width + grow.x * dx,
          height:
            (model.dockMeasure.height || model.dockSize?.height || 240) +
            grow.y * dy,
        },
        model.stage,
      )
      const prefs = { ...model.prefs, dock: size }
      return {
        model: { ...model, dockSize: size, prefs },
        commands: [Commands.SavePrefs({ prefs })],
      }
    },

    // Settings ----------------------------------------------------------------------------
    ClickedSettings: () => ({
      model: {
        ...model,
        settingsOpen: true,
        settingsDraft: settingsDraft(model),
        settingsError: '',
      },
    }),
    ClosedSettings: () => ({ model: { ...model, settingsOpen: false } }),
    ChangedSettingsDraft: ({ field, value }) => ({
      model: {
        ...model,
        settingsDraft: {
          ...model.settingsDraft,
          ...(field === 'pages'
            ? { pages: value === 'inline' ? 'inline' : 'image' }
            : { [field]: value }),
          ...(field === 'apiKey' && value ? { clearKey: false } : {}),
        },
      },
    }),
    ClickedClearKey: () => ({
      model: {
        ...model,
        settingsDraft: { ...model.settingsDraft, apiKey: '', clearKey: true },
      },
    }),
    SubmittedSettings: () => {
      const draft = model.settingsDraft
      const prefs = { ...model.prefs, pages: draft.pages }
      const savePrefs = Commands.SavePrefs({ prefs })
      if (model.session._tag !== 'SignedIn')
        return {
          model: { ...model, prefs, settingsOpen: false },
          commands: [savePrefs],
        }
      const reasoning =
        reasoningEfforts.find((level) => level === draft.reasoning) ?? null
      const key = draft.apiKey.trim()
      const update: UpdateSettings = {
        model: draft.model.trim() || 'openrouter/auto',
        reasoning,
        ...(key ? { apiKey: key } : draft.clearKey ? { apiKey: null } : {}),
      }
      return {
        model: { ...model, prefs, settingsSaving: true, settingsError: '' },
        commands: [savePrefs, Commands.SaveSettings({ update })],
      }
    },
    SavedSettings: ({ me }) => ({
      model: {
        ...model,
        session: { _tag: 'SignedIn', me },
        settingsOpen: false,
        settingsSaving: false,
      },
    }),
    FailedSaveSettings: ({ error }) => ({
      model: { ...model, settingsSaving: false, settingsError: error },
    }),
  })

export { emptyRender }
