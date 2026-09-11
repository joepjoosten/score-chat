import { Schema } from 'effect'
import { Atom, AtomRegistry } from 'effect/unstable/reactivity'

export const Settings = Schema.Struct({
  apiKey: Schema.String,
  model: Schema.String,
  view: Schema.Literals(['score', 'source']),
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
