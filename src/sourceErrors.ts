import type { SourcePosition } from './renderer'

export type SourceError = { from: number; to: number; message: string }

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Drops the renderer's internal stage prefix (`V2 renderer parse: `). */
export const errorMessage = (message: string) =>
  message.replace(/^V\d+ renderer [\w-]+:\s*/, '')

/** The offset of a 1-based line and UTF-16 column, clamped to the source. */
export function offsetOf(source: string, line: number, column: number) {
  let offset = 0
  for (let current = 1; current < line; current++) {
    const next = source.indexOf('\n', offset)
    if (next < 0) return source.length
    offset = next + 1
  }
  const end = source.indexOf('\n', offset)
  return Math.min(offset + column - 1, end < 0 ? source.length : end)
}

/**
 * Where to mark each render error in the source. Errors with a position are
 * marked there exactly; a zero-width position (a failure no single piece of
 * music claims) becomes a point. The rest fall back to marking the command or
 * identifier they name.
 */
export function markErrors(
  source: string,
  errors: readonly string[],
  positions: readonly (SourcePosition | null | undefined)[],
): SourceError[] {
  const marked: SourceError[] = []
  const unplaced: string[] = []
  errors.forEach((error, index) => {
    const position = positions[index]
    if (!position) return void unplaced.push(error)
    const from = offsetOf(source, position.line, position.column)
    const to = offsetOf(source, position.endLine, position.endColumn)
    marked.push({
      from,
      to: Math.max(from, to),
      message: errorMessage(error),
    })
  })
  return [...marked, ...locateErrors(source, unplaced)]
}

// Errors without a position often still name the offending command or
// identifier (``Unsupported LilyPond command `\foo` ``); mark each use of it.
export function locateErrors(
  source: string,
  errors: readonly string[],
  limit = 50,
): SourceError[] {
  const found: SourceError[] = []
  const seen = new Set<string>()
  for (const error of errors)
    for (const part of errorMessage(error).split(/;\s+/)) {
      const [, name] =
        /(?:command|identifier|variable) `([^`]+)`/i.exec(part) ?? []
      if (!name || seen.has(name)) continue
      seen.add(name)
      const message = part.trim().replace(/[.;]*$/, '.')
      const pattern = new RegExp(
        name.startsWith('\\')
          ? `${escape(name)}(?![a-zA-Z])`
          : `(?<![\\\\a-zA-Z])${escape(name)}(?![a-zA-Z])`,
        'g',
      )
      for (const match of source.matchAll(pattern)) {
        if (found.length >= limit) return found
        found.push({
          from: match.index,
          to: match.index + name.length,
          message,
        })
      }
    }
  return found
}
