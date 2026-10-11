// Derives the editor's `\command` completions from the bundled documentation,
// keeping only the commands Score Chat's renderer supports. Run with Bun, which
// loads the renderer's TypeScript directly:
// `bun scripts/sync-commands.mjs [lilypond-typescript checkout]`
// (sync-docs.mjs runs it after writing the docs).
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

const root = resolve(
  process.argv[2] ?? `${homedir()}/development/github/lilypond-typescript`,
)
const { renderLyToSvgString } = await import(resolve(root, 'index.ts'))

const { documents } = JSON.parse(
  await readFile('public/docs/lilypond-docs.json', 'utf8'),
)

const COMMAND = /\\[a-zA-Z][a-zA-Z-]*[a-zA-Z]|\\[a-zA-Z]/g
const prose = (text) => text.replace(/```[\s\S]*?```/g, '')
const words = (text) => text.toLowerCase().match(/[a-z]+/g) ?? []
// "tuplet" matches "Tuplets"; "partCombine" matches "Part combine".
const stem = (word) => word.replace(/s$/, '')

// Example code defines its own variables (`melody = { … }`); those are not commands.
const defined = new Set()
for (const { text } of documents)
  for (const [, name] of text.matchAll(/^\s*([a-zA-Z][a-zA-Z-]*)\s*=/gm))
    defined.add(name)

const commands = new Map()
for (const document of documents) {
  if (document.kind === 'glossary') continue
  const text = prose(document.text)
  const titleWords = new Set(words(document.title).map(stem))
  // Only commands quoted in the prose (`\tuplet`), not every name in an example.
  for (const [quote] of text.matchAll(/`([^`\n]+)`/g)) {
    for (const [match] of quote.matchAll(COMMAND)) {
      const name = match.slice(1)
      if (defined.has(name) && !quote.startsWith(match)) continue
      const entry = commands.get(name) ?? { name, mentions: 0, best: null }
      entry.mentions++
      const nameWords = name
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[\s-]+/)
        .map(stem)
      const score =
        nameWords.filter((word) => titleWords.has(word)).length * 100 +
        (text.split(match).length - 1)
      if (!entry.best || score > entry.best.score)
        entry.best = { score, document, text }
      commands.set(name, entry)
    }
  }
}

const plain = (text) =>
  text.replace(/[`*]/g, '').replace(/^- /, '').replace(/\s+/g, ' ').trim()

// The first real sentence about the command, rather than a bare list item.
const sentence = (text, name) => {
  const mention = new RegExp(`\\\\${name}(?![a-zA-Z-])`)
  const found = text
    .split(/(?<=[.!?])\s+|\n+/)
    .filter((part) => mention.test(part))
    .map(plain)
  const best = found.find((part) => part.split(' ').length >= 6) ?? found[0]
  return best ? best.slice(0, 240) : ''
}

// A command is supported when a documentation example that renders uses it…
const rendered = new Set()
for (const { text } of documents)
  for (const [, code] of text.matchAll(
    /Example \(renders in Score Chat\):\n```lilypond\n([\s\S]*?)```/g,
  ))
    for (const [match] of code.matchAll(COMMAND)) rendered.add(match.slice(1))

// …or when it renders without errors on its own in one of these places. Commands
// that need arguments fail every probe, so the examples carry most of the weight.
const PROBES = [
  (name) => `{ c'4 \\${name} c'4 }`,
  (name) => `{ c'4\\${name} c'4 }`,
  (name) => `\\${name}\n{ c'4 }`,
  (name) => `{ c'4^\\markup { \\${name} "text" } }`,
]
async function rendersCleanly(source) {
  try {
    const result = await renderLyToSvgString(
      `\\version "2.24.4"\n${source}\n`,
      { file: 'probe.ly' },
    )
    return (
      result.renderer &&
      !result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')
    )
  } catch {
    // Unsupported input can throw as well as report diagnostics.
    return false
  }
}
async function supports(probes, name) {
  for (const probe of probes) if (await rendersCleanly(probe(name))) return true
  return false
}
const renders = (name) => supports(PROBES, name)

// Completions after `\new` and `\context`, tried as staves, groups and voices.
const CONTEXTS = [
  'Staff',
  'Voice',
  'PianoStaff',
  'GrandStaff',
  'StaffGroup',
  'ChoirStaff',
  'Lyrics',
  'ChordNames',
  'NoteNames',
  'FiguredBass',
  'FretBoards',
  'RhythmicStaff',
  'DrumStaff',
  'DrumVoice',
  'TabStaff',
  'TabVoice',
  'Dynamics',
  'CueVoice',
  'NullVoice',
  'ChordGrid',
  'MensuralStaff',
  'PetrucciStaff',
  'VaticanaStaff',
  'GregorianTranscriptionStaff',
  'KievanStaff',
  'Score',
]
const CONTEXT_PROBES = [
  (name) => `\\new ${name} { c'4 }`,
  (name) => `\\new ${name} << \\new Staff { c'4 } >>`,
  (name) => `\\new Staff \\new ${name} { c'4 }`,
  (name) => `<< \\new Staff { c'4 } \\new ${name} { c'4 } >>`,
  (name) => `<< \\new Staff { c'4 } \\new ${name} \\lyricmode { la4 } >>`,
  (name) => `<< \\new Staff { c'4 } \\new ${name} \\chordmode { c4 } >>`,
  (name) => `<< \\new Staff { c'4 } \\new ${name} \\figuremode { <6>4 } >>`,
  (name) => `\\new ${name} \\drummode { bd4 }`,
]
// Completions after `\clef`.
const CLEFS = [
  'treble',
  'bass',
  'alto',
  'tenor',
  'soprano',
  'mezzosoprano',
  'baritone',
  'varbaritone',
  'subbass',
  'french',
  'percussion',
  'tab',
  'G',
  'F',
  'C',
  '"treble_8"',
  '"bass_8"',
  '"treble^8"',
  '"treble_15"',
  '"bass^15"',
]
const CLEF_PROBES = [(name) => `{ \\clef ${name} c'4 }`]
const contexts = []
for (const name of CONTEXTS)
  if (await supports(CONTEXT_PROBES, name)) contexts.push(name)
const clefs = []
for (const name of CLEFS)
  if (await supports(CLEF_PROBES, name)) clefs.push(name)

const documented = [...commands.values()].filter(
  ({ name, mentions }) => mentions > 1 || !defined.has(name),
)
const supported = []
for (const command of documented)
  if (rendered.has(command.name) || (await renders(command.name)))
    supported.push(command)

const list = supported
  .sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name))
  .map(({ name, mentions, best: { document, text } }) => ({
    name,
    mentions,
    doc: document.id,
    title: plain(document.title),
    info: sentence(text, name),
  }))

await writeFile(
  'public/docs/lilypond-commands.json',
  JSON.stringify({ commands: list, contexts, clefs }),
)
console.log(
  `Wrote ${list.length} supported commands for editor completion (${documented.length - list.length} documented commands are unsupported), ${contexts.length} of ${CONTEXTS.length} contexts and ${clefs.length} of ${CLEFS.length} clefs.`,
)
