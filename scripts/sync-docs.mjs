// Builds the agent's searchable LilyPond documentation from the 2.24.4 sources
// bundled with lilypond-typescript: the Notation Reference, the snippets and
// the Music Glossary. Every example is compiled with the renderer, so the agent
// knows which ones Score Chat supports. Run with Bun, which loads the renderer's
// TypeScript directly: `bun scripts/sync-docs.mjs [lilypond-typescript checkout]`.
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, resolve } from 'node:path'
import { homedir } from 'node:os'

const root = resolve(
  process.argv[2] ?? `${homedir()}/development/github/lilypond-typescript`,
)
const documentation = resolve(root, 'lilypond-2.24.4/Documentation')
const { renderLyToSvgString } = await import(resolve(root, 'index.ts'))
const revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim()

// ---------------------------------------------------------------------------
// Texinfo to plain text

const SKIPPED_BLOCKS = new Set([
  'ignore',
  'menu',
  'iftex',
  'ifinfo',
  'ifnothtml',
  'tex',
  'macro',
  'html',
  'ifdocbook',
  'ifxml',
  'direntry',
  'documentdescription',
  'titlepage',
])

// Converts inline Texinfo (`@code{…}`, `@ref{…}` and friends) to Markdown-ish text.
function inline(text, inCode = false) {
  let output = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char !== '@') {
      output += char
      index++
      continue
    }
    const next = text[index + 1]
    if (next && '@{}\\'.includes(next)) {
      output += next
      index += 2
      continue
    }
    if (next === '*') {
      output += '\n'
      index += 2
      continue
    }
    if (next && ' ,:.!?\'"-'.includes(next)) {
      // Spacing and accent commands; keep the character itself.
      output += next === '-' ? '' : next
      index += 2
      continue
    }
    const name = /^[a-zA-Z]+/.exec(text.slice(index + 1))?.[0]
    if (!name) {
      output += char
      index++
      continue
    }
    index += name.length + 1
    if (text[index] !== '{') {
      continue
    }
    let depth = 1
    let end = index + 1
    while (end < text.length && depth) {
      if (text[end] === '@') end += 2
      else {
        if (text[end] === '{') depth++
        else if (text[end] === '}') depth--
        end++
      }
    }
    const argument = text.slice(index + 1, end - 1)
    index = end
    output += command(name, argument, inCode)
  }
  return output
}

function command(name, argument, inCode) {
  const content = () => inline(argument, inCode)
  const first = () => inline(argument.split(',')[0].trim(), inCode)
  switch (name) {
    case 'code':
    case 'samp':
    case 'file':
    case 'command':
    case 'env':
    case 'option':
    case 'kbd':
    case 'key':
      return inCode ? inline(argument, true) : `\`${inline(argument, true)}\``
    case 'var':
      return inCode ? `<${content()}>` : `*${content()}*`
    case 'emph':
    case 'i':
    case 'dfn':
      return `*${content()}*`
    case 'strong':
    case 'b':
      return `**${content()}**`
    case 'q':
      return `‘${content()}’`
    case 'qq':
      return `“${content()}”`
    case 'ref':
    case 'xref':
    case 'pxref':
    case 'ruser':
      return `“${first()}”`
    case 'rglos':
      return `“${first()}” (Music Glossary)`
    case 'rlearning':
      return `“${first()}” (Learning Manual)`
    case 'rinternals':
      return `\`${first()}\` (Internals Reference)`
    case 'rlsr':
      return `“${first()}” (snippets)`
    case 'rextend':
    case 'rprogram':
    case 'ressay':
    case 'rchanges':
    case 'rweb':
    case 'rcontrib':
      return `“${first()}”`
    case 'uref':
    case 'url': {
      const [url, label] = argument.split(',').map((part) => part.trim())
      return label ? `${inline(label)} (${url})` : url
    }
    case 'email':
      return argument.split(',')[0].trim()
    case 'footnote':
      return ` (${content()})`
    case 'dots':
    case 'enddots':
      return '…'
    case 'tie':
      return ' '
    case 'bs':
      return '\\'
    case 'minus':
      return '−'
    case 'copyright':
      return '©'
    case 'tab':
      return ' | '
    case 'image':
    case 'anchor':
    case 'cindex':
    case 'funindex':
      return ''
    default:
      return content()
  }
}

