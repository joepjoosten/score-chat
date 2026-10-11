import {
  HighlightStyle,
  StreamLanguage,
  type StringStream,
} from '@codemirror/language'
import type {
  Completion,
  CompletionContext,
  CompletionResult,
} from '@codemirror/autocomplete'
import { tags } from '@lezer/highlight'

type State = {
  // Inside a `%{ … %}` block comment.
  comment: boolean
  string: boolean
  // Open parentheses of a `#( … )` Scheme expression; 0 outside Scheme.
  scheme: number
  // Open `{` and `<<`, for indentation.
  depth: number
}

const COMMAND = /^\\(?:[a-zA-Z][a-zA-Z-]*[a-zA-Z]|[a-zA-Z])/
// `\\` separates voices; `\<`, `\!`, `\(` and friends are hairpins, phrasing slurs and beams.
const COMMAND_SYMBOL = /^\\[\\<>!()[\]~+=]/
// Dutch note names (`c`, `cis`, `bes`, `as`, `eeses`), rests and chord repeats, with octave marks.
const PITCH =
  /^(?:[a-g](?:(?:is|es|s)(?:is|es)?)?|[rRsq])(?![a-zA-Z])[',]*[!?]?/
const DURATION = /^(?:\d+\.*|\*\d+(?:\/\d+)?)/
const WORD = /^[a-zA-Z][a-zA-Z0-9_-]*/

function readString(stream: StringStream, state: State) {
  let escaped = false
  let next: string | void
  while ((next = stream.next())) {
    if (next === '"' && !escaped) {
      state.string = false
      return 'string'
    }
    escaped = !escaped && next === '\\'
  }
  return 'string'
}

function scheme(stream: StringStream, state: State) {
  if (stream.eatSpace()) return null
  if (stream.match(';')) {
    stream.skipToEnd()
    return 'comment'
  }
  if (stream.match(/^-?\d+(?:\.\d+)?(?=[\s()]|$)/)) return 'number'
  const next = stream.next()
  if (next === '"') {
    state.string = true
    return readString(stream, state)
  }
  if (next === '(') {
    state.scheme++
    return 'bracket'
  }
  if (next === ')') {
    state.scheme--
    return 'bracket'
  }
  if (next === "'") return 'atom'
  if (next === '#') {
    stream.match(/^[^\s()]*/)
    return 'atom'
  }
  stream.match(/^[^\s()";]*/)
  return 'meta'
}

const lilypond = StreamLanguage.define<State>({
  name: 'lilypond',
  startState: () => ({ comment: false, string: false, scheme: 0, depth: 0 }),
  copyState: (state) => ({ ...state }),
  token(stream, state) {
    if (state.comment) {
      if (stream.skipTo('%}')) {
        stream.match('%}')
        state.comment = false
      } else stream.skipToEnd()
      return 'comment'
    }
    if (state.string) return readString(stream, state)
    if (state.scheme) return scheme(stream, state)
    if (stream.eatSpace()) return null

    if (stream.match('%{')) {
      state.comment = true
      return 'comment'
    }
    if (stream.match('%')) {
      stream.skipToEnd()
      return 'comment'
    }
    if (stream.match('"')) {
      state.string = true
      return readString(stream, state)
    }
    if (stream.match('#(') || stream.match('$(')) {
      state.scheme = 1
      return 'meta'
    }
    if (stream.match(/^[#$]['`]?[^\s{}()[\]"]*/)) return 'meta'
    if (stream.match(COMMAND)) return 'keyword'
    if (stream.match(COMMAND_SYMBOL)) return 'operator'
    if (stream.match('<<') || stream.match('{')) {
      state.depth++
      return 'bracket'
    }
    if (stream.match('>>') || stream.match('}')) {
      state.depth = Math.max(0, state.depth - 1)
      return 'bracket'
    }
    if (stream.match(/^[<>]/)) return 'bracket'
    if (stream.match(DURATION)) return 'number'
    // Articulations and fingerings: `-.`, `->`, `^"text"`, `_1`.
    if (stream.match(/^[-^_][.>^+_!\-|]/)) return 'operator'
    if (stream.match(/^[|~()[\]=]/)) return 'operator'
    if (stream.match(PITCH)) return 'atom'
    if (stream.match(WORD)) {
      const word = stream.current()
      // `melody = { … }` at the start of a line defines a variable.
      if (
        stream.string.slice(0, stream.start).trim() === '' &&
        /^\s*=/.test(stream.string.slice(stream.pos))
      )
        return 'def'
      return /^[A-Z]/.test(word) ? 'type' : null
    }
    stream.next()
    return null
  },
  indent(state, textAfter, context) {
    const closing = /^\s*(?:\}|>>)/.test(textAfter) ? 1 : 0
    return Math.max(0, state.depth - closing) * context.unit
  },
  languageData: {
    commentTokens: { line: '%', block: { open: '%{', close: '%}' } },
    closeBrackets: { brackets: ['{', '"'] },
    indentOnInput: /^\s*(?:\}|>>)$/,
  },
})

export { lilypond }

export const lilypondHighlight = HighlightStyle.define([
  { tag: tags.comment, color: '#9aa08c', fontStyle: 'italic' },
  { tag: tags.string, color: '#9a5735' },
  { tag: tags.keyword, color: '#2f6b4f', fontWeight: '600' },
  { tag: tags.number, color: '#a0701c' },
  { tag: tags.atom, color: '#25301f' },
  { tag: tags.typeName, color: '#5d4fa0' },
  { tag: tags.meta, color: '#8a4f8f' },
  { tag: tags.operator, color: '#8c957d' },
  { tag: tags.bracket, color: '#6d7a5c', fontWeight: '600' },
  { tag: tags.definition(tags.variableName), color: '#2f5f8a' },
])

type Command = { name: string; mentions: number; title: string; info: string }
type Completions = {
  commands: Completion[]
  contexts: Completion[]
  clefs: Completion[]
}

let completions: Promise<Completions> | undefined
// Fetched on the first completion. scripts/sync-commands.mjs lists only what
// Score Chat's renderer supports, with each command's documentation section.
const loadCompletions = () =>
  (completions ??= fetch(
    `${import.meta.env.BASE_URL}docs/lilypond-commands.json`,
  )
    .then((response) => response.json())
    .then(
      (data: { commands: Command[]; contexts: string[]; clefs: string[] }) => ({
        commands: data.commands.map(({ name, mentions, title, info }) => ({
          label: `\\${name}`,
          type: 'keyword',
          detail: title,
          info: info || undefined,
          // Frequently documented commands first among equal matches.
          boost: Math.min(99, Math.round(Math.log2(mentions + 1) * 10)),
        })),
        contexts: data.contexts.map((label) => ({ label, type: 'type' })),
        clefs: data.clefs.map((label) => ({ label, type: 'enum' })),
      }),
    )
    .catch(() => {
      completions = undefined
      return { commands: [], contexts: [], clefs: [] }
    }))

export async function completeLilypond(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  const argument = context.matchBefore(/\\(new|context|clef)\s+"?[\w^]*/)
  if (argument) {
    const [, command] = /^\\(\w+)/.exec(argument.text)!
    const word = /"?[\w^]*$/.exec(argument.text)!
    return {
      from: argument.to - word[0].length,
      options: (await loadCompletions())[
        command === 'clef' ? 'clefs' : 'contexts'
      ],
      validFor: /^"?[\w^]*$/,
    }
  }
  const word = context.matchBefore(/\\[a-zA-Z-]*/)
  if (!word || (word.from === word.to && !context.explicit)) return null
  // Variables defined in this score (`melody = { … }`) are referenced as `\melody`.
  const defined = new Set<string>()
  for (const [, name] of context.state.doc
    .toString()
    .matchAll(/^\s*([a-zA-Z][a-zA-Z-]*)\s*=/gm))
    defined.add(name)
  return {
    from: word.from,
    options: [
      ...[...defined].map((name) => ({
        label: `\\${name}`,
        type: 'variable',
        detail: 'defined in this score',
        boost: 99,
      })),
      ...(await loadCompletions()).commands.filter(
        (option) => !defined.has(option.label.slice(1)),
      ),
    ],
    validFor: /^\\[a-zA-Z-]*$/,
  }
}
