/** The workspace: toolbar, sheet music or source, the assistant dock, and dialogs. */
import { Option } from 'effect'
import {
  createKeyedLazy,
  type Document,
  type Html,
  type HtmlBuilder,
} from 'foldkit/html'
import {
  MAX_MESSAGE_LENGTH,
  scoreTitle,
  type ChatMessage,
} from '../shared/protocol.ts'
import {
  anchorKey,
  markerStrokes,
  summarizeSelection,
} from '../shared/selection.ts'
import { MountEditor } from './editor.ts'
import * as I from './icons.ts'
import { icon } from './icons.ts'
import { markdown } from './markdown.ts'
import { Message } from './message.ts'
import { isBusy, type Model } from './model.ts'
import {
  FollowConversation,
  MarkerOverlay,
  MeasureCanvas,
  MeasureDock,
  MeasureStage,
  ShowModal,
} from './mounts.ts'
import { documentUrl } from './routes.ts'
import { errorMessage } from './sourceErrors.ts'
import { sanitizeSvg } from './svg.ts'
import {
  firstPage,
  highlightedNotes,
  isFresh,
  pageWidth,
  spread,
} from './update.ts'

type H = HtmlBuilder<Message>

const iconButton = (
  h: H,
  label: string,
  node: Parameters<typeof icon>[1],
  message: Message,
  options: {
    disabled?: boolean
    title?: string
    className?: string
    size?: number
    pressed?: boolean
  } = {},
) =>
  h.button(
    [
      h.Class(`icon-button ${options.className ?? ''}`.trim()),
      h.Type('button'),
      h.Title(options.title ?? label),
      h.AriaLabel(label),
      h.Disabled(options.disabled ?? false),
      ...(options.pressed === undefined
        ? []
        : [h.AriaPressed(String(options.pressed))]),
      h.OnClick(message),
    ],
    [icon(h, node, options.size ?? 16)],
  )

const spinner = (h: H, size: number) => icon(h, I.LoaderCircle, size, 'spin')

// ---------------------------------------------------------------------------
// Toolbar

function scoreStatus(h: H, model: Model): Html {
  if (model.loading && !model.rendered.pages.length)
    return h.span(
      [h.Class('score-status'), h.AriaLive('polite')],
      [spinner(h, 11), ' Opening…'],
    )
  if (model.rendering)
    return h.span(
      [h.Class('score-status'), h.AriaLive('polite')],
      [spinner(h, 11), ' Rendering…'],
    )
  if (model.rendered.errors.length)
    return h.span(
      [h.Class('score-status'), h.AriaLive('polite')],
      [h.span([h.Class('status-bad')], ['Could not render this source'])],
    )
  if (model.playbackError)
    return h.span(
      [h.Class('score-status'), h.AriaLive('polite')],
      [
        h.span(
          [h.Class('status-bad'), h.Title(model.playbackError)],
          [`Could not play: ${model.playbackError}`],
        ),
      ],
    )
  const count = model.rendered.pages.length
  return h.span(
    [h.Class('score-status'), h.AriaLive('polite')],
    [
      icon(h, I.Check, 11),
      ` ${count} page${count === 1 ? '' : 's'} · rendered locally`,
    ],
  )
}

function documentsMenu(h: H, model: Model): Html {
  if (!model.documentsOpen) return h.empty
  const signedIn = model.session._tag === 'SignedIn'
  return h.div(
    [h.Class('documents-menu'), h.Role('menu'), h.AriaLabel('Documents')],
    [
      h.div(
        [h.Class('documents-heading')],
        [
          h.span(
            [h.Class('eyebrow')],
            [signedIn ? 'YOUR ACCOUNT' : 'THIS BROWSER'],
          ),
          h.button(
            [
              h.Class('quiet-button'),
              h.Type('button'),
              h.OnClick(Message.ClickedNewDocument()),
            ],
            [icon(h, I.Plus, 14), ' New score'],
          ),
        ],
      ),
      model.documents.length
        ? h.ul(
            [h.Class('documents-list')],
            model.documents.map((document) =>
              h.keyed('li')(
                document.id,
                [h.Class(document.id === model.documentId ? 'current' : '')],
                [
                  h.a(
                    [
                      h.Href(documentUrl(document.id)),
                      h.OnClick(Message.ToggledDocuments()),
                    ],
                    [
                      h.span([h.Class('document-title')], [document.title]),
                      h.span(
                        [h.Class('document-date')],
                        [new Date(document.updatedAt).toLocaleDateString()],
                      ),
                    ],
                  ),
                  iconButton(
                    h,
                    `Delete ${document.title}`,
                    I.Trash2,
                    Message.ClickedDeleteDocument({ id: document.id }),
                    {
                      size: 14,
                      title: 'Delete',
                    },
                  ),
                ],
              ),
            ),
          )
        : h.p([h.Class('field-help')], ['No scores yet.']),
      signedIn
        ? h.empty
        : h.p(
            [h.Class('field-help')],
            [
              'Scores are kept in this browser. ',
              h.button(
                [
                  h.Class('link-button'),
                  h.Type('button'),
                  h.OnClick(Message.ClickedSignIn()),
                ],
                ['Sign in'],
              ),
              ' to keep them in your account and use the assistant.',
            ],
          ),
    ],
  )
}

