import { Schema } from 'effect'
import { Atom, AtomRegistry } from 'effect/reactivity'
import type { SelectedNote } from './selection'

export const reasoningEfforts = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export const Settings = Schema.Struct({
  apiKey: Schema.String,
  model: Schema.String,
  view: Schema.Literals(['score', 'source']),
  /** How rendered pages are shown: as images (default) or inline SVG for inspection. Optional so older stored settings still decode. */
  pages: Schema.optionalKey(Schema.Literals(['image', 'inline'])),
  /** Reasoning effort sent to OpenRouter; absent leaves the choice to the model, `none` turns thinking off. */
  reasoning: Schema.optionalKey(Schema.Literals(reasoningEfforts)),
  /** Size of the assistant dock after the user resizes it, in pixels. */
  dock: Schema.optionalKey(
    Schema.Struct({ width: Schema.Number, height: Schema.Number }),
  ),
})
export type Settings = typeof Settings.Type
export const defaults: Settings = {
  apiKey: '',
  model: 'openrouter/auto',
  view: 'score',
}
export const SETTINGS_KEY = 'score-chat.settings.v1'
export const SCORE_KEY = 'score-chat.score.v1'

export const initialScore = String.raw`\version "2.24.4"
\header {
  title = "A little beginning"
  subtitle = "A melody to make your own"
  composer = "Score Chat"
  tagline = ##f
}
\score {
  \new Staff \relative c' {
    \clef treble
    \key c \major
    \time 4/4
    \tempo "Andante" 4 = 80
    c4\p e g e | f4 a g2 |
    e4 d c d | e2 g2 | \break
    a4\< g f e | d4 e f g\! |
    e4\> d c b | c1\! \bar "|."
  }
  \layout { }
}
`

export function readSettings(storage: Pick<Storage, 'getItem'>): Settings {
  try {
    const raw = storage.getItem(SETTINGS_KEY)
    return raw ? Schema.decodeUnknownSync(Settings)(JSON.parse(raw)) : defaults
  } catch {
    return defaults
  }
}

function readScore(): string {
  try {
    return localStorage.getItem(SCORE_KEY) ?? initialScore
  } catch {
    return initialScore
  }
}

export const registry = AtomRegistry.make()
export const settingsAtom = Atom.make(
  readSettings({ getItem: (key) => localStorage.getItem(key) }),
).pipe(Atom.keepAlive)
export const sourceAtom = Atom.make(readScore()).pipe(Atom.keepAlive)
export const storageErrorAtom = Atom.make('').pipe(Atom.keepAlive)
export const messagesAtom = Atom.make<readonly Message[]>([]).pipe(
  Atom.keepAlive,
)
export interface Message {
  id: string
  role: 'user' | 'assistant'
  text: string
  /** Score elements highlighted when a user message was sent. */
  selection?: SelectedNote[]
  /** Assistant output in arrival order; `text` holds only the reply text sent back as history. */
  parts?: MessagePart[]
}
export interface MessagePart {
  type: 'text' | 'thinking'
  text: string
}

/** Appends a streamed chunk to an assistant message, starting a new part when the kind changes. */
export function appendChunk(
  message: Message,
  type: MessagePart['type'],
  chunk: string,
): Message {
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

const storageErrors = new Set<string>()
function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
    storageErrors.delete(key)
  } catch {
    storageErrors.add(key)
  }
  registry.set(
    storageErrorAtom,
    storageErrors.size
      ? 'Browser storage is unavailable or full. Changes will only last for this session.'
      : '',
  )
}
registry.subscribe(settingsAtom, (value) =>
  persist(SETTINGS_KEY, JSON.stringify(value)),
)
registry.subscribe(sourceAtom, (value) => persist(SCORE_KEY, value))