// ---------------------------------------------------------------------------
// Examples

// Reproduces lilypond-book's wrapping of `@lilypond[relative=n,fragment]` examples.
function exampleSource(body, options) {
  const relative = /(?:^|,)\s*relative(?:=(\d+))?\s*(?:,|$)/.exec(options)
  if (relative) {
    const octave = Number(relative[1] ?? 1)
    const marks = octave > 0 ? "'".repeat(octave) : ','.repeat(-octave)
    return `\\relative c${marks} {\n${body}\n}`
  }
  if (/(?:^|,)\s*fragment\s*(?:,|$)/.test(options)) return `{\n${body}\n}`
  return body
}

const withVersion = (source) =>
  `\\version "2.24.4"\n${source.replace(/^\s*\\version\s+"[^"]*"\s*\n?/m, '')}`

let checked = 0
const started = Date.now()
// The renderer needs an explicit score and staff where LilyPond creates them
// implicitly, so wrapped variants are tried after the source as written.
async function checkExample(source) {
  checked++
  if (checked % 100 === 0)
    console.log(
      `  checked ${checked} examples (${Math.round((Date.now() - started) / 1000)}s)`,
    )
  const variants = [withVersion(source)]
  if (!/\\(score|book|bookpart)\b/.test(source)) {
    variants.push(withVersion(`\\score {\n${source}\n}`))
    if (!/\\new\s+\w*Staff|\\context\s+\w*Staff/.test(source))
      variants.push(withVersion(`\\score {\n\\new Staff {\n${source}\n}\n}`))
  }
  for (const variant of variants) {
    try {
      const result = await renderLyToSvgString(variant, { file: 'example.ly' })
      if (
        result.renderer &&
        !result.diagnostics.some(
          (diagnostic) => diagnostic.severity === 'error',
        )
      )
        return { source: variant, renders: true }
    } catch {
      // Unsupported input can throw as well as report diagnostics.
    }
  }
  return { source: variants[0], renders: false }
}