function toolbar(h: H, model: Model): Html {
  const busy = isBusy(model)
  const view = model.prefs.view
  const pageCount = model.rendered.pages.length
  const first = firstPage(model)
  const shown = Math.min(spread(model), Math.max(0, pageCount - first))
  const playing = model.playback === 'playing'
  const title = scoreTitle(model.source)
  return h.header(
    [h.Class('toolbar')],
    [
      h.div(
        [h.Class('toolbar-group toolbar-left')],
        [
          h.a(
            [h.Class('brand'), h.Href('/'), h.AriaLabel('Score Chat home')],
            [
              h.span([h.Class('brand-icon')], [icon(h, I.Music2, 18)]),
              h.span(
                [h.Class('brand-name')],
                ['score', h.span([h.Class('brand-light')], ['chat'])],
              ),
            ],
          ),
          h.span([h.Class('toolbar-divider')], []),
          h.div(
            [h.Class('score-title')],
            [h.h1([h.Title(title)], [title]), scoreStatus(h, model)],
          ),
          iconButton(h, 'Documents', I.Files, Message.ToggledDocuments(), {
            title: 'Your scores',
            pressed: model.documentsOpen,
          }),
          documentsMenu(h, model),
        ],
      ),
      h.div(
        [h.Class('tabs'), h.Role('tablist'), h.AriaLabel('Score view')],
        [
          h.button(
            [
              h.Id('score-tab'),
              h.Role('tab'),
              h.AriaLabel('Sheet music'),
              h.AriaSelected(view === 'score'),
              h.AriaControls('score-panel'),
              h.OnClick(Message.ChangedView({ view: 'score' })),
            ],
            [icon(h, I.Music2, 15), h.span([], ['Sheet music'])],
          ),
          h.button(
            [
              h.Id('source-tab'),
              h.Role('tab'),
              h.AriaLabel('LilyPond'),
              h.AriaSelected(view === 'source'),
              h.AriaControls('source-panel'),
              h.OnClick(Message.ChangedView({ view: 'source' })),
            ],
            [icon(h, I.Code2, 15), h.span([], ['LilyPond'])],
          ),
        ],
      ),
      h.div(
        [h.Class('toolbar-group toolbar-right')],
        [
          iconButton(
            h,
            'Undo last score replacement',
            I.Undo2,
            Message.ClickedUndo(),
            {
              disabled: busy || !model.undo.length,
            },
          ),
          iconButton(
            h,
            'Redo score replacement',
            I.Redo2,
            Message.ClickedRedo(),
            {
              disabled: busy || !model.redo.length,
            },
          ),
          h.span([h.Class('toolbar-divider')], []),
          h.button(
            [
              h.Class(`icon-button ${playing ? 'playing' : ''}`),
              h.Type('button'),
              h.Title(playing ? 'Pause' : 'Play'),
              h.AriaLabel(playing ? 'Pause' : 'Play'),
              h.Disabled(!isFresh(model) && model.playback === 'stopped'),
              h.OnClick(Message.ClickedPlay()),
            ],
            [
              model.playback === 'loading'
                ? spinner(h, 16)
                : icon(h, playing ? I.Pause : I.Play, 16),
            ],
          ),
          iconButton(
            h,
            'Back to the start',
            I.SkipBack,
            Message.ClickedRewind(),
            {
              disabled: model.playback === 'stopped',
            },
          ),
          ...(view === 'score'
            ? [
                iconButton(
                  h,
                  'Highlight notes for the assistant',
                  I.Highlighter,
                  Message.ToggledHighlighter(),
                  {
                    className: model.highlighting ? 'active' : '',
                    pressed: model.highlighting,
                  },
                ),
                h.div(
                  [h.Class('page-controls')],
                  [
                    iconButton(
                      h,
                      'Previous page',
                      I.ChevronLeft,
                      Message.TurnedPage({ step: -1 }),
                      {
                        disabled: first === 0,
                      },
                    ),
                    h.span(
                      [h.Class('page-label'), h.AriaLive('polite')],
                      [
                        pageCount
                          ? `${first + 1}${shown > 1 ? `–${first + shown}` : ''} / ${pageCount}`
                          : '–',
                      ],
                    ),
                    iconButton(
                      h,
                      'Next page',
                      I.ChevronRight,
                      Message.TurnedPage({ step: 1 }),
                      {
                        disabled: first + spread(model) >= pageCount,
                      },
                    ),
                  ],
                ),
                h.div(
                  [h.Class('zoom-controls')],
                  [
                    iconButton(
                      h,
                      'Zoom out',
                      I.ZoomOut,
                      Message.ClickedZoom({ step: -10 }),
                      {
                        disabled: model.zoom <= 45,
                      },
                    ),
                    h.span([h.Class('zoom-label')], [`${model.zoom}%`]),
                    iconButton(
                      h,
                      'Zoom in',
                      I.ZoomIn,
                      Message.ClickedZoom({ step: 10 }),
                      {
                        disabled: model.zoom >= 145,
                      },
                    ),
                  ],
                ),
              ]
            : []),
          h.span([h.Class('toolbar-divider')], []),
          iconButton(h, 'Open .ly', I.FileUp, Message.ClickedOpenFile(), {
            disabled: busy,
          }),
          iconButton(
            h,
            'Download .ly',
            I.ArrowDownToLine,
            Message.ClickedDownload(),
          ),
          h.span([h.Class('toolbar-divider')], []),
          model.session._tag === 'SignedOut'
            ? h.button(
                [
                  h.Class('quiet-button sign-in-button'),
                  h.Type('button'),
                  h.OnClick(Message.ClickedSignIn()),
                ],
                ['Sign in'],
              )
            : h.empty,
          iconButton(h, 'Settings', I.Settings2, Message.ClickedSettings(), {
            disabled: busy,
          }),
        ],
      ),
    ],
  )
}

