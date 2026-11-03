/** Everything that can happen in the client, as fact-named Messages. */
import { Schema } from 'effect'
import { File, Navigation, Url } from 'foldkit'
import { defineMessageUnion } from 'foldkit/message'
import { DocumentSummary, Me, ServerEvent } from '../shared/protocol.ts'
import { Box, LocalDocument, RenderResult, SourcePosition } from './model.ts'

export const Message = defineMessageUnion({
  // Routing and side effects that report nothing.
  ClickedLink: { request: Navigation.UrlRequest },
  ChangedUrl: { url: Url.Url },
  Completed: {},
  StorageFailed: {},

  // Accounts
  GotSession: { me: Me },
  GotNoSession: {},
  ClickedSignIn: {},
  ClosedLogin: {},
  ChangedLoginEmail: { email: Schema.String },
  SubmittedLogin: {},
  SentLoginLink: {},
  FailedLogin: { error: Schema.String },
  VerifiedLogin: { me: Me },
  ImportedLocalDocuments: { documentId: Schema.NullOr(Schema.String) },
  ClickedSignOut: {},
  SignedOut: {},

  // Documents
  GotDocuments: { documents: Schema.Array(DocumentSummary) },
  GotLocalDocuments: { documents: Schema.Array(LocalDocument) },
  CreatedDocument: { id: Schema.String },
  FailedApi: { error: Schema.String },
  ToggledDocuments: {},
  ClickedNewDocument: {},
  ClickedDeleteDocument: { id: Schema.String },
  DeletedDocument: { id: Schema.String },

  // Score source
  EditedSource: { text: Schema.String },
  ElapsedSaveDebounce: { generation: Schema.Number },
  ClickedUndo: {},
  ClickedRedo: {},
  ClickedOpenFile: {},
  SelectedFiles: { files: Schema.Array(File.File) },
  ReadFile: { text: Schema.String },
  FailedReadFile: { error: Schema.String },
  ChangedFileDrag: { active: Schema.Boolean },
  ClickedDownload: {},
  ClickedErrorPosition: { position: SourcePosition },

  // Rendering
  ElapsedRenderDebounce: { generation: Schema.Number },
  RenderedScore: { generation: Schema.Number, result: RenderResult },

  // Document socket
  ConnectedSocket: {},
  ReleasedSocket: {},
  FailedConnectSocket: { error: Schema.String },
  ClosedSocket: { code: Schema.Number },
  ElapsedReconnectDelay: {},
  ReceivedEvent: { event: ServerEvent },
  FailedSend: {},

  // Chat
  ChangedInput: { value: Schema.String },
  SubmittedMessage: {},
  PressedComposerEscape: {},
  ClickedStop: {},
  ClickedClearChat: {},
  DismissedChatError: {},
  ToggledChat: {},
  ClickedHideChat: {},
  ClickedShowChat: {},
  ToggledThinking: { key: Schema.String },

  // Score view
  ChangedView: { view: Schema.Literals(['score', 'source']) },
  ClickedZoom: { step: Schema.Number },
  TurnedPage: { step: Schema.Number },
  MeasuredCanvas: { width: Schema.Number },
  ToggledHighlighter: {},
  ChangedMarquee: { page: Schema.Number, box: Schema.NullOr(Box) },
  Swiped: { page: Schema.Number, box: Box },
  ClearedHighlights: {},

  // Playback
  ClickedPlay: {},
  ClickedRewind: {},
  StartedPlayback: {},
  FailedPlayback: {
    error: Schema.String,
    position: Schema.NullOr(SourcePosition),
  },
  ChangedSounding: { keys: Schema.Array(Schema.String) },
  EndedPlayback: {},

  // Assistant dock
  MeasuredStage: { box: Box },
  MeasuredDock: { width: Schema.Number, height: Schema.Number },
  PressedDockHeading: { x: Schema.Number, y: Schema.Number },
  MovedDock: { x: Schema.Number, y: Schema.Number },
  ReleasedDock: { x: Schema.Number, y: Schema.Number },
  PressedDockGrip: { x: Schema.Number, y: Schema.Number },
  MovedDockGrip: { x: Schema.Number, y: Schema.Number },
  ReleasedDockGrip: {},
  ResetDockSize: {},
  NudgedDockSize: { dx: Schema.Number, dy: Schema.Number },

  // Settings
  ClickedSettings: {},
  ClosedSettings: {},
  ChangedSettingsDraft: {
    field: Schema.Literals(['model', 'reasoning', 'pages', 'apiKey']),
    value: Schema.String,
  },
  ClickedClearKey: {},
  SubmittedSettings: {},
  SavedSettings: { me: Me },
  FailedSaveSettings: { error: Schema.String },
})
export type Message = typeof Message.Type