function formatExample({ source, renders }) {
  return [
    renders
      ? 'Example (renders in Score Chat):'
      : 'Example (not supported by the Score Chat renderer):',
    '```lilypond',
    source.trim(),
    '```',
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Snippets

const snippets = new Map()
// Chapter "headword" snippets are showcase scores that use every mark at once
// and would crowd out real explanations in search.
async function readSnippet(name) {
  if (name.endsWith('-headword')) return undefined
  if (snippets.has(name)) return snippets.get(name)
  const path = resolve(documentation, 'snippets', `${name}.ly`)
  if (!existsSync(path)) return undefined
  const file = await readFile(path, 'utf8')
  const field = (key) => {
    const match = new RegExp(`${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(
      file,
    )
    return match ? match[1].replace(/\\(["\\])/g, '$1') : ''
  }
  const body = file.split(/%\s*begin verbatim\s*\n/)[1] ?? file
  const example = await checkExample(body.trim())
  const snippet = {
    id: `snippet/${name}`,
    kind: 'snippet',
    title: inline(field('doctitle')) || name.replaceAll('-', ' '),
    path: ['Snippets', ...field('lsrtags').split(/,\s*/).filter(Boolean)],
    keywords: field('lsrtags').split(/,\s*/).filter(Boolean),
    text: [reflow(paragraphs(field('texidoc'))), formatExample(example)]
      .filter(Boolean)
      .join('\n\n'),
    examples: [example.renders ? 1 : 0, 1],
  }
  snippets.set(name, snippet)
  return snippet
}

const paragraphs = (text) =>
  inline(text)
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')

// ---------------------------------------------------------------------------
// Manuals

async function expand(file) {
  const text = await readFile(file, 'utf8')
  const lines = []
  for (const line of text.split('\n')) {
    const include = /^@include\s+(\S+)/.exec(line)
    if (include) {
      const path = resolve(documentation, include[1])
      if (existsSync(path) && /\.(itely|itexi|tely)$/.test(path))
        lines.push(...(await expand(path)))
    } else lines.push(line)
  }
  return lines
}

const HEADINGS =
  /^@(chapter|section|subsection|subsubsection|unnumbered|unnumberedsec|unnumberedsubsec|unnumberedsubsubsec|appendix|appendixsec|appendixsubsec|appendixsubsubsec)\s+(.*)$/
const LABELS = {
  predefined: 'Predefined commands:',
  snippets: 'Selected snippets:',
  morerefs: 'See also:',
  knownissues: 'Known issues and warnings:',
}

// Splits a manual into one document per node, converting its body to text.
async function manual(file, kind, prefix) {
  const lines = await expand(file)
  const documents = []
  const trail = []
  let current
  let skip = []
  let block
  let example
  let list = []
  const push = (text) => current?.lines.push(text)
  for (let index = 0; index < lines.length; index++) {
    let line = lines[index]
    if (example) {
      if (/^@end lilypond/.test(line)) {
        const checkedExample = await checkExample(
          exampleSource(example.body.join('\n'), example.options),
        )
        current.examples.push(checkedExample.renders)
        push(formatExample(checkedExample))
        example = undefined
      } else example.body.push(line)
      continue
    }
    if (skip.length) {
      const nested = /^@([a-z]+)\b/.exec(line)?.[1]
      if (nested && SKIPPED_BLOCKS.has(nested)) skip.push(nested)
      else if (/^@end\s+(\w+)/.exec(line)?.[1] === skip.at(-1)) skip.pop()
      continue
    }
    if (block) {
      if (new RegExp(`^@end ${block.name}\\b`).test(line)) {
        push(['```', ...block.body, '```'].join('\n'))
        block = undefined
      } else
        block.body.push(block.name === 'verbatim' ? line : inline(line, true))
      continue
    }
    const opened = /^@([a-z]+)\b/.exec(line)?.[1]
    if (opened && SKIPPED_BLOCKS.has(opened)) {
      skip.push(opened)
      continue
    }
    if (
      /^@c(omment)?\b/.test(line) ||
      /^@(noindent|need|page|sp|indent)\b/.test(line)
    )
      continue
    const node = /^@node\s+(.+)$/.exec(line)
    if (node) {
      current = {
        node: node[1].split(',')[0].trim(),
        lines: [],
        keywords: [],
        examples: [],
        trail: [],
      }
      documents.push(current)
      continue
    }
    if (!current) continue
    const heading = HEADINGS.exec(line)
    if (heading) {
      const level =
        {
          chapter: 0,
          unnumbered: 0,
          appendix: 0,
          section: 1,
          unnumberedsec: 1,
          appendixsec: 1,
          subsection: 2,
          unnumberedsubsec: 2,
          appendixsubsec: 2,
        }[heading[1]] ?? 3
      trail.length = level
      trail[level] = inline(heading[2]).trim()
      current.title = trail[level]
      current.trail = trail.slice(0, level).filter(Boolean)
      continue
    }
    const index_ = /^@(cindex|funindex|kindex|vindex)\s+(.+)$/.exec(line)
    if (index_) {
      current.keywords.push(inline(index_[2], true).trim())
      continue
    }
    const lilypond = /^@lilypond(?:\[([^\]]*)\])?\s*(\{.*\})?\s*$/.exec(line)
    if (lilypond) {
      if (lilypond[2]) {
        const checkedExample = await checkExample(
          exampleSource(lilypond[2].slice(1, -1), lilypond[1] ?? ''),
        )
        current.examples.push(checkedExample.renders)
        push(formatExample(checkedExample))
      } else example = { options: lilypond[1] ?? '', body: [] }
      continue
    }
    if (/^@lilypondfile\b/.test(line)) {
      // The file name sometimes sits on the following line.
      while (!/\{[^}]*\}/.test(line) && index + 1 < lines.length)
        line += lines[++index]
      const name = /\{(?:snippets\/)?([^}]+?)(?:\.ly)?\}/.exec(line)?.[1]
      const snippet = name && (await readSnippet(basename(name)))
      if (snippet) {
        current.examples.push(snippet.examples[0] === 1)
        push(
          `- Snippet “${snippet.title}” (read_doc id \`${snippet.id}\`; ${snippet.examples[0] ? 'renders in Score Chat' : 'not supported by the Score Chat renderer'})`,
        )
      }
      continue
    }
    const code = /^@(example|smallexample|verbatim|display|lisp)\b/.exec(line)
    if (code) {
      block = { name: code[1], body: [] }
      continue
    }
    const label = /^@(predefined|snippets|morerefs|knownissues)\b/.exec(line)
    if (label) {
      push(`\n**${LABELS[label[1]]}**`)
      continue
    }
    const listStart =
      /^@(itemize|enumerate|table|ftable|vtable|multitable)\b/.exec(line)
    if (listStart) {
      list.push(listStart[1])
      continue
    }
    if (
      /^@end\s+(itemize|enumerate|table|ftable|vtable|multitable)\b/.test(line)
    ) {
      list.pop()
      push('')
      continue
    }
    if (/^@(endpredefined|endmorerefs|end\s+\w+)\b/.test(line)) continue
    const item = /^@(item|itemx|headitem)\b\s*(.*)$/.exec(line)
    if (item && list.length) {
      const kind_ = list.at(-1)
      const rest = inline(item[2], kind_ === 'multitable').trim()
      push(
        kind_.endsWith('table') && kind_ !== 'multitable'
          ? `- ${rest}:`
          : `- ${rest}`,
      )
      continue
    }
    if (
      /^@(warning|quotation|cartouche|indentedBlock|endIndentedBlock|columnfractions|subheading|subsubheading|subsubsubheading|heading)\b/.test(
        line,
      )
    ) {
      const text = inline(line.replace(/^@\w+\s*/, '')).trim()
      if (text && !/^@columnfractions/.test(line)) push(`**${text}**`)
      continue
    }
    push(inline(line))
  }
  return documents
    .filter(
      (document) =>
        document.title && document.node !== 'GNU Free Documentation License',
    )
    .map((document) => {
      const text = reflow(
        document.lines
          .join('\n')
          .replace(/[ \t]+\n/g, '\n')
          .replace(/^-\n(?=\S)/gm, '- ')
          .replace(/\n{3,}/g, '\n\n'),
      ).trim()
      return {
        id: `${prefix}${slug(document.node)}`,
        kind,
        title: document.title,
        path: document.trail,
        keywords: [...new Set(document.keywords)],
        text,
        examples: [
          document.examples.filter(Boolean).length,
          document.examples.length,
        ],
      }
    })
    .filter((document) => document.text)
}

// Joins Texinfo's hard-wrapped prose lines, leaving code, lists and labels intact.
const reflow = (text) =>
  text
    .split(/(```[\s\S]*?```)/)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(/([^\n])\n(?!\n|- |\*\*|Example \(|```|$)/g, '$1 '),
    )
    .join('')

const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')

// ---------------------------------------------------------------------------

console.log('Notation Reference…')
const notation = await manual(
  resolve(documentation, 'en/notation.tely'),
  'notation',
  '',
)
console.log('Music Glossary…')
const glossary = await manual(
  resolve(documentation, 'en/music-glossary.tely'),
  'glossary',
  'glossary/',
)
console.log('Remaining snippets…')
for (const file of (await readdir(resolve(documentation, 'snippets'))).sort())
  if (file.endsWith('.ly')) await readSnippet(file.slice(0, -3))

const documents = [...notation, ...glossary, ...snippets.values()]
const ids = new Set()
for (const document of documents) {
  if (ids.has(document.id))
    throw new Error(`Duplicate document id ${document.id}`)
  ids.add(document.id)
}
await mkdir('public/docs', { recursive: true })
await writeFile(
  'public/docs/lilypond-docs.json',
  JSON.stringify({ version: '2.24.4', revision, documents }),
)
await copyFile(
  resolve(root, 'lilypond-2.24.4/COPYING.FDL'),
  'public/docs/COPYING.FDL',
)
const examples = documents.reduce(
  (total, document) => [
    total[0] + document.examples[0],
    total[1] + document.examples[1],
  ],
  [0, 0],
)
console.log(
  `Wrote ${documents.length} documents (${notation.length} notation, ${glossary.length} glossary, ${snippets.size} snippets); ${examples[0]} of ${examples[1]} examples render.`,
)
