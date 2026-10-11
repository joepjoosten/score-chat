import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAtom, useAtomValue } from '@effect/atom-react'
import {
  ArrowDownToLine,
  ArrowUp,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code2,
  FileMusic,
  FileUp,
  Highlighter,
  LoaderCircle,
  Minus,
  MessageSquare,
  Music2,
  Pause,
  Play,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  SkipBack,
  Trash2,
  Redo2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  appendChunk,
  defaults,
  reasoningEfforts,
  messagesAtom,
  registry,
  settingsAtom,
  sourceAtom,
  storageErrorAtom,
} from './state'
import type { DockCorner, Message, MessagePart, Settings } from './state'
import { MAX_SOURCE_LENGTH, renderScore } from './renderer'
import type { RenderResult, SourcePosition } from './renderer'
import { errorMessage } from './sourceErrors'
import {
  anchorKey,
  anchorsInBox,
  dragBox,
  markerStrokes,
  selectedNotes,
  summarizeSelection,
} from './selection'
import type { Anchor, Box } from './selection'
import { sanitizeSvg } from './svg'
import { usePlayback } from './player'

// CodeMirror loads with the LilyPond tab, keeping it out of the main bundle.
const SourceEditor = lazy(() => import('./SourceEditor'))

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Felt-tip highlights over one rendered page, plus the marquee while swiping. */
function PageOverlay({
  page,
  viewBox,
  anchors,
  selected,
  sounding,
  active,
  onSelect,
}: {
  page: number
  viewBox: string
  anchors: readonly Anchor[]
  selected: ReadonlySet<string>
  /** Anchor keys of the notes playing right now. */
  sounding: ReadonlySet<string>
  active: boolean
  onSelect: (anchors: Anchor[]) => void
}) {
  const svg = useRef<SVGSVGElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const [marquee, setMarquee] = useState<Box | null>(null)
  const [, , width, height] = viewBox.split(' ').map(Number)
  // The overlay shares the page's viewBox and aspect ratio, so page units scale linearly with pixels.
  const toPage = (event: React.PointerEvent) => {
    const rect = svg.current!.getBoundingClientRect()
    return {
      x: ((event.clientX - rect.left) / rect.width) * width,
      y: ((event.clientY - rect.top) / rect.height) * height,
    }
  }
  return (
    <svg
      ref={svg}
      className={`page-overlay ${active ? 'active' : ''}`}
      viewBox={viewBox}
      aria-hidden="true"
      onPointerDown={(event) => {
        if (!active || event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        start.current = toPage(event)
        setMarquee(dragBox(start.current, start.current))
      }}
      onPointerMove={(event) => {
        if (start.current) setMarquee(dragBox(start.current, toPage(event)))
      }}
      onPointerUp={(event) => {
        if (!start.current) return
        const box = dragBox(start.current, toPage(event))
        start.current = null
        setMarquee(null)
        onSelect(anchorsInBox(anchors, box, page))
      }}
      onPointerCancel={() => {
        start.current = null
        setMarquee(null)
      }}
    >
      {markerStrokes(anchors, selected, page).map((box, index) => (
        <rect key={index} className="marker" rx={1} {...box} />
      ))}
      {anchors.map(
        (anchor, index) =>
          anchor.page === page &&
          anchor.kind === 'NoteHead' &&
          sounding.has(anchorKey(anchor)) && (
            <rect
              key={`sounding-${index}`}
              className="sounding"
              rx={0.6}
              x={anchor.x - 0.5}
              y={anchor.y - 0.5}
              width={anchor.width + 1}
              height={anchor.height + 1}
            />
          ),
      )}
      {marquee && <rect className="marquee" {...marquee} />}
    </svg>
  )
}

/** Model reasoning: tails the latest lines while streaming, folds away once done, expandable in full. */
function Thinking({ text, live }: { text: string; live: boolean }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="thinking">
      <button
        type="button"
        className="thinking-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <Brain size={12} />
        {live ? 'Thinking…' : 'Thought process'}
        {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
      </button>
      {(expanded || live) && (
        <div className={`thinking-text ${expanded ? '' : 'tail'}`}>
          <div>{text}</div>
        </div>
      )}
    </div>
  )
}

type DockSize = NonNullable<Settings['dock']>

/** Gap between pages shown side by side, in pixels; matches `.page-spread`. */
const SPREAD_GAP = 24

/** The stage corner nearest to a point, which is where a dragged dock settles. */
function nearestCorner(x: number, y: number, stage: DOMRect): DockCorner {
  const vertical = y < stage.top + stage.height / 2 ? 'top' : 'bottom'
  const horizontal = x < stage.left + stage.width / 2 ? 'left' : 'right'
  return `${vertical}-${horizontal}`
}

/**
 * Screen directions in which dragging the resize grip grows the dock: the grip
 * sits on the corner facing away from the one the dock is pinned to.
 */
function growth(corner: DockCorner) {
  return {
    x: corner.endsWith('right') ? -1 : 1,
    y: corner.startsWith('bottom') ? -1 : 1,
  }
}

/** Keeps the dock within the stage, leaving room for its heading and composer. */
function clampDock(size: DockSize, stage: DOMRect): DockSize {
  return {
    width: Math.round(Math.max(300, Math.min(size.width, stage.width - 16))),
    height: Math.round(
      Math.max(120, Math.min(size.height, stage.height - 190)),
    ),
  }
}

function SettingsDialog({ close }: { close: () => void }) {
  const [settings, setSettings] = useAtom(settingsAtom)
  const [draft, setDraft] = useState<Settings>(settings)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    dialog.current?.showModal()
  }, [])
  return (
    <dialog
      ref={dialog}
      onCancel={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          setSettings({
            ...draft,
            apiKey: draft.apiKey.trim(),
            model: draft.model.trim() || defaults.model,
          })
          close()
        }}
      >
        <div className="dialog-heading">
          <div>
            <span className="eyebrow">YOUR WORKSPACE</span>
            <h2>Settings</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={close}
            aria-label="Close settings"
          >
            <X size={20} />
          </button>
        </div>
        <label htmlFor="api-key">OpenRouter API key</label>
        <input
          id="api-key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={draft.apiKey}
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
          placeholder="sk-or-v1-…"
        />
        <p className="field-help">
          Stored in this browser’s local storage. Your key is sent only to
          OpenRouter to authenticate requests. Use a key with a spending limit
          on shared devices.
        </p>
        <label htmlFor="model">Model</label>
        <input
          id="model"
          value={draft.model}
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
          placeholder="openrouter/auto"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="field-help">
          Enter an{' '}
          <a
            href="https://openrouter.ai/models"
            target="_blank"
            rel="noreferrer"
          >
            OpenRouter model ID
          </a>{' '}
          that supports tool calling. The default lets OpenRouter choose.
        </p>
        <label htmlFor="reasoning">Thinking</label>
        <select
          id="reasoning"
          value={draft.reasoning ?? 'default'}
          onChange={(e) => {
            const { reasoning: _, ...rest } = draft
            const effort = reasoningEfforts.find(
              (level) => level === e.target.value,
            )
            setDraft(effort ? { ...rest, reasoning: effort } : rest)
          }}
        >
          <option value="default">Model default</option>
          <option value="none">Off</option>
          <option value="minimal">On · minimal effort</option>
          <option value="low">On · low effort</option>
          <option value="medium">On · medium effort</option>
          <option value="high">On · high effort</option>
          <option value="xhigh">On · extra high effort</option>
          <option value="max">On · maximum effort</option>
        </select>
        <p className="field-help">
          Lets reasoning models think before answering; their thinking shows in
          the chat. Higher effort is slower and uses more tokens. Models without
          reasoning support ignore this, and some only offer a subset of levels.
        </p>
        <label htmlFor="pages">Sheet music pages</label>
        <select
          id="pages"
          value={draft.pages ?? 'image'}
          onChange={(e) =>
            setDraft({
              ...draft,
              pages: e.target.value === 'inline' ? 'inline' : 'image',
            })
          }
        >
          <option value="image">Image (default)</option>
          <option value="inline">Inline SVG (inspectable)</option>
        </select>
        <p className="field-help">
          Inline SVG puts the rendered page markup in the document so you can
          inspect systems and glyphs with browser developer tools. Scripts and
          links are stripped from the markup.
        </p>
        <div className="privacy-note">
          <div className="status-dot" />
          <p>
            Music rendering and agent tools run in your browser. Sending a chat
            shares the conversation and current LilyPond source with OpenRouter
            and your selected model provider.
          </p>
        </div>
        <div className="dialog-actions">
          <button
            className="quiet-button"
            type="button"
            onClick={() => setDraft({ ...draft, apiKey: '' })}
          >
            Clear key
          </button>
          <button className="primary-button" type="submit">
            <Check size={16} /> Save settings
          </button>
        </div>
      </form>
    </dialog>
  )
}

