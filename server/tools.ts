import { Effect, Schema } from 'effect'
import { Tool, Toolkit } from 'effect/ai'
import { applyEdits, readLines, searchLines } from '../shared/scoreText.ts'
import { formatSearchResults, readDoc } from '../shared/docs.ts'
import type { DocsIndex } from '../shared/docs.ts'
import type { CheckDiagnostic, CheckResult } from './renderer/check.js'

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
      "Edit the current score with exact text replacements, applied in order. Each old_text must match the current source exactly (including whitespace, without line-number prefixes) and exactly once unless replace_all is true. The edited score is validated and applied only if it renders; otherwise nothing changes. The user's browser engraves it right away and an edit it cannot engrave is taken back. The user can undo the change. Prefer this over update_score for changes to an existing score.",
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
      'Check a complete LilyPond source with the renderer: parsing and every music construct, without changing the score. Returns diagnostics.',
    parameters: Schema.Struct({ source: Schema.String }),
    success: Schema.String,
  }),
  Tool.make('update_score', {
    description:
      'Validate and replace the whole score with complete LilyPond source. Use for new scores or rewrites; use edit_score for targeted changes. Only supported scores are applied. The user can undo the change.',
    parameters: Schema.Struct({ source: Schema.String }),
    success: Schema.String,
  }),
)

/** What happened to a checked source handed to the document. */
export type ApplyOutcome =
  /** Applied; `engraved` when a browser rendered it without errors. */
  | { readonly type: 'applied'; readonly engraved: boolean }
  /** The browser could not engrave it, so it was taken back. */
  | { readonly type: 'rejected'; readonly result: CheckResult }
  /** The score changed in the meantime; nothing was applied. */
  | { readonly type: 'stale' }

/** What the tools need from the document. */
export interface ToolContext {
  readonly getSource: () => string
  /** Applies a source that passed the check, unless the score is no longer `before`. */
  readonly applySource: (
    source: string,
    before: string,
  ) => Effect.Effect<ApplyOutcome>
  /** Parses and interprets a score without engraving it. */
  readonly check: (source: string) => Promise<CheckResult>
  readonly docs: () => Promise<DocsIndex>
  readonly onStatus: (status: string) => void
}

/** What each category asks of the model. */
const ADVICE: Record<CheckDiagnostic['category'], string> = {
  syntax: 'syntax error, fix the source',
  invalid: 'not valid LilyPond, fix the source',
  unsupported: 'valid LilyPond the renderer does not support, find another way',
  unclassified: 'error',
  warning: 'warning',
}

// The renderer's hints are written for its command line; Score Chat cannot
// add fonts, so the one way out is to avoid the character.
const hintFor = (diagnostic: CheckDiagnostic) =>
  diagnostic.hint?.includes('--font-dir')
    ? 'Leave the character out or replace it; Score Chat cannot add text fonts.'
    : diagnostic.hint

/** One line per problem: where, what kind, what, and a fix to try. */
export const formatDiagnostics = (diagnostics: readonly CheckDiagnostic[]) =>
  diagnostics
    .map((diagnostic) => {
      const at = diagnostic.position
        ? `Line ${diagnostic.position.line}, column ${diagnostic.position.column}`
        : 'Score'
      const hint = hintFor(diagnostic)
      return `${at} (${ADVICE[diagnostic.category]}): ${diagnostic.message}${hint ? ` Hint: ${hint}` : ''}`
    })
    .join('\n')

const errorsOf = (result: CheckResult) =>
  result.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')
const warningsOf = (result: CheckResult) => {
  const warnings = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === 'warning',
  )
  return warnings.length ? `\nWarnings:\n${formatDiagnostics(warnings)}` : ''
}

export function scoreToolHandlers(context: ToolContext) {
  const withDocs = (use: (index: DocsIndex) => string) =>
    Effect.promise(() =>
      context
        .docs()
        .then(
          use,
          () => 'The documentation could not be loaded. Try again later.',
        ),
    )
  const validate = (
    source: string,
    apply: boolean,
    before = context.getSource(),
  ) =>
    Effect.gen(function* () {
      context.onStatus(
        apply ? 'Checking score changes…' : 'Validating LilyPond…',
      )
      const checked = yield* Effect.tryPromise(() =>
        context.check(source),
      ).pipe(Effect.option)
      if (checked._tag === 'None')
        return 'The renderer could not be loaded to check the score. Nothing was applied; try again.'
      const result = checked.value
      if (!result.ok)
        return `Validation failed. Fix these errors and try again:\n${formatDiagnostics(errorsOf(result))}`
      if (!apply)
        return `Validated successfully: it parses and every construct is supported. Layout problems would only show when it is engraved.${warningsOf(result)}`
      context.onStatus('Engraving your score…')
      const outcome = yield* context.applySource(source, before)
      switch (outcome.type) {
        case 'stale':
          return 'The score changed during validation. Read it again before updating.'
        case 'rejected':
          return `Validation failed. The renderer could not engrave it, so nothing was applied. Fix these errors and try again:\n${formatDiagnostics(errorsOf(outcome.result))}`
        case 'applied':
          return (
            (outcome.engraved
              ? 'Applied successfully. The user sees the engraved score.'
              : 'Applied successfully. It parses and every construct is supported; no browser is open to engrave it yet.') +
            warningsOf(result)
          )
      }
    })
  return ScoreTools.toLayer({
    read_score: ({ start_line, end_line }) =>
      Effect.sync(() => {
        context.onStatus('Reading your score…')
        return readLines(context.getSource(), start_line, end_line)
      }),
    search_score: ({ query, regex, context: around }) =>
      Effect.sync(() => {
        context.onStatus(`Searching for “${query}”…`)
        return searchLines(context.getSource(), query, {
          regex,
          context: around,
        })
      }),
    edit_score: ({ edits }) =>
      Effect.suspend(() => {
        const before = context.getSource()
        const result = applyEdits(before, edits)
        return 'error' in result
          ? Effect.succeed(`${result.error} No changes applied.`)
          : validate(result.source, true, before)
      }),
    search_docs: ({ query, kind, limit }) =>
      Effect.suspend(() => {
        context.onStatus(`Looking up “${query}” in the LilyPond docs…`)
        return withDocs((index) =>
          formatSearchResults(index, query, { kind, limit }),
        )
      }),
    read_doc: ({ id, offset }) =>
      Effect.suspend(() => {
        context.onStatus('Reading the LilyPond docs…')
        return withDocs((index) => readDoc(index, id, offset ?? 0))
      }),
    validate_score: ({ source }) => validate(source, false),
    update_score: ({ source }) => validate(source, true),
  })
}
