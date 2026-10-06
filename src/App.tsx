import { useEffect, useMemo, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useAtom, useAtomValue } from '@effect/atom-react'
import {
  ArrowDownToLine,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Code2,
  FileMusic,
  FileUp,
  Highlighter,
  LoaderCircle,
  MessageSquare,
  Music2,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  Redo2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import {
  defaults,
  messagesAtom,
  registry,
  settingsAtom,
  sourceAtom,
  storageErrorAtom,
} from './state'
import type { Message, Settings } from './state'
import { MAX_SOURCE_LENGTH, renderScore } from './renderer'
import type { RenderResult } from './renderer'
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
  active,
  onSelect,
}: {
  page: number
  viewBox: string
  anchors: readonly Anchor[]
  selected: ReadonlySet<string>
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
      {marquee && <rect className="marquee" {...marquee} />}
    </svg>
  )
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
    anchors: [],
  })
  const [highlighting, setHighlighting] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [rendering, setRendering] = useState(true)
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
  const chatEnd = useRef<HTMLDivElement>(null)
  const editorGutter = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const title =
    source.match(/\btitle\s*=\s*"([^"\n]*)"/)?.[1] || 'Untitled score'
  const fresh =
    source === renderedSource && !rendering && !rendered.errors.length

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
    chatEnd.current?.scrollIntoView({ block: 'nearest' })
  }, [messages, busy, agentStatus])
  useEffect(() => () => abortRef.current?.abort(), [])

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
    const controller = new AbortController()
    abortRef.current = controller
    const assistantId = crypto.randomUUID()
    try {
      const { runAgent } = await import('./agent')
      await runAgent({
        settings,
        messages: next,
        signal: controller.signal,
        getSource: () => registry.get(sourceAtom),
        updateSource: replaceScore,
        onStatus: setAgentStatus,
        onText: (text) =>
          setMessages((current) => {
            const existing = current.find(
              (message) => message.id === assistantId,
            )
            return existing
              ? current.map((message) =>
                  message.id === assistantId
                    ? { ...message, text: message.text + text }
                    : message,
                )
              : [...current, { id: assistantId, role: 'assistant', text }]
          }),
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
        data-chat={chatOpen ? 'open' : 'closed'}
        aria-label="Music workspace"
      >
        {storageError && (
          <div className="storage-warning" role="alert">
            {storageError}
          </div>
        )}
        {rendered.errors.length > 0 && !rendering && (
          <div className="render-errors" role="alert">
            {rendered.errors.map((message, index) => (
              <div key={index}>{message}</div>
            ))}
          </div>
        )}
        {settings.view === 'source' ? (
          <div
            id="source-panel"
            role="tabpanel"
            aria-labelledby="source-tab"
            className="source-panel"
          >
            <div
              ref={editorGutter}
              className="editor-gutter"
              aria-hidden="true"
            >
              {source.split('\n').map((_, index) => (
                <div key={index}>{index + 1}</div>
              ))}
            </div>
            <textarea
              aria-label="LilyPond source"
              className="source-editor"
              onScroll={(event) => {
                if (editorGutter.current)
                  editorGutter.current.scrollTop = event.currentTarget.scrollTop
              }}
              spellCheck={false}
              value={source}
              readOnly={busy}
              maxLength={MAX_SOURCE_LENGTH}
              onChange={(e) => {
                // Typing after an undo starts a new branch; the undone replacement is no longer redoable.
                if (redo.length) setRedo([])
                setSource(e.target.value)
              }}
            />
          </div>
        ) : (
          <div
            id="score-panel"
            role="tabpanel"
            aria-labelledby="score-tab"
            className="score-canvas"
            aria-busy={rendering}
          >
            {rendering && !rendered.pages.length && (
              <div className="empty-score">
                <LoaderCircle className="spin" size={24} />
                <p>Engraving your music…</p>
              </div>
            )}
            {rendered.pages.map((page, index) => (
              <div
                key={index}
                className={`sheet-page ${fresh ? '' : 'stale'}`}
                style={{
                  width: `min(${zoom * 8.6}px, ${(zoom / 85) * 100}%)`,
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
                  active={highlighting && fresh}
                  onSelect={toggleSelection}
                />
                <button
                  className="page-download"
                  disabled={!fresh}
                  onClick={() =>
                    download(`score-${index + 1}.svg`, page, 'image/svg+xml')
                  }
                >
                  <ArrowDownToLine size={14} /> SVG · page {index + 1}
                </button>
              </div>
            ))}
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
        )}
        <section
          className="chat-dock"
          aria-label="Music assistant"
          data-open={chatOpen}
        >
          <div className="chat-heading">
            <button
              type="button"
              className="chat-toggle"
              aria-expanded={chatOpen}
              aria-controls="chat-conversation"
              onClick={() => setChatOpen(!chatOpen)}
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
          </div>
          {chatOpen && messages.length > 0 && (
            <div
              id="chat-conversation"
              className="chat-messages"
              role="log"
              aria-label="Conversation"
              aria-live="polite"
            >
              {messages.map((message) => (
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
                      <Markdown remarkPlugins={[remarkGfm]}>
                        {message.text}
                      </Markdown>
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
              <div ref={chatEnd} />
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
      </main>
      {settingsOpen && <SettingsDialog close={() => setSettingsOpen(false)} />}
    </div>
  )
}
