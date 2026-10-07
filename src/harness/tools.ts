import { Effect, Schema } from 'effect'
import { Tool, Toolkit } from 'effect/ai'
import { renderScore } from '../renderer'
import { applyEdits, readLines, searchLines } from './scoreText'
import { createDocsIndex, formatSearchResults, readDoc } from './docs'
import type { Doc, DocsIndex } from './docs'

let docsIndex: Promise<DocsIndex> | undefined
// The documentation is about 2 MB, so it is fetched on first use and kept for the session.
function loadDocs() {
  docsIndex ??= fetch(`${import.meta.env.BASE_URL}docs/lilypond-docs.json`)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json() as Promise<{ documents: Doc[] }>
    })
    .then(({ documents }) => createDocsIndex(documents))
    .catch((cause) => {
      docsIndex = undefined
      throw cause
    })
  return docsIndex
}
const withDocs = (use: (index: DocsIndex) => string) =>
  Effect.promise(() =>
    loadDocs().then(
      use,
      () => 'The documentation could not be loaded. Try again later.',
    ),
  )

export const ScoreTools = Toolkit.make(
  Tool.make('read_score', {
    description:
      'Read the current LilyPond source, or a 1-based inclusive line range of it. Each returned line is prefixed with its line number and a tab; the prefixes are not part of the source.',
    parameters: Schema.Struct({
      start_line: Schema.optionalKey(Schema.Int),
      end_line: Schema.optionalKey(Schema.Int),
    }),
    success: Schema.String,
  }),
  Tool.make('search_score', {
    description:
      'Search the current LilyPond source for lines containing a case-insensitive text (or a regular expression when regex is true). Returns matching lines with line numbers, plus `context` surrounding lines (0–10).',
    parameters: Schema.Struct({
      query: Schema.String,
      regex: Schema.optionalKey(Schema.Boolean),
      context: Schema.optionalKey(Schema.Int),
    }),
    success: Schema.String,
  }),
  Tool.make('edit_score', {
    description:
      'Edit the current score with exact text replacements, applied in order. Each old_text must match the current source exactly (including whitespace, without line-number prefixes) and exactly once unless replace_all is true. The edited score is validated and applied only if it renders; otherwise nothing changes. The user can undo the change. Prefer this over update_score for changes to an existing score.',
    parameters: Schema.Struct({
      edits: Schema.Array(
        Schema.Struct({
          old_text: Schema.String,
          new_text: Schema.String,
          replace_all: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    }),
    success: Schema.String,
  }),
  Tool.make('search_docs', {
    description:
      'Search the LilyPond 2.24.4 documentation: the Notation Reference, the snippet collection and the Music Glossary. Use words or LilyPond commands (for example "hairpin crescendo" or "\\tuplet"). Returns ranked document ids with excerpts and how many of their examples render in Score Chat.',
    parameters: Schema.Struct({
      query: Schema.String,
      kind: Schema.optionalKey(
        Schema.Literals(['notation', 'snippet', 'glossary']),
      ),
      limit: Schema.optionalKey(Schema.Int),
    }),
    success: Schema.String,
  }),
  Tool.make('read_doc', {
    description:
      'Read a documentation page by id from search_docs. Each LilyPond example is a complete file marked as rendering in Score Chat or not. Long pages continue from the given offset.',
    parameters: Schema.Struct({
      id: Schema.String,
      offset: Schema.optionalKey(Schema.Int),
    }),
    success: Schema.String,
  }),
  Tool.make('validate_score', {
    description:
      'Compile a complete LilyPond source with the local renderer. Returns diagnostics without modifying the editor.',
    parameters: Schema.Struct({ source: Schema.String }),
    success: Schema.String,
  }),
  Tool.make('update_score', {
    description:
      'Validate and replace the whole score with complete LilyPond source. Use for new scores or rewrites; use edit_score for targeted changes. Only supported, successfully rendered scores are applied. The user can undo the change.',
    parameters: Schema.Struct({ source: Schema.String }),
    success: Schema.String,
  }),
)

/** What the tools need from the workspace. Callbacks must ignore calls after the turn is stopped. */
export interface ToolContext {
  getSource: () => string
  updateSource: (source: string) => void
  onStatus: (status: string) => void
  signal: AbortSignal
}

export function scoreToolHandlers(options: ToolContext) {
  const { signal } = options
  const validate = (
    source: string,
    apply: boolean,
    before = options.getSource(),
  ) =>
    Effect.promise(async () => {
      options.onStatus(
        apply ? 'Checking score changes…' : 'Validating LilyPond…',
      )
      const result = await renderScore(source, signal)
      if (signal.aborted) return 'Cancelled. No changes applied.'
      if (result.errors.length || !result.pages.length)
        return `Validation failed. Fix these errors and try again:\n${result.errors.join('\n')}`
      if (apply) {
        if (before !== options.getSource())
          return 'The score changed during validation. Read it again before updating.'
        options.updateSource(source)
      }
      return `${apply ? 'Applied' : 'Validated'} successfully: ${result.pages.length} page(s).`
    })
  return ScoreTools.toLayer({
    read_score: ({ start_line, end_line }) =>
      Effect.sync(() => {
        options.onStatus('Reading your score…')
        return readLines(options.getSource(), start_line, end_line)
      }),
    search_score: ({ query, regex, context }) =>
      Effect.sync(() => {
        options.onStatus(`Searching for “${query}”…`)
        return searchLines(options.getSource(), query, { regex, context })
      }),
    edit_score: ({ edits }) =>
      Effect.suspend(() => {
        const before = options.getSource()
        const result = applyEdits(before, edits)
        return 'error' in result
          ? Effect.succeed(`${result.error} No changes applied.`)
          : validate(result.source, true, before)
      }),
    search_docs: ({ query, kind, limit }) =>
      Effect.suspend(() => {
        options.onStatus(`Looking up “${query}” in the LilyPond docs…`)
        return withDocs((index) =>
          formatSearchResults(index, query, { kind, limit }),
        )
      }),
    read_doc: ({ id, offset }) =>
      Effect.suspend(() => {
        options.onStatus('Reading the LilyPond docs…')
        return withDocs((index) => readDoc(index, id, offset ?? 0))
      }),
    validate_score: ({ source }) => validate(source, false),
    update_score: ({ source }) => validate(source, true),
  })
}