// ---------------------------------------------------------------------------
// Sheet music

// Data URLs and sanitized markup are rebuilt only when a page changes.
const lazyPage = createKeyedLazy()
const pageImage = (svg: string, index: number, inline: boolean, h: H): Html =>
  inline
    ? h.div(
        [
          h.Class('sheet-svg'),
          h.Role('img'),
          h.AriaLabel(`Sheet music, page ${index + 1}`),
          h.InnerHTML(sanitizeSvg(svg)),
        ],
        [],
      )
    : h.img([
        h.Alt(`Sheet music, page ${index + 1}`),
        h.Src(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`),
      ])

function pageOverlay(h: H, model: Model, svg: string, index: number): Html {
  const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 1 1'
  const [, , width = 1, height = 1] = viewBox.split(' ').map(Number)
  const selected = new Set(model.selected)
  const sounding = new Set(model.sounding)
  const rect = (
    className: string,
    box: { x: number; y: number; width: number; height: number },
    rx: number,
  ) =>
    h.rect([
      h.Class(className),
      h.Attribute('rx', String(rx)),
      h.Attribute('x', String(box.x)),
      h.Attribute('y', String(box.y)),
      h.Attribute('width', String(box.width)),
      h.Attribute('height', String(box.height)),
    ])
  const active = model.highlighting && isFresh(model)
  // Keyed by its size, so the swipe handler knows the page's units.
  return h.keyed('svg')(
    `overlay-${index}-${viewBox}`,
    [
      h.Class(`page-overlay ${active ? 'active' : ''}`),
      h.ViewBox(viewBox),
      h.AriaHidden(true),
      h.OnMount(MarkerOverlay({ page: index, width, height })),
    ],
    [
      ...markerStrokes(model.rendered.anchors, selected, index).map((box) =>
        rect('marker', box, 1),
      ),
      ...model.rendered.anchors
        .filter(
          (anchor) =>
            anchor.page === index &&
            anchor.kind === 'NoteHead' &&
            sounding.has(anchorKey(anchor)),
        )
        .map((anchor) =>
          rect(
            'sounding',
            {
              x: anchor.x - 0.5,
              y: anchor.y - 0.5,
              width: anchor.width + 1,
              height: anchor.height + 1,
            },
            0.6,
          ),
        ),
      ...(model.marquee?.page === index
        ? [rect('marquee', model.marquee.box, 0)]
        : []),
    ],
  )
}

function scoreCanvas(h: H, model: Model): Html {
  const pages = spread(model)
  const first = firstPage(model)
  const fresh = isFresh(model)
  const width = pageWidth(model)
  const shown = model.rendered.pages
    .slice(first, first + pages)
    .map((svg, offset) => ({ svg, index: first + offset }))
  const inline = model.prefs.pages === 'inline'
  return h.div(
    [
      h.Id('score-panel'),
      h.Role('tabpanel'),
      h.AriaLabelledBy('score-tab'),
      h.Class('score-canvas'),
      h.AriaBusy(model.rendering),
      h.Hidden(model.prefs.view !== 'score'),
      h.OnMount(MeasureCanvas()),
    ],
    [
      (model.rendering || model.loading) && !model.rendered.pages.length
        ? h.div(
            [h.Class('empty-score')],
            [
              spinner(h, 24),
              h.p(
                [],
                [
                  model.loading
                    ? 'Opening your score…'
                    : 'Engraving your music…',
                ],
              ),
            ],
          )
        : h.empty,
      shown.length
        ? h.div(
            [h.Class('page-spread')],
            shown.map(({ svg, index }) =>
              h.keyed('div')(
                index,
                [
                  h.Class(`sheet-page ${fresh ? '' : 'stale'}`),
                  h.Style({
                    width:
                      pages > 1
                        ? `${width}px`
                        : `min(${width}px, ${(model.zoom / 85) * 100}%)`,
                  }),
                ],
                [
                  lazyPage(`page-${index}`, pageImage, [svg, index, inline, h]),
                  pageOverlay(h, model, svg, index),
                ],
              ),
            ),
          )
        : h.empty,
      !model.rendering && !model.loading && !model.rendered.pages.length
        ? h.div(
            [h.Class('empty-score')],
            [
              icon(h, I.FileMusic, 32),
              h.p([], [model.notice || 'This score needs a little attention.']),
              model.notice
                ? h.empty
                : h.button(
                    [
                      h.Class('outlined-button'),
                      h.Type('button'),
                      h.OnClick(Message.ChangedView({ view: 'source' })),
                    ],
                    ['Edit LilyPond source'],
                  ),
            ],
          )
        : h.empty,
    ],
  )
}

function renderErrors(h: H, model: Model): Html {
  if (!model.rendered.errors.length || model.rendering) return h.empty
  return h.div(
    [h.Class('render-errors'), h.Role('alert')],
    model.rendered.errors.map((message, index) => {
      const position = model.rendered.positions[index]
      return h.div(
        [],
        [
          position
            ? h.button(
                [
                  h.Class('error-position'),
                  h.Type('button'),
                  h.Title('Show in the LilyPond source'),
                  h.OnClick(Message.ClickedErrorPosition({ position })),
                ],
                [`Line ${position.line}, column ${position.column}`],
              )
            : h.empty,
          errorMessage(message),
        ],
      )
    }),
  )
}

// ---------------------------------------------------------------------------
// Assistant

const lazyMarkdown = createKeyedLazy()
const markdownView = (text: string, h: H) => markdown(h, text)

function thinking(
  h: H,
  model: Model,
  key: string,
  text: string,
  live: boolean,
): Html {
  const expanded = model.expandedThinking.includes(key)
  return h.div(
    [h.Class('thinking')],
    [
      h.button(
        [
          h.Type('button'),
          h.Class('thinking-toggle'),
          h.AriaExpanded(expanded),
          h.OnClick(Message.ToggledThinking({ key })),
        ],
        [
          icon(h, I.Brain, 12),
          live ? 'Thinking…' : 'Thought process',
          icon(h, expanded ? I.ChevronUp : I.ChevronDown, 12),
        ],
      ),
      expanded || live
        ? h.div(
            [h.Class(`thinking-text ${expanded ? '' : 'tail'}`)],
            [h.div([], [text])],
          )
        : h.empty,
    ],
  )
}

function chatMessage(
  h: H,
  model: Model,
  message: ChatMessage,
  last: boolean,
): Html {
  const busy = isBusy(model)
  const assistant = message.role === 'assistant'
  const parts = message.parts ?? [{ type: 'text' as const, text: message.text }]
  return h.keyed('div')(
    message.id,
    [h.Class(`message ${message.role}`)],
    [
      h.span(
        [h.Class('message-author')],
        [
          icon(h, assistant ? I.Sparkles : I.MessageSquare, 14),
          assistant ? 'Assistant' : 'You',
        ],
      ),
      assistant
        ? h.div(
            [h.Class('message-body')],
            parts.map((part, index) =>
              part.type === 'thinking'
                ? thinking(
                    h,
                    model,
                    `${message.id}:${index}`,
                    part.text,
                    busy && last && index === parts.length - 1,
                  )
                : lazyMarkdown(`${message.id}:${index}`, markdownView, [
                    part.text,
                    h,
                  ]),
            ),
          )
        : h.div([h.Class('message-text')], [message.text]),
      message.selection?.length
        ? h.div(
            [h.Class('message-selection')],
            [
              icon(h, I.Highlighter, 11),
              message.selection.map((note) => note.text).join(' '),
            ],
          )
        : h.empty,
    ],
  )
}

function connection(model: Model): string {
  if (model.documentKind !== 'remote') return ''
  switch (model.socket._tag) {
    case 'Connected':
      return ''
    case 'Connecting':
      return model.socket.attempt ? 'Reconnecting…' : 'Connecting…'
    case 'WaitingToReconnect':
      return 'Offline · reconnecting soon'
    case 'Disconnected':
      return ''
  }
}

function dock(h: H, model: Model): Html {
  const busy = isBusy(model)
  const status = model.run?.status || 'Connecting…'
  const corner = model.prefs.corner
  const notes = highlightedNotes(model)
  const signedIn = model.session._tag === 'SignedIn'
  const settings =
    model.session._tag === 'SignedIn' ? model.session.me.settings : null
  const offline = connection(model)
  const style: Record<string, string> = {}
  if (model.dockSize) style['--chat-height'] = `${model.dockSize.height}px`
  if (model.dockDrag?.moved)
    style.transform = `translate(${model.dockDrag.x}px, ${model.dockDrag.y}px)`
  return h.section(
    [
      h.Class('chat-dock'),
      h.AriaLabel('Music assistant'),
      h.DataAttribute('open', String(model.chatOpen)),
      h.DataAttribute('corner', corner),
      ...(model.dockSize ? [h.DataAttribute('sized', 'true')] : []),
      ...(model.dockDrag?.moved ? [h.DataAttribute('dragging', 'true')] : []),
      h.Hidden(model.chatHidden),
      h.Style(style),
      h.OnMount(MeasureDock()),
    ],
    [
      model.chatOpen
        ? h.div(
            [
              h.Class('dock-resize'),
              h.Role('separator'),
              h.Tabindex(0),
              h.AriaLabel('Resize assistant (double-click to reset)'),
              h.Title('Drag to resize · double-click to reset'),
              h.OnPointerDown((_type, button, _sx, _sy, _t, x, y) =>
                button === 0
                  ? Option.some(Message.PressedDockGrip({ x, y }))
                  : Option.none(),
              ),
              h.OnDoubleClick(Message.ResetDockSize()),
              h.OnKeyDownPreventDefault((key, modifiers) => {
                const step = modifiers.shiftKey ? 60 : 20
                const delta: Record<string, [number, number]> = {
                  ArrowLeft: [-step, 0],
                  ArrowRight: [step, 0],
                  ArrowUp: [0, -step],
                  ArrowDown: [0, step],
                }
                const move = delta[key]
                return move
                  ? Option.some(
                      Message.NudgedDockSize({ dx: move[0], dy: move[1] }),
                    )
                  : Option.none()
              }),
            ],
            [],
          )
        : h.empty,
      h.div(
        [
          h.Class('chat-heading'),
          h.Title('Drag to move the assistant to another corner'),
          h.OnPointerDown((_type, button, _sx, _sy, _t, x, y, _id, target) =>
            button === 0 &&
            !(target as Element | null)?.closest?.('.icon-button')
              ? Option.some(Message.PressedDockHeading({ x, y }))
              : Option.none(),
          ),
        ],
        [
          h.button(
            [
              h.Type('button'),
              h.Class('chat-toggle'),
              h.AriaExpanded(model.chatOpen),
              h.AriaControls('chat-conversation'),
              h.OnClick(Message.ToggledChat()),
            ],
            [
              h.span([h.Class('assistant-icon')], [icon(h, I.Sparkles, 14)]),
              h.h2([], ['Assistant']),
              busy || offline
                ? h.span(
                    [h.Class('chat-subtitle')],
                    [spinner(h, 11), busy ? status : offline],
                  )
                : h.empty,
              icon(h, model.chatOpen ? I.ChevronDown : I.ChevronUp, 16),
            ],
          ),
          model.chatOpen
            ? iconButton(
                h,
                'Clear chat',
                I.Trash2,
                Message.ClickedClearChat(),
                {
                  size: 15,
                  disabled: busy || !model.messages.length,
                },
              )
            : h.empty,
          iconButton(h, 'Hide assistant', I.Minus, Message.ClickedHideChat(), {
            size: 15,
            title: 'Hide assistant (it keeps working)',
          }),
        ],
      ),
      model.chatOpen &&
      (model.messages.length > 0 || model.dockSize || model.queued)
        ? h.div(
            [
              h.Id('chat-conversation'),
              h.Class('chat-messages'),
              h.Role('log'),
              h.AriaLabel('Conversation'),
              h.AriaLive('polite'),
              h.OnMount(FollowConversation()),
            ],
            [
              ...model.messages.map((message, index) =>
                chatMessage(
                  h,
                  model,
                  message,
                  index === model.messages.length - 1,
                ),
              ),
              busy
                ? h.div([h.Class('agent-status')], [spinner(h, 14), status])
                : h.empty,
              model.queued
                ? h.div(
                    [h.Class('agent-status')],
                    [
                      spinner(h, 14),
                      `Sending “${model.queued.text}” when connected…`,
                    ],
                  )
                : h.empty,
            ],
          )
        : h.empty,
      model.chatError
        ? h.div(
            [h.Class('chat-error'), h.Role('alert')],
            [
              model.chatError,
              iconButton(
                h,
                'Dismiss error',
                I.X,
                Message.DismissedChatError(),
                { size: 14 },
              ),
            ],
          )
        : h.empty,
      h.form(
        [h.Class('chat-composer'), h.OnSubmit(Message.SubmittedMessage())],
        [
          notes.length
            ? h.div(
                [h.Class('selection-chip'), h.Role('status')],
                [
                  icon(h, I.Highlighter, 12),
                  h.span([], [`${summarizeSelection(notes)} highlighted`]),
                  h.span(
                    [h.Class('selection-preview')],
                    [notes.map((note) => note.text).join(' ')],
                  ),
                  iconButton(
                    h,
                    'Clear highlights',
                    I.X,
                    Message.ClearedHighlights(),
                    { size: 12 },
                  ),
                ],
              )
            : h.empty,
          h.textarea([
            h.AriaLabel('Message the music assistant'),
            h.Placeholder(
              notes.length
                ? 'What should change for the highlighted notes?'
                : 'What would you like to create?',
            ),
            h.Value(model.input),
            h.Disabled(busy),
            h.Rows(1),
            h.Maxlength(MAX_MESSAGE_LENGTH),
            h.OnInput((value) => Message.ChangedInput({ value })),
            h.OnKeyDownPreventDefault((key, modifiers) =>
              key === 'Enter' && !modifiers.shiftKey
                ? Option.some(Message.SubmittedMessage())
                : key === 'Escape' && model.chatOpen
                  ? Option.some(Message.PressedComposerEscape())
                  : Option.none(),
            ),
          ]),
          h.div(
            [h.Class('composer-bottom')],
            [
              h.button(
                [
                  h.Type('button'),
                  h.Class('model-button'),
                  h.Disabled(busy),
                  h.OnClick(
                    signedIn
                      ? Message.ClickedSettings()
                      : Message.ClickedSignIn(),
                  ),
                ],
                [
                  icon(h, I.SlidersHorizontal, 13),
                  !signedIn
                    ? 'Sign in to chat'
                    : settings?.hasApiKey
                      ? settings.model
                      : 'Connect OpenRouter',
                  icon(h, I.ChevronDown, 12),
                ],
              ),
              busy
                ? h.button(
                    [
                      h.Type('button'),
                      h.Class('send-button'),
                      h.AriaLabel('Stop response'),
                      h.OnClick(Message.ClickedStop()),
                    ],
                    [icon(h, I.Square, 15)],
                  )
                : h.button(
                    [
                      h.Type('submit'),
                      h.Class('send-button'),
                      h.AriaLabel('Send message'),
                      h.Disabled(!model.input.trim()),
                    ],
                    [icon(h, I.ArrowUp, 19)],
                  ),
            ],
          ),
        ],
      ),
    ],
  )
}

function chatHandle(h: H, model: Model): Html {
  if (!model.chatHidden) return h.empty
  const busy = isBusy(model)
  return h.button(
    [
      h.Type('button'),
      h.Class('chat-handle'),
      h.DataAttribute('corner', model.prefs.corner),
      h.Title('Show assistant'),
      h.AriaLabel(
        busy
          ? 'Show assistant (working)'
          : model.unread
            ? 'Show assistant (new messages)'
            : 'Show assistant',
      ),
      h.OnClick(Message.ClickedShowChat()),
    ],
    [
      busy ? spinner(h, 15) : icon(h, I.Sparkles, 15),
      model.unread && !busy ? h.span([h.Class('unread-dot')], []) : h.empty,
    ],
  )
}

// ---------------------------------------------------------------------------
// Dialogs

function settingsDialog(h: H, model: Model): Html {
  if (!model.settingsOpen) return h.empty
  const draft = model.settingsDraft
  const me = model.session._tag === 'SignedIn' ? model.session.me : null
  const field =
    (name: 'model' | 'reasoning' | 'pages' | 'apiKey') => (value: string) =>
      Message.ChangedSettingsDraft({ field: name, value })
  const option = (value: string, label: string, current: string) =>
    h.option([h.Value(value), h.Selected(value === current)], [label])
  return h.dialog(
    [h.OnMount(ShowModal()), h.OnCancel(Message.ClosedSettings())],
    [
      h.form(
        [h.OnSubmit(Message.SubmittedSettings())],
        [
          h.div(
            [h.Class('dialog-heading')],
            [
              h.div(
                [],
                [
                  h.span([h.Class('eyebrow')], ['YOUR WORKSPACE']),
                  h.h2([], ['Settings']),
                ],
              ),
              iconButton(h, 'Close settings', I.X, Message.ClosedSettings(), {
                size: 20,
              }),
            ],
          ),
          ...(me
            ? [
                h.label([h.For('api-key')], ['OpenRouter API key']),
                h.input([
                  h.Id('api-key'),
                  h.Type('password'),
                  h.Autocomplete('off'),
                  h.Spellcheck(false),
                  h.Value(draft.apiKey),
                  h.OnInput(field('apiKey')),
                  h.Placeholder(
                    draft.clearKey
                      ? 'Removed when you save'
                      : me.settings.hasApiKey
                        ? '•••••••• saved'
                        : 'sk-or-v1-…',
                  ),
                ]),
                h.p(
                  [h.Class('field-help')],
                  [
                    'Stored encrypted on Score Chat’s server and used only for your assistant’s requests to OpenRouter. It is never sent back to the browser. Use a key with a spending limit.',
                  ],
                ),
                h.label([h.For('model')], ['Model']),
                h.input([
                  h.Id('model'),
                  h.Value(draft.model),
                  h.OnInput(field('model')),
                  h.Placeholder('openrouter/auto'),
                  h.Autocomplete('off'),
                  h.Spellcheck(false),
                ]),
                h.p(
                  [h.Class('field-help')],
                  [
                    'Enter an ',
                    h.a(
                      [
                        h.Href('https://openrouter.ai/models'),
                        h.Target('_blank'),
                        h.Rel('noreferrer'),
                      ],
                      ['OpenRouter model ID'],
                    ),
                    ' that supports tool calling. The default lets OpenRouter choose.',
                  ],
                ),
                h.label([h.For('reasoning')], ['Thinking']),
                h.select(
                  [h.Id('reasoning'), h.OnChange(field('reasoning'))],
                  [
                    option('default', 'Model default', draft.reasoning),
                    option('none', 'Off', draft.reasoning),
                    option('minimal', 'On · minimal effort', draft.reasoning),
                    option('low', 'On · low effort', draft.reasoning),
                    option('medium', 'On · medium effort', draft.reasoning),
                    option('high', 'On · high effort', draft.reasoning),
                    option('xhigh', 'On · extra high effort', draft.reasoning),
                    option('max', 'On · maximum effort', draft.reasoning),
                  ],
                ),
                h.p(
                  [h.Class('field-help')],
                  [
                    'Lets reasoning models think before answering; their thinking shows in the chat. Higher effort is slower and uses more tokens. Models without reasoning support ignore this, and some only offer a subset of levels.',
                  ],
                ),
              ]
            : []),
          h.label([h.For('pages')], ['Sheet music pages']),
          h.select(
            [h.Id('pages'), h.OnChange(field('pages'))],
            [
              option('image', 'Image (default)', draft.pages),
              option('inline', 'Inline SVG (inspectable)', draft.pages),
            ],
          ),
          h.p(
            [h.Class('field-help')],
            [
              'Inline SVG puts the rendered page markup in the document so you can inspect systems and glyphs with browser developer tools. Scripts and links are stripped from the markup.',
            ],
          ),
          h.div(
            [h.Class('privacy-note')],
            [
              h.div([h.Class('status-dot')], []),
              h.p(
                [],
                [
                  me
                    ? 'Music renders in your browser. The assistant runs on Score Chat’s server and keeps working if you close the page; sending a message shares the conversation and the score with OpenRouter and your selected model provider.'
                    : 'Music renders in your browser, and your scores stay in this browser until you sign in.',
                ],
              ),
            ],
          ),
          me
            ? h.div(
                [h.Class('account-row')],
                [
                  icon(h, I.CircleUser, 16),
                  h.span([], [me.user.email]),
                  h.button(
                    [
                      h.Class('quiet-button'),
                      h.Type('button'),
                      h.OnClick(Message.ClickedSignOut()),
                    ],
                    [icon(h, I.LogOut, 14), ' Sign out'],
                  ),
                ],
              )
            : h.empty,
          model.settingsError
            ? h.p(
                [h.Class('form-error'), h.Role('alert')],
                [model.settingsError],
              )
            : h.empty,
          h.div(
            [h.Class('dialog-actions')],
            [
              me
                ? h.button(
                    [
                      h.Class('quiet-button'),
                      h.Type('button'),
                      h.OnClick(Message.ClickedClearKey()),
                    ],
                    ['Clear key'],
                  )
                : h.button(
                    [
                      h.Class('quiet-button'),
                      h.Type('button'),
                      h.OnClick(Message.ClickedSignIn()),
                    ],
                    ['Sign in'],
                  ),
              h.button(
                [
                  h.Class('primary-button'),
                  h.Type('submit'),
                  h.Disabled(model.settingsSaving),
                ],
                [
                  icon(h, I.Check, 16),
                  model.settingsSaving ? ' Saving…' : ' Save settings',
                ],
              ),
            ],
          ),
        ],
      ),
    ],
  )
}

function loginDialog(h: H, model: Model): Html {
  if (!model.loginOpen || model.session._tag === 'SignedIn') return h.empty
  const sent = model.loginState === 'sent'
  return h.dialog(
    [
      h.Class('login-dialog'),
      h.OnMount(ShowModal()),
      h.OnCancel(Message.ClosedLogin()),
    ],
    [
      h.form(
        [h.OnSubmit(Message.SubmittedLogin())],
        [
          h.div(
            [h.Class('dialog-heading')],
            [
              h.div(
                [],
                [
                  h.span([h.Class('eyebrow')], ['SCORE CHAT ACCOUNT']),
                  h.h2([], ['Sign in']),
                ],
              ),
              iconButton(h, 'Close sign-in', I.X, Message.ClosedLogin(), {
                size: 20,
              }),
            ],
          ),
          model.loginReason
            ? h.p([h.Class('field-help')], [model.loginReason])
            : h.empty,
          sent
            ? h.p(
                [h.Role('status')],
                [
                  `We sent a sign-in link to ${model.loginEmail.trim()}. Open it on this device to continue; it works once, for 15 minutes.`,
                ],
              )
            : h.div(
                [],
                [
                  h.label([h.For('login-email')], ['Email']),
                  h.input([
                    h.Id('login-email'),
                    h.Type('email'),
                    h.Autocomplete('email'),
                    h.Required(true),
                    h.Value(model.loginEmail),
                    h.OnInput((email) => Message.ChangedLoginEmail({ email })),
                    h.Placeholder('you@example.com'),
                  ]),
                  h.p(
                    [h.Class('field-help')],
                    [
                      'We email you a link that signs you in. No password needed. Signing in keeps your scores in your account, on any device, and lets you use the assistant.',
                    ],
                  ),
                ],
              ),
          model.loginError
            ? h.p([h.Class('form-error'), h.Role('alert')], [model.loginError])
            : h.empty,
          h.div(
            [h.Class('dialog-actions')],
            [
              sent
                ? h.button(
                    [
                      h.Class('quiet-button'),
                      h.Type('button'),
                      h.OnClick(Message.ClickedSignIn()),
                    ],
                    ['Use another email'],
                  )
                : h.span([], []),
              sent
                ? h.button(
                    [
                      h.Class('primary-button'),
                      h.Type('button'),
                      h.OnClick(Message.ClosedLogin()),
                    ],
                    ['Done'],
                  )
                : h.button(
                    [
                      h.Class('primary-button'),
                      h.Type('submit'),
                      h.Disabled(model.loginState === 'sending'),
                    ],
                    [
                      model.loginState === 'sending'
                        ? 'Sending…'
                        : 'Email me a link',
                    ],
                  ),
            ],
          ),
        ],
      ),
    ],
  )
}

// ---------------------------------------------------------------------------

export const view = (model: Model, h: H): Document => {
  const style: Record<string, string> = {}
  if (model.dockSize) style['--dock-width'] = `${model.dockSize.width}px`
  return {
    title: `${scoreTitle(model.source)} · Score Chat`,
    body: h.div(
      [h.Class('app-shell')],
      [
        toolbar(h, model),
        h.input([
          h.Type('file'),
          h.Accept('.ly,text/plain'),
          h.Class('visually-hidden score-file'),
          h.AriaLabel('Import LilyPond file'),
          h.OnFileChange((files) => Message.SelectedFiles({ files })),
        ]),
        model.fileDrag
          ? h.div(
              [h.Class('drop-overlay'), h.AriaHidden(true)],
              [
                icon(h, I.FileUp, 28),
                h.span([], ['Drop a LilyPond file to open it']),
              ],
            )
          : h.empty,
        model.loginState === 'verifying'
          ? h.div(
              [h.Class('drop-overlay'), h.Role('status')],
              [spinner(h, 28), h.span([], ['Signing you in…'])],
            )
          : h.empty,
        h.main(
          [
            h.Class('stage'),
            h.DataAttribute(
              'chat',
              model.chatHidden ? 'hidden' : model.chatOpen ? 'open' : 'closed',
            ),
            h.DataAttribute('corner', model.prefs.corner),
            h.AriaLabel('Music workspace'),
            h.Style(style),
            h.OnMount(MeasureStage()),
          ],
          [
            model.storageError
              ? h.div(
                  [h.Class('storage-warning'), h.Role('alert')],
                  [model.storageError],
                )
              : h.empty,
            renderErrors(h, model),
            // Both views stay mounted once opened, so switching keeps each one's
            // scroll position (and the editor's selection and history).
            model.sourceOpened
              ? h.div(
                  [
                    h.Id('source-panel'),
                    h.Role('tabpanel'),
                    h.AriaLabelledBy('source-tab'),
                    h.Class('source-panel'),
                    h.Hidden(model.prefs.view !== 'source'),
                  ],
                  [
                    h.div(
                      [
                        h.Class('source-editor'),
                        h.OnMount(
                          MountEditor({
                            doc: model.source,
                            readOnly: isBusy(model),
                          }),
                        ),
                      ],
                      [],
                    ),
                  ],
                )
              : h.empty,
            scoreCanvas(h, model),
            dock(h, model),
            chatHandle(h, model),
          ],
        ),
        settingsDialog(h, model),
        loginDialog(h, model),
      ],
    ),
  }
}
