/** The Score Chat program: Model, flags, init, update, view, subscriptions. */
import { Effect, Schema } from 'effect'
import type { Runtime } from 'foldkit'
import * as Commands from './commands.ts'
import { Message } from './message.ts'
import { Model, Prefs, emptyRender } from './model.ts'
import { urlToAppRoute } from './routes.ts'
import { readPrefs } from './storage.ts'

export { Message, Model }
export { update } from './update.ts'
export { view } from './view.ts'
export { subscriptions } from './subscriptions.ts'
export { managedResources } from './socket.ts'

export const Flags = Schema.Struct({
  prefs: Prefs,
  storageWorks: Schema.Boolean,
})
export type Flags = typeof Flags.Type

/** What the browser knows before the program starts: stored preferences. */
export const flags: Effect.Effect<Flags> = Effect.sync(() => {
  let storageWorks = true
  try {
    const probe = 'score-chat.probe'
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
  } catch {
    storageWorks = false
  }
  let prefs = readPrefs({ getItem: () => null })
  try {
    prefs = readPrefs(localStorage)
  } catch {
    // Unavailable storage leaves the defaults.
  }
  return { prefs, storageWorks }
})

export const initialModel = (flags: Flags, route: Model['route']): Model => ({
  route,
  session: { _tag: 'Checking' },
  prefs: flags.prefs,
  storageError: flags.storageWorks
    ? ''
    : 'Browser storage is unavailable or full. Changes will only last for this session.',
  documents: [],
  documentsOpen: false,
  documentId: null,
  documentKind: 'local',
  loading: true,
  notice: '',
  source: '',
  revision: 0,
  saveGeneration: 0,
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
  input: '',
  queued: null,
  chatError: '',
  chatOpen: true,
  chatHidden: false,
  unread: false,
  expandedThinking: [],
  renderGeneration: 0,
  rendering: false,
  rendered: emptyRender,
  renderedSource: '',
  renderRevision: 0,
  renderStarted: null,
  playback: 'stopped',
  playbackError: '',
  playbackErrorPosition: null,
  sounding: [],
  zoom: 85,
  page: 0,
  canvasWidth: 0,
  highlighting: false,
  selected: [],
  marquee: null,
  reveal: null,
  sourceOpened: flags.prefs.view === 'source',
  fileDrag: false,
  stage: { x: 0, y: 0, width: 0, height: 0 },
  dockMeasure: { width: 0, height: 0 },
  dockSize: flags.prefs.dock,
  dockDrag: null,
  dockResize: null,
  ignoreToggle: false,
  settingsOpen: false,
  settingsDraft: {
    model: '',
    reasoning: 'default',
    pages: flags.prefs.pages,
    apiKey: '',
    clearKey: false,
  },
  settingsSaving: false,
  settingsError: '',
  loginOpen: false,
  loginEmail: '',
  loginState: 'idle',
  loginError: '',
  loginReason: '',
})

export const init: Runtime.RoutingApplicationInit<Model, Message, Flags> = (
  flags,
  url,
) => ({
  model: initialModel(flags, urlToAppRoute(url)),
  // Everything else waits until it is known whether someone is signed in.
  commands: [Commands.FetchSession()],
})
