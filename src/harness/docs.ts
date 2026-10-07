/** Full-text search over the LilyPond 2.24.4 documentation built by `npm run docs:sync`. */

export type DocKind = 'notation' | 'snippet' | 'glossary'

export interface Doc {
  id: string
  kind: DocKind
  title: string
  /** Enclosing chapters and sections, or snippet tags. */
  path: string[]
  /** Index entries (`@cindex`/`@funindex`) or snippet tags. */
  keywords: string[]
  text: string
  /** Examples that render with Score Chat, and examples in total. */
  examples: [number, number]
}

export interface DocsIndex {
  docs: ReadonlyMap<string, Doc>
  postings: ReadonlyMap<string, ReadonlyMap<Doc, number>>
  lengths: ReadonlyMap<Doc, number>
  averageLength: number
}

// LilyPond commands keep their backslash (`\staccato`) and also match the bare word.
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const [token] of text.toLowerCase().matchAll(/\\?[a-z0-9]+/g)) {
    tokens.push(token)
    if (token.startsWith('\\') && token.length > 1) tokens.push(token.slice(1))
  }
  return tokens
}

const FIELD_WEIGHTS = { title: 4, keywords: 2, path: 1, text: 1 } as const

export function createDocsIndex(documents: readonly Doc[]): DocsIndex {
  const postings = new Map<string, Map<Doc, number>>()
  const lengths = new Map<Doc, number>()
  let total = 0
  for (const doc of documents) {
    const fields = {
      title: doc.title,
      keywords: doc.keywords.join(' '),
      path: doc.path.join(' '),
      text: doc.text,
    }
    let length = 0
    for (const [field, weight] of Object.entries(FIELD_WEIGHTS)) {
      const tokens = tokenize(fields[field as keyof typeof fields])
      length += field === 'text' ? tokens.length : 0
      for (const token of tokens) {
        let posting = postings.get(token)
        if (!posting) postings.set(token, (posting = new Map()))
        posting.set(doc, (posting.get(doc) ?? 0) + weight)
      }
    }
    lengths.set(doc, length)
    total += length
  }
  return {
    docs: new Map(documents.map((doc) => [doc.id, doc])),
    postings,
    lengths,
    averageLength: total / Math.max(1, documents.length),
  }
}

/** Ranks documents with BM25 over title, index entries, path and text. */
export function searchDocs(
  index: DocsIndex,
  query: string,
  options: { kind?: DocKind | null; limit?: number | null } = {},
): { doc: Doc; score: number }[] {
  const terms = [...new Set(tokenize(query))]
  const scores = new Map<Doc, number>()
  for (const term of terms) {
    const posting = index.postings.get(term)
    if (!posting) continue
    const idf = Math.log(
      1 + (index.docs.size - posting.size + 0.5) / (posting.size + 0.5),
    )
    for (const [doc, frequency] of posting) {
      if (options.kind && doc.kind !== options.kind) continue
      const norm =
        1.2 * (0.25 + (0.75 * index.lengths.get(doc)!) / index.averageLength)
      scores.set(
        doc,
        (scores.get(doc) ?? 0) + (idf * frequency * 2.2) / (frequency + norm),
      )
    }
  }
  const limit = Math.min(20, Math.max(1, Math.floor(options.limit ?? 8)))
  return [...scores]
    .map(([doc, score]) => ({ doc, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

const describeExamples = ([renders, total]: Doc['examples']) =>
  total ? `${renders} of ${total} examples render in Score Chat` : 'no examples'

// The first prose line mentioning a query term, as a short excerpt.
function excerpt(doc: Doc, query: string) {
  const terms = tokenize(query)
  const lines = doc.text
    .split(/(```[\s\S]*?```)/)
    .filter((_, index) => index % 2 === 0)
    .flatMap((part) => part.split('\n'))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('Example ('))
  const line =
    lines.find((line) => {
      const tokens = new Set(tokenize(line))
      return terms.some((term) => tokens.has(term))
    }) ??
    lines[0] ??
    ''
  return line.length > 240 ? `${line.slice(0, 240)}…` : line
}

export function formatSearchResults(
  index: DocsIndex,
  query: string,
  options: { kind?: DocKind | null; limit?: number | null } = {},
): string {
  const results = searchDocs(index, query, options)
  if (!results.length)
    return `No documentation matches "${query}". Try other words or a LilyPond command such as \\staccato.`
  return [
    `Top ${results.length} results for "${query}" (read one with read_doc):`,
    ...results.map(({ doc }, rank) =>
      [
        `${rank + 1}. ${doc.title} [${doc.kind}] id: ${doc.id}`,
        doc.path.length ? `   ${doc.path.join(' › ')}` : '',
        `   ${describeExamples(doc.examples)}`,
        `   ${excerpt(doc, query)}`,
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ].join('\n')
}

const PAGE = 12_000

/** Returns one document, in pages of about 12,000 characters cut at line breaks. */
export function readDoc(index: DocsIndex, id: string, offset = 0): string {
  const doc = index.docs.get(id.trim())
  if (!doc)
    return `No document has the id "${id}". Use search_docs to find document ids.`
  const start = Math.max(0, Math.floor(offset))
  let end = Math.min(doc.text.length, start + PAGE)
  if (end < doc.text.length) {
    const lineBreak = doc.text.lastIndexOf('\n', end)
    if (lineBreak > start) end = lineBreak
  }
  const source = {
    notation: 'LilyPond 2.24.4 Notation Reference',
    snippet: 'LilyPond 2.24.4 snippets',
    glossary: 'LilyPond 2.24.4 Music Glossary',
  }[doc.kind]
  return [
    `# ${doc.title}`,
    `${source}${doc.path.length ? ` › ${doc.path.join(' › ')}` : ''} · ${describeExamples(doc.examples)}`,
    '',
    start >= doc.text.length ? '(No more text.)' : doc.text.slice(start, end),
    end < doc.text.length
      ? `\n[Continues: call read_doc with id "${doc.id}" and offset ${end}.]`
      : '',
  ].join('\n')
}
