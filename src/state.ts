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

// The comprehensive alto saxophone fixture from lilypond-typescript (test/fixtures/saxophone).
export const initialScore = String.raw`\version "2.24.4"

% Comprehensive fixture constrained to notation currently owned by the V2
% TypeScript renderer. Chord symbols are silent during the compendium and
% begin at the 32-bar solo chorus.

\header {
  title = "The Complete Alto Saxophone"
  subtitle = "A Multi-Page Compendium of Notation, Color, and Improvisation"
  subsubtitle = "Comprehensive engraving fixture for E-flat alto saxophone"
  composer = "Codex Fixture Workshop"
  arranger = "Prepared for lilypond-typescript"
  opus = "Fixture Study No. 1"
  copyright = "Test fixture - freely reusable within this repository"
  tagline = ##f
}

\paper {
  % ISO A4 in millimetres. Explicit dimensions are understood by both
  % LilyPond 2.24.4 and the TypeScript renderer.
  paper-width = 210\mm
  paper-height = 297\mm
  top-margin = 12\mm
  bottom-margin = 12\mm
  left-margin = 14\mm
  right-margin = 14\mm
  indent = 35\mm
  short-indent = 10\mm
  ragged-last-bottom = ##f
  print-page-number = ##t
  print-first-page-number = ##f
  tagline = ##f
}

fluteCue = {
  s1
  g''8 a'' b'' c''' d'''4 c'''
}

\addQuote "fluteCue" \fluteCue

altoMusic = {
  \transposition es
  \clef treble
  \key d \major
  \time 4/4
  \tempo "Confidently" 4 = 112
  \mark "TECHNIQUE COMPENDIUM"

  % A - written range, cue notes, accidentals, register, rests, and text.
  fis'4\mf gis'-. a'8( b') cis''4-> |
  \cueDuring "fluteCue" #UP { \set CueVoice.instrumentCueName = "Fl." R1 } |
  \break
  c'4 cis' ces' cisis' | des' d' dis' es' |
  \break
  b,1\pp | fis''1\ff |
  \break
  \ottava #1 g''8 a'' b'' c''' d''' e''' fis''' g''' \ottava #0 |
  fis'''2^\markup { altissimo } r2 |
  \break

  % B - note values, rests, ties, tuplets, beams, and changing meters.
  \mark \default
  \tempo "Rhythm laboratory" 4 = 96
  bes1 | c'2 d'4 e' |
  \break
  \time 3/4 fis'8[ gis' a' b' cis'' d''] | e''4. d''8 cis''4 |
  \time 2/4 b'8[ a' gis' fis'] |
  \break
  \time 5/8 e'8[ fis' gis'] a'[ b'] |
  \time 7/8 cis''8[ b' a'] gis'[ fis' e' d'] |
  \break
  \time 6/8 c'4. d' | e'8.[ fis'16] gis'8 a'4. |
  \time 4/4 \tuplet 3/2 { b'8 cis'' d'' } e''4~ e''2 |
  \pageBreak

  % C - the ordinary saxophone articulation and dynamic vocabulary.
  \mark \default
  \key bes \major
  \tempo "In every shade" 4 = 80
  bes4-. c'-- d'-> es'4\marcato | f'\staccatissimo g'\portato a'-+ bes'-\open |
  \break
  c''4\pppp bes'\ppp a'\pp g'\p | f'\mp g'\mf a'\f bes'\ff |
  \break
  c''4\fff bes'\sf a'\sfz g'\rfz | f'\fp es'\sfp d'\ffff c'\fffff |
  \break
  bes1\< | c''2\f\> bes'\! |
  \break
  a'2\cresc bes'\ff | c''2\decresc d''\p |

  % D - slurs, grace notes, ornaments, trill spans, glissandi, tremolos.
  \mark \default
  es''4( d'' c'' bes') | a'4\( bes' c'' d''\) |
  \break
  \grace { fis'16[ g'] } a'2 g' |
  \acciaccatura { fis'16 } g'4 a' bes' c'' |
  \break
  \appoggiatura { a'8 } bes'2 a' |
  \afterGrace g'2 { fis'16[ g'] } d'2 |
  \break
  g'2\trill f'4\mordent es'\prall | d'2\turn c' |
  \break
  bes'2\startTrillSpan a'4 g'\stopTrillSpan |
  fis'4\glissando b'2. |
  d'2:16 es'2:32 | \repeat tremolo 8 { f'16 g' } |
  \pageBreak

  % E - saxophone-specific colors expressed with supported text and symbols.
  \mark \default
  \key c \major
  \tempo "Colors" 4 = 60
  c'2^\markup { subtone }\pp d'^\markup { senza vibrato } |
  e'2^\markup { molto vibrato } f'^\markup { growl } |
  \break
  g'2^\markup { sing while playing } a'^\markup { flutter tongue } |
  b'4^\markup { slap tongue }-+\ff r4 c''-+^\markup { tongue stop } r4 |
  \break
  d''2^\markup { air sound }\pp e''^\markup { key clicks } |
  f''2^\markup { harmonics } \ottava #1 g''^\markup { altissimo } \ottava #0 |
  \break
  \mark "MULTIPHONIC"
  <c' e' bes'>1\fff |
  a'4-1^\markup { front F } b'-2 c''-3 d''-12 |
  \break

  % F - repeats, alternatives, percent repeats, and measured tremolo.
  \mark \default
  \tempo "In strict time" 4 = 120
  \repeat volta 2 {
    c'4\mf d' e' f' | g'2 a' |
  }
  \alternative {
    { b'2 c'' | }
    { d''1 | }
  }
  \break
  \repeat percent 2 { e''8 d'' c'' b' a'4 g' } |
  \repeat tremolo 8 { f'16 c'' } |
  \break
  g'4\> a' b' c''\! |
  \pageBreak

  % G - rehearsal/navigation symbols, breath, fermata, and long rests.
  \mark \default
  \key g \major
  \segnoMark \default
  g'4\mf a' b' c'' | d'' c'' b' a' |
  \break
  b'2( a') | g'2\breathe d'' |
  \jump "D.S. al Coda"
  \break
  \codaMark \default
  e''4 d'' c'' b' | a'1\fermata |
  \break
  \compressMMRests { R1*2 }
  \break

  % H - final compendium page and a clear preparation for the solo.
  \mark \default
  \key a \major
  \tempo "Broadly" 4 = 72
  a'2\p cis'' | e''1\fermata |
  \break
  fis''4-> e'' d'' cis'' | b'2\> a'\pp |
  \break
  \compressMMRests { R1*4 }
  \pageBreak

  % 32-bar solo chorus. Chord symbols begin here, in concert pitch.
  \mark "SOLO"
  \key d \major
  \tempo "Medium swing" 4 = 132
  fis'4\mf a' cis'' a' | b'8( cis'' d'' fis'') e''4 cis'' |
  b'4 d'' fis'' d'' | eis'8 fis' gis' b' cis''4 b' |
  \break
  a'2 fis'4 gis' | d''4 cis''8 b' a'4 fis' |
  b'8 cis'' d'' e'' eis''4 cis'' | fis''2 r4 cis'' |
  \break
  e''4\p cis'' b' a' | gis'8 a' b' cis'' d''4 fis'' |
  g''4 fis'' d'' b' | eis''2 cis'' |
  \break
  a'4\< cis'' e'' fis''\! | d''8( cis'' b' a') fis'4 a' |
  b'4 d'' eis'' gis'' | fis''1\f |
  \pageBreak

  d''4\mp fis'' a'' fis'' | dis''8 e'' fis'' a'' c'''4 a'' |
  a''2 e''4 cis'' | b'4 d'' fis'' gis'' |
  \break
  b''8 a'' g'' fis'' e'' d'' cis'' b' | eis''4 gis'' b'' gis'' |
  e''4 cis'' b' a' | gis'8 b' d'' fis'' a''4 fis'' |
  \break
  b'4^\markup { build } d'' fis'' a'' |
  gis''8 fis'' eis'' dis'' cis'' b' a' gis' |
  fis'4\< a' cis'' e'' | d'' fis'' a'' cis'''\! |
  \break
  b''8\ff a'' fis'' e'' d'' b' a' fis' |
  a'4 fis' e' d' | b'8 cis'' d'' e'' eis'' fis'' gis'' b'' |
  a''2\> fis''\pp |
  \bar "|."
}

\score {
  <<
    \new ChordNames \chordmode {
      % Seventy whole-note beats cover the notation compendium. The
      % ChordNames engraver deliberately prints nothing for this skip.
      s1*70

      % Concert-pitch changes for the 32-bar solo chorus.
      f1:maj7 | d1:m7 | g1:m7 | c1:7 |
      f1:6 | bes1:maj7 | g2:m7 c2:7 | f1:maj7 |
      a1:m7 | d1:7 | g1:m7 | c1:7 |
      f1:maj7 | d1:m7 | g2:m7 c2:7 | f1:6 |
      bes1:maj7 | b1:dim | f1/c | d1:7 |
      g1:m7 | c1:9 | a1:m7 | d1:7 |
      g1:m7 | c1:7 | f1:maj7 | d1:m7 |
      g2:m7 c2:7 | f2:maj7 d2:m7 | g2:m7 c2:7 | f1:6 |
    }
    \new Staff \with {
      instrumentName = "Alto Saxophone"
      shortInstrumentName = "A. Sax."
    } \altoMusic
  >>
  \layout {
    ragged-right = ##f
    ragged-last = ##f
  }
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
