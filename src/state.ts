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
export const dockCorners = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
] as const
export type DockCorner = (typeof dockCorners)[number]
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
  /** Corner of the stage the assistant dock is pinned to; bottom right when absent. */
  corner: Schema.optionalKey(Schema.Literals(dockCorners)),
})
export type Settings = typeof Settings.Type
export const defaults: Settings = {
  apiKey: '',
  model: 'openrouter/auto',
  view: 'score',
}
export const SETTINGS_KEY = 'score-chat.settings.v1'
export const SCORE_KEY = 'score-chat.score.v1'

// An original lead sheet in the LilyJAZZ style. Its fonts and stylesheets load
// just in time from public/renderer/fonts/lilyjazz.
export const initialScore = String.raw`\version "2.24.4"

% A lead sheet in the LilyJAZZ style: hand-written music and chord fonts
% from the lilyjazz.ily and jazzchords.ily stylesheets.
\include "lilyjazz.ily"
\include "jazzchords.ily"

\header {
  title = "Late Light"
  subtitle = "Medium swing"
  composer = "Score Chat"
  tagline = ##f
}

harmony = \chordmode {
  f1:maj7 | g2:m7 c:7 | a1:m7 | d:7.9- |
  g1:m7 | c:7 | f2:maj7 d:7 | g:m7 c:7 |
  bes1:maj7 | bes:m7 | a:m7 | d:7 |
  g1:m7 | c:7.9- | f1:6 | g2:m7 c:7 |
}

melody = \relative c'' {
  \clef treble
  \key f \major
  \time 4/4

  \mark \default
  r8 a8 c e~ e4 d8 c | bes4 a8 g~ g2 |
  r8 e8 g c~ c4 b8 a | fis1 | \break
  r8 g8 bes d~ d4 c8 bes | a4 g8 e~ e2 |
  r8 f8 a c d4 c8 a | g2 r2 | \break

  \mark \default
  r8 d'8 f a~ a4 g8 f | e4 des8 c~ c2 |
  r8 c8 e g~ g4 f8 e | fis2. r4 | \break
  r8 bes,8 d f~ f4 e8 d | des4 c8 bes~ bes2 |
  a4. c8~ c2 | r8 g8 a bes c2 \bar "|."
}

\score {
  <<
    \new ChordNames \harmony
    \new Staff \melody
  >>
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