export function App() {
  const [settings, setSettings] = useAtom(settingsAtom)
  const [source, setSource] = useAtom(sourceAtom)
  const [messages, setMessages] = useAtom(messagesAtom)
  const storageError = useAtomValue(storageErrorAtom)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(true)
  const [rendered, setRendered] = useState<RenderResult>({
    pages: [],
    errors: [],
    positions: [],
    anchors: [],
  })
  const [highlighting, setHighlighting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [rendering, setRendering] = useState(true)
  // An error position the source editor should select, from the error panel.
  const [reveal, setReveal] = useState<SourcePosition | null>(null)
  // The editor loads with the first visit to the LilyPond tab and then stays.
  const [sourceOpened, setSourceOpened] = useState(settings.view === 'source')
  if (settings.view === 'source' && !sourceOpened) setSourceOpened(true)
  // Only for the visit it was requested for; reopening the source keeps its place.
  useEffect(() => {
    if (settings.view !== 'source') setReveal(null)
  }, [settings.view])
  const [renderedSource, setRenderedSource] = useState('')
  const [zoom, setZoom] = useState(85)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [agentStatus, setAgentStatus] = useState('')
  const [error, setError] = useState('')
  const [undo, setUndo] = useState<string[]>([])
  const [redo, setRedo] = useState<string[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const chatInput = useRef<HTMLTextAreaElement>(null)
  const chatLog = useRef<HTMLDivElement>(null)
  // Follow streaming output only while the reader is at the bottom of the conversation.
  const followChat = useRef(true)
  const dockRef = useRef<HTMLElement>(null)
  const [dockSize, setDockSize] = useState(settings.dock)
  const corner = settings.corner ?? 'bottom-right'
  // Where the dock follows the pointer while it is dragged to another corner.
  const [dockDrag, setDockDrag] = useState<{ x: number; y: number } | null>(
    null,
  )
  const dockDragged = useRef(false)
  // A hidden assistant keeps working; its handle signals replies that arrive meanwhile.
  const [chatHidden, setChatHidden] = useState(false)
  const [unread, setUnread] = useState(false)
  const canvas = useRef<HTMLDivElement>(null)
  // The page in view, and how many pages fit side by side.
  const [page, setPage] = useState(0)
  const [spread, setSpread] = useState(1)
  const abortRef = useRef<AbortController | null>(null)
  const title =
    source.match(/\btitle\s*=\s*"([^"\n]*)"/)?.[1] || 'Untitled score'
  const fresh =
    source === renderedSource && !rendering && !rendered.errors.length
  const playback = usePlayback(source)
  // Marked in the source editor: the render's errors once it has finished, and
  // a playback error, which can point at music the renderer accepted.
  const editorErrors = useMemo(() => {
    const errors = rendering ? [] : [...rendered.errors]
    const positions = rendering ? [] : [...rendered.positions]
    if (playback.error) {
      errors.push(playback.error)
      positions.push(playback.errorPosition)
    }
    return { errors, positions }
  }, [rendering, rendered, playback.error, playback.errorPosition])
  const pageCount = rendered.pages.length
  const firstPage =
    Math.floor(Math.min(page, Math.max(0, pageCount - 1)) / spread) * spread
  const shownPages = rendered.pages
    .map((svg, index) => ({ svg, index }))
    .slice(firstPage, firstPage + spread)
  const pageWidth = zoom * 8.6

  useEffect(() => {
    const controller = new AbortController()
    setRendering(true)
    // Highlights are keyed by source position, so any change to the source invalidates them.
    setSelected(new Set())
    const timer = setTimeout(() => {
      renderScore(source, controller.signal)
        .then((result) => {
          if (controller.signal.aborted) return
          setRendered(result)
          setRenderedSource(source)
          setRendering(false)
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setRendered({
              pages: [],
              errors: ['Rendering failed. Please try again.'],
              positions: [null],
              anchors: [],
            })
            setRendering(false)
          }
        })
    }, 350)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [source])
  useEffect(() => {
    const log = chatLog.current
    if (log && followChat.current) log.scrollTop = log.scrollHeight
  }, [messages, busy, agentStatus, chatOpen, dockSize])
  useEffect(() => () => abortRef.current?.abort(), [])
  useEffect(() => {
    if (chatHidden) setUnread(true)
  }, [messages, error])
  // Show two pages side by side whenever both fit at the current zoom.
  useEffect(() => {
    const element = canvas.current
    if (!element) return
    const measure = () => {
      // Hidden behind the LilyPond tab; keep the spread (and the reader's place).
      if (!element.clientWidth) return
      const style = getComputedStyle(element)
      const room =
        element.clientWidth -
        parseFloat(style.paddingLeft) -
        parseFloat(style.paddingRight)
      setSpread(room >= pageWidth * 2 + SPREAD_GAP ? 2 : 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [pageWidth])
  useEffect(() => {
    canvas.current?.scrollTo({ top: 0 })
  }, [firstPage])
  // Arrow and page keys turn the pages, unless the reader is typing.
  useEffect(() => {
    if (settings.view !== 'score') return
    const turn = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement
      if (
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        target.closest('input, textarea, select, dialog, [role="separator"]')
      )
        return
      const step = {
        ArrowLeft: -1,
        PageUp: -1,
        ArrowRight: 1,
        PageDown: 1,
      }[event.key]
      if (!step) return
      event.preventDefault()
      turnPage(step)
    }
    window.addEventListener('keydown', turn)
    return () => window.removeEventListener('keydown', turn)
  })
  // Turn to the page that is playing.
  useEffect(() => {
    const anchor = rendered.anchors.find(
      (anchor) =>
        anchor.kind === 'NoteHead' && playback.sounding.has(anchorKey(anchor)),
    )
    if (
      anchor &&
      (anchor.page < firstPage || anchor.page >= firstPage + spread)
    )
      setPage(anchor.page)
  }, [playback.sounding])
  // Keep the sounding notes in view as playback moves down the page.
  useEffect(() => {
    const note = document.querySelector('.page-overlay .sounding')
    const canvas = note?.closest('.score-canvas')
    if (!note || !canvas) return
    const box = note.getBoundingClientRect()
    const view = canvas.getBoundingClientRect()
    if (box.top < view.top + 40 || box.bottom > view.bottom - 40)
      note.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [playback.sounding, firstPage])

  function turnPage(step: number) {
    const next = firstPage + step * spread
    if (next >= 0 && next < pageCount) setPage(next)
  }

  function replaceScore(next: string) {
    const current = registry.get(sourceAtom)
    if (current === next) return
    setUndo((values) => [...values.slice(-19), current])
    setRedo([])
    setSource(next)
  }
  // Moves the top of one history stack into the score and the current score onto the other.
  function travel(
    from: string[],
    setFrom: typeof setUndo,
    setTo: typeof setUndo,
  ) {
    const target = from.at(-1)
    if (target === undefined) return
    // Read the atom now: React runs updater callbacks later, after setSource has changed it.
    const current = registry.get(sourceAtom)
    setTo((values) => [...values.slice(-19), current])
    setFrom(from.slice(0, -1))
    setSource(target)
  }

  // A swipe over notes that are all highlighted already lifts the marker instead.
  function toggleSelection(anchors: Anchor[]) {
    if (!anchors.length) return
    const keys = anchors.map(anchorKey)
    setSelected((current) => {
      const next = new Set(current)
      if (keys.every((key) => current.has(key)))
        for (const key of keys) next.delete(key)
      else for (const key of keys) next.add(key)
      return next
    })
  }
  const inlinePages = useMemo(
    () => (settings.pages === 'inline' ? rendered.pages.map(sanitizeSvg) : []),
    [rendered.pages, settings.pages],
  )
  const highlightedNotes = selected.size
    ? selectedNotes(rendered.anchors, selected, source)
    : []

  function resizeDock(size: DockSize) {
    const stage = dockRef.current?.parentElement?.getBoundingClientRect()
    if (stage) setDockSize(clampDock(size, stage))
  }
  function saveDockSize(size: DockSize | undefined) {
    const { dock: _, ...rest } = registry.get(settingsAtom)
    setSettings(size ? { ...rest, dock: size } : rest)
  }
  // The grip faces away from the dock's corner, so dragging it outwards grows the dock.
  function startDockResize(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !dockRef.current) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const start = {
      x: event.clientX,
      y: event.clientY,
      width: dockRef.current.getBoundingClientRect().width,
      height:
        chatLog.current?.getBoundingClientRect().height ??
        dockSize?.height ??
        240,
    }
    let size = dockSize
    const grow = growth(corner)
    const move = (moved: PointerEvent) => {
      const stage = dockRef.current?.parentElement?.getBoundingClientRect()
      if (!stage) return
      size = clampDock(
        {
          width: start.width + grow.x * (moved.clientX - start.x),
          height: start.height + grow.y * (moved.clientY - start.y),
        },
        stage,
      )
      setDockSize(size)
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      saveDockSize(size)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  /**
   * Drags the dock by its heading; on release it settles in the corner nearest
   * the pointer. A press without movement stays a click on the heading.
   */
  function startDockDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !dockRef.current) return
    if ((event.target as HTMLElement).closest('.icon-button')) return
    const start = { x: event.clientX, y: event.clientY }
    dockDragged.current = false
    // The dock trails the pointer, so follow it on the window rather than the heading.
    const move = (moved: PointerEvent) => {
      const offset = { x: moved.clientX - start.x, y: moved.clientY - start.y }
      if (!dockDragged.current && Math.hypot(offset.x, offset.y) < 6) return
      dockDragged.current = true
      setDockDrag(offset)
    }
    const end = (ended: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
      setDockDrag(null)
      // Clear the flag once the click that ends the drag has been ignored.
      setTimeout(() => (dockDragged.current = false))
      const stage = dockRef.current?.parentElement?.getBoundingClientRect()
      if (!dockDragged.current || !stage) return
      const next = nearestCorner(ended.clientX, ended.clientY, stage)
      setSettings({ ...registry.get(settingsAtom), corner: next })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  async function send(event?: React.FormEvent) {
    event?.preventDefault()
    if (!input.trim() || busy) return
    if (!settings.apiKey.trim()) {
      setSettingsOpen(true)
      return
    }
    const next: readonly Message[] = [
      ...messages,
      {
        id: crypto.randomUUID(),
        role: 'user',
        text: input.trim(),
        ...(highlightedNotes.length ? { selection: highlightedNotes } : {}),
      },
    ]
    setMessages(next)
    setInput('')
    setError('')
    setBusy(true)
    setChatOpen(true)
    followChat.current = true
    const controller = new AbortController()
    abortRef.current = controller
    const assistantId = crypto.randomUUID()
    const append = (type: MessagePart['type']) => (chunk: string) =>
      setMessages((current) =>
        current.some((message) => message.id === assistantId)
          ? current.map((message) =>
              message.id === assistantId
                ? appendChunk(message, type, chunk)
                : message,
            )
          : [
              ...current,
              appendChunk(
                { id: assistantId, role: 'assistant', text: '' },
                type,
                chunk,
              ),
            ],
      )
    try {
      const { runAgent } = await import('./harness/agent')
      await runAgent({
        settings,
        messages: next,
        signal: controller.signal,
        getSource: () => registry.get(sourceAtom),
        updateSource: replaceScore,
        onStatus: setAgentStatus,
        onText: append('text'),
        onThinking: append('thinking'),
      })
    } catch (cause) {
      // Provider errors can contain request details; never surface or log the API key.
      console.error(
        'Assistant request failed:',
        String(cause).replaceAll(settings.apiKey, '[redacted]'),
      )
      setError(
        controller.signal.aborted
          ? 'Stopped. Any completed score edits are still available to undo.'
          : 'The assistant could not complete the request. Check your API key, model’s tool support, OpenRouter credits, and connection, then try again.',
      )
    } finally {
      setBusy(false)
      setAgentStatus('')
      abortRef.current = null
      chatInput.current?.focus()
    }
  }

  return (
    <div className="app-shell">
      <header className="toolbar">
        <div className="toolbar-group toolbar-left">
          <a className="brand" href="./" aria-label="Score Chat home">
            <span className="brand-icon">
              <Music2 size={18} />
            </span>
            <span className="brand-name">
              score<span className="brand-light">chat</span>
            </span>
          </a>
          <span className="toolbar-divider" />
          <div className="score-title">
            <h1 title={title}>{title}</h1>
            <span className="score-status" aria-live="polite">
              {rendering ? (
                <>
                  <LoaderCircle size={11} className="spin" /> Rendering…
                </>
              ) : rendered.errors.length ? (
                <span className="status-bad">Could not render this source</span>
              ) : playback.error ? (
                <span className="status-bad" title={playback.error}>
                  Could not play: {playback.error}
                </span>
              ) : (
                <>
                  <Check size={11} /> {rendered.pages.length} page
                  {rendered.pages.length === 1 ? '' : 's'} · rendered locally
                </>
              )}
            </span>
          </div>
        </div>
        <div className="tabs" role="tablist" aria-label="Score view">
          <button
            id="score-tab"
            role="tab"
            aria-label="Sheet music"
            aria-selected={settings.view === 'score'}
            aria-controls="score-panel"
            onClick={() => setSettings({ ...settings, view: 'score' })}
          >
            <Music2 size={15} />
            <span>Sheet music</span>
          </button>
          <button
            id="source-tab"
            role="tab"
            aria-label="LilyPond"
            aria-selected={settings.view === 'source'}
            aria-controls="source-panel"
            onClick={() => setSettings({ ...settings, view: 'source' })}
          >
            <Code2 size={15} />
            <span>LilyPond</span>
          </button>
        </div>
        <div className="toolbar-group toolbar-right">
          <button
            className="icon-button"
            title="Undo last score replacement"
            aria-label="Undo last score replacement"
            disabled={busy || !undo.length}
            onClick={() => travel(undo, setUndo, setRedo)}
          >
            <Undo2 size={16} />
          </button>
          <button
            className="icon-button"
            title="Redo score replacement"
            aria-label="Redo score replacement"
            disabled={busy || !redo.length}
            onClick={() => travel(redo, setRedo, setUndo)}
          >
            <Redo2 size={16} />
          </button>
          <span className="toolbar-divider" />
          <button
            className={`icon-button ${playback.state === 'playing' ? 'playing' : ''}`}
            title={playback.state === 'playing' ? 'Pause' : 'Play'}
            aria-label={playback.state === 'playing' ? 'Pause' : 'Play'}
            disabled={!fresh && playback.state === 'stopped'}
            onClick={playback.toggle}
          >
            {playback.state === 'loading' ? (
              <LoaderCircle size={16} className="spin" />
            ) : playback.state === 'playing' ? (
              <Pause size={16} />
            ) : (
              <Play size={16} />
            )}
          </button>
          <button
            className="icon-button"
            title="Back to the start"
            aria-label="Back to the start"
            disabled={playback.state === 'stopped'}
            onClick={playback.stop}
          >
            <SkipBack size={16} />
          </button>
          {settings.view === 'score' && (
            <button
              className={`icon-button ${highlighting ? 'active' : ''}`}
              title="Highlight notes for the assistant"
              aria-label="Highlight notes for the assistant"
              aria-pressed={highlighting}
              onClick={() => setHighlighting(!highlighting)}
            >
              <Highlighter size={16} />
            </button>
          )}
          {settings.view === 'score' && (
            <div className="page-controls">
              <button
                className="icon-button"
                title="Previous page"
                aria-label="Previous page"
                disabled={firstPage === 0}
                onClick={() => turnPage(-1)}
              >
                <ChevronLeft size={16} />
              </button>
              <span className="page-label" aria-live="polite">
                {pageCount
                  ? `${firstPage + 1}${shownPages.length > 1 ? `–${firstPage + shownPages.length}` : ''} / ${pageCount}`
                  : '–'}
              </span>
              <button
                className="icon-button"
                title="Next page"
                aria-label="Next page"
                disabled={firstPage + spread >= pageCount}
                onClick={() => turnPage(1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
          {settings.view === 'score' && (
            <div className="zoom-controls">
              <button
                className="icon-button"
                aria-label="Zoom out"
                disabled={zoom <= 45}
                onClick={() => setZoom(Math.max(45, zoom - 10))}
              >
                <ZoomOut size={16} />
              </button>
              <span className="zoom-label">{zoom}%</span>
              <button
                className="icon-button"
                aria-label="Zoom in"
                disabled={zoom >= 145}
                onClick={() => setZoom(Math.min(145, zoom + 10))}
              >
                <ZoomIn size={16} />
              </button>
            </div>
          )}
          <span className="toolbar-divider" />
          <button
            className="icon-button"
            title="Open .ly"
            aria-label="Open .ly"
            disabled={busy}
            onClick={() => fileInput.current?.click()}
          >
            <FileUp size={16} />
          </button>
          <button
            className="icon-button"
            title="Download .ly"
            aria-label="Download .ly"
            onClick={() => download('score.ly', source, 'text/plain')}
          >
            <ArrowDownToLine size={16} />
          </button>
          <span className="toolbar-divider" />
          <button
            className="icon-button"
            title="Settings"
            aria-label="Settings"
            onClick={() => setSettingsOpen(true)}
            disabled={busy}
          >
            <Settings2 size={16} />
          </button>
        </div>
      </header>
      <input
        ref={fileInput}
        type="file"
        accept=".ly,text/plain"
        className="visually-hidden"
        aria-label="Import LilyPond file"
        onChange={async (event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          if (file.size > MAX_SOURCE_LENGTH) {
            setError('Choose a LilyPond file smaller than 150 KB.')
            setChatOpen(true)
            return
          }
          try {
            const contents = await file.text()
            replaceScore(contents)
            setError('')
          } catch {
            setError('Could not read this file.')
            setChatOpen(true)
          }
        }}
      />
      <main
        className="stage"
        data-chat={chatHidden ? 'hidden' : chatOpen ? 'open' : 'closed'}
        data-corner={corner}
        aria-label="Music workspace"
        style={
          dockSize
            ? ({ '--dock-width': `${dockSize.width}px` } as React.CSSProperties)
            : undefined
        }
      >
        {storageError && (
          <div className="storage-warning" role="alert">
            {storageError}
          </div>
        )}
        {rendered.errors.length > 0 && !rendering && (
          <div className="render-errors" role="alert">
            {rendered.errors.map((message, index) => {
              const position = rendered.positions[index]
              return (
                <div key={index}>
                  {position && (
                    <button
                      className="error-position"
                      title="Show in the LilyPond source"
                      onClick={() => {
                        setReveal({ ...position })
                        setSettings({ ...settings, view: 'source' })
                      }}
                    >
                      Line {position.line}, column {position.column}
                    </button>
                  )}
                  {errorMessage(message)}
                </div>
              )
            })}
          </div>
        )}
        {/* Both views stay mounted once opened, so switching keeps each one's
            scroll position (and the editor's selection and history). */}
        {sourceOpened && (
          <div
            id="source-panel"
            role="tabpanel"
            aria-labelledby="source-tab"
            className="source-panel"
            hidden={settings.view !== 'source'}
          >
            <Suspense
              fallback={<div className="source-loading">Loading editor…</div>}
            >
              <SourceEditor
                value={source}
                readOnly={busy}
                errors={editorErrors.errors}
                positions={editorErrors.positions}
                reveal={reveal}
                maxLength={MAX_SOURCE_LENGTH}
                onChange={(next) => {
                  // Typing after an undo starts a new branch; the undone replacement is no longer redoable.
                  if (redo.length) setRedo([])
                  setSource(next)
                }}
              />
            </Suspense>
          </div>
        )}
        <div
          id="score-panel"
          role="tabpanel"
          aria-labelledby="score-tab"
          ref={canvas}
          className="score-canvas"
          aria-busy={rendering}
          hidden={settings.view !== 'score'}
        >
          {rendering && !rendered.pages.length && (
            <div className="empty-score">
              <LoaderCircle className="spin" size={24} />
              <p>Engraving your music…</p>
            </div>
          )}
          {shownPages.length > 0 && (
            <div className="page-spread">
              {shownPages.map(({ svg: page, index }) => (
                <div
                  key={index}
                  className={`sheet-page ${fresh ? '' : 'stale'}`}
                  style={{
                    width:
                      spread > 1
                        ? `${pageWidth}px`
                        : `min(${pageWidth}px, ${(zoom / 85) * 100}%)`,
                  }}
                >
                  {settings.pages === 'inline' ? (
                    <div
                      className="sheet-svg"
                      role="img"
                      aria-label={`Sheet music, page ${index + 1}`}
                      dangerouslySetInnerHTML={{ __html: inlinePages[index] }}
                    />
                  ) : (
                    <img
                      alt={`Sheet music, page ${index + 1}`}
                      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(page)}`}
                    />
                  )}
                  <PageOverlay
                    page={index}
                    viewBox={page.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 1 1'}
                    anchors={rendered.anchors}
                    selected={selected}
                    sounding={playback.sounding}
                    active={highlighting && fresh}
                    onSelect={toggleSelection}
                  />
                </div>
              ))}
            </div>
          )}
          {!rendering && !rendered.pages.length && (
            <div className="empty-score">
              <FileMusic size={32} />
              <p>This score needs a little attention.</p>
              <button
                className="outlined-button"
                onClick={() => setSettings({ ...settings, view: 'source' })}
              >
                Edit LilyPond source
              </button>
            </div>
          )}
        </div>
        <section
          ref={dockRef}
          className="chat-dock"
          aria-label="Music assistant"
          data-open={chatOpen}
          data-corner={corner}
          data-sized={dockSize ? true : undefined}
          data-dragging={dockDrag ? true : undefined}
          hidden={chatHidden}
          style={
            {
              ...(dockSize && { '--chat-height': `${dockSize.height}px` }),
              ...(dockDrag && {
                transform: `translate(${dockDrag.x}px, ${dockDrag.y}px)`,
              }),
            } as React.CSSProperties
          }
        >
          {chatOpen && (
            <div
              className="dock-resize"
              role="separator"
              tabIndex={0}
              aria-label="Resize assistant (double-click to reset)"
              title="Drag to resize · double-click to reset"
              onPointerDown={startDockResize}
              onDoubleClick={() => {
                setDockSize(undefined)
                saveDockSize(undefined)
              }}
              onKeyDown={(event) => {
                const step = event.shiftKey ? 60 : 20
                const delta = {
                  ArrowLeft: [-step, 0],
                  ArrowRight: [step, 0],
                  ArrowUp: [0, -step],
                  ArrowDown: [0, step],
                }[event.key]
                if (!delta || !dockRef.current) return
                event.preventDefault()
                const grow = growth(corner)
                const stage =
                  dockRef.current.parentElement!.getBoundingClientRect()
                const size = clampDock(
                  {
                    width:
                      dockRef.current.getBoundingClientRect().width +
                      grow.x * delta[0],
                    height:
                      (chatLog.current?.getBoundingClientRect().height ??
                        dockSize?.height ??
                        240) +
                      grow.y * delta[1],
                  },
                  stage,
                )
                setDockSize(size)
                saveDockSize(size)
              }}
            />
          )}
          <div
            className="chat-heading"
            title="Drag to move the assistant to another corner"
            onPointerDown={startDockDrag}
          >
            <button
              type="button"
              className="chat-toggle"
              aria-expanded={chatOpen}
              aria-controls="chat-conversation"
              onClick={() => {
                // The click that ends a drag is not a toggle.
                if (!dockDragged.current) setChatOpen(!chatOpen)
              }}
            >
              <span className="assistant-icon">
                <Sparkles size={14} />
              </span>
              <h2>Assistant</h2>
              {busy && (
                <span className="chat-subtitle">
                  <LoaderCircle size={11} className="spin" />
                  {agentStatus || 'Connecting…'}
                </span>
              )}
              {chatOpen ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
            {chatOpen && (
              <button
                className="icon-button"
                title="Clear chat"
                aria-label="Clear chat"
                disabled={busy || !messages.length}
                onClick={() => {
                  setMessages([])
                  setError('')
                }}
              >
                <Trash2 size={15} />
              </button>
            )}
            <button
              className="icon-button"
              title="Hide assistant (it keeps working)"
              aria-label="Hide assistant"
              onClick={() => {
                setUnread(false)
                setChatHidden(true)
              }}
            >
              <Minus size={15} />
            </button>
          </div>
          {chatOpen && (messages.length > 0 || dockSize) && (
            <div
              ref={chatLog}
              id="chat-conversation"
              className="chat-messages"
              role="log"
              aria-label="Conversation"
              aria-live="polite"
              onScroll={(event) => {
                const log = event.currentTarget
                followChat.current =
                  log.scrollHeight - log.scrollTop - log.clientHeight < 40
              }}
            >
              {messages.map((message, messageIndex) => (
                <div key={message.id} className={`message ${message.role}`}>
                  <span className="message-author">
                    {message.role === 'assistant' ? (
                      <Sparkles size={14} />
                    ) : (
                      <MessageSquare size={14} />
                    )}
                    {message.role === 'assistant' ? 'Assistant' : 'You'}
                  </span>
                  {message.role === 'assistant' ? (
                    <div className="message-body">
                      {(
                        message.parts ?? [
                          { type: 'text' as const, text: message.text },
                        ]
                      ).map((part, index, parts) =>
                        part.type === 'thinking' ? (
                          <Thinking
                            key={index}
                            text={part.text}
                            live={
                              busy &&
                              messageIndex === messages.length - 1 &&
                              index === parts.length - 1
                            }
                          />
                        ) : (
                          <Markdown key={index} remarkPlugins={[remarkGfm]}>
                            {part.text}
                          </Markdown>
                        ),
                      )}
                    </div>
                  ) : (
                    <div className="message-text">{message.text}</div>
                  )}
                  {message.selection && (
                    <div className="message-selection">
                      <Highlighter size={11} />
                      {message.selection.map((note) => note.text).join(' ')}
                    </div>
                  )}
                </div>
              ))}
              {busy && (
                <div className="agent-status">
                  <LoaderCircle size={14} className="spin" />
                  {agentStatus || 'Connecting…'}
                </div>
              )}
            </div>
          )}
          {error && (
            <div className="chat-error" role="alert">
              {error}
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError('')}
              >
                <X size={14} />
              </button>
            </div>
          )}
          <form className="chat-composer" onSubmit={send}>
            {highlightedNotes.length > 0 && (
              <div className="selection-chip" role="status">
                <Highlighter size={12} />
                <span>{summarizeSelection(highlightedNotes)} highlighted</span>
                <span className="selection-preview">
                  {highlightedNotes.map((note) => note.text).join(' ')}
                </span>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Clear highlights"
                  onClick={() => setSelected(new Set())}
                >
                  <X size={12} />
                </button>
              </div>
            )}
            <textarea
              ref={chatInput}
              aria-label="Message the music assistant"
              placeholder={
                highlightedNotes.length
                  ? 'What should change for the highlighted notes?'
                  : 'What would you like to create?'
              }
              value={input}
              disabled={busy}
              onChange={(event) => setInput(event.target.value)}
              rows={1}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  void send()
                } else if (event.key === 'Escape' && chatOpen) {
                  setChatOpen(false)
                }
              }}
            />
            <div className="composer-bottom">
              <button
                type="button"
                className="model-button"
                disabled={busy}
                onClick={() => setSettingsOpen(true)}
              >
                <SlidersHorizontal size={13} />
                {settings.apiKey ? settings.model : 'Connect OpenRouter'}
                <ChevronDown size={12} />
              </button>
              {busy ? (
                <button
                  type="button"
                  className="send-button"
                  aria-label="Stop response"
                  onClick={() => abortRef.current?.abort()}
                >
                  <Square size={15} />
                </button>
              ) : (
                <button
                  type="submit"
                  className="send-button"
                  aria-label="Send message"
                  disabled={!input.trim()}
                >
                  <ArrowUp size={19} />
                </button>
              )}
            </div>
          </form>
        </section>
        {chatHidden && (
          <button
            className="chat-handle"
            data-corner={corner}
            title="Show assistant"
            aria-label={
              busy
                ? 'Show assistant (working)'
                : unread
                  ? 'Show assistant (new messages)'
                  : 'Show assistant'
            }
            onClick={() => {
              setChatHidden(false)
              setUnread(false)
            }}
          >
            {busy ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Sparkles size={15} />
            )}
            {unread && !busy && <span className="unread-dot" />}
          </button>
        )}
      </main>
      {settingsOpen && <SettingsDialog close={() => setSettingsOpen(false)} />}
    </div>
  )
}
