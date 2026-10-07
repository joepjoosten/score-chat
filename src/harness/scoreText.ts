/** Pure text helpers behind the agent's read, search and edit tools. */

const numbered = (lines: readonly string[], from: number) =>
  lines.map((line, index) => `${from + index}\t${line}`)

/** Returns the source (or a 1-based inclusive line range of it) with line-number prefixes. */
export function readLines(
  source: string,
  start?: number | null,
  end?: number | null,
): string {
  const lines = source.split('\n')
  const first = Math.max(1, Math.floor(start ?? 1))
  const last = Math.min(lines.length, Math.floor(end ?? lines.length))
  if (first > last)
    return `No lines in that range. The score has ${lines.length} line(s).`
  return [
    `Lines ${first}–${last} of ${lines.length}:`,
    ...numbered(lines.slice(first - 1, last), first),
  ].join('\n')
}

const MAX_MATCHES = 100

/** Finds lines matching a case-insensitive text or regular expression query, with optional surrounding context. */
export function searchLines(
  source: string,
  query: string,
  options: { regex?: boolean | null; context?: number | null } = {},
): string {
  let test: (line: string) => boolean
  if (options.regex) {
    let pattern: RegExp
    try {
      pattern = new RegExp(query, 'i')
    } catch (cause) {
      return `Invalid regular expression: ${(cause as Error).message}`
    }
    test = (line) => pattern.test(line)
  } else {
    const needle = query.toLowerCase()
    if (!needle) return 'Provide a non-empty query.'
    test = (line) => line.toLowerCase().includes(needle)
  }
  const lines = source.split('\n')
  const matches = lines.flatMap((line, index) => (test(line) ? [index] : []))
  if (!matches.length) return `No lines match "${query}".`
  const shown = matches.slice(0, MAX_MATCHES)
  const context = Math.min(10, Math.max(0, Math.floor(options.context ?? 0)))
  const output = [
    `${matches.length} matching line(s)${matches.length > shown.length ? `, showing the first ${shown.length}` : ''}:`,
  ]
  let printed = -1
  for (const match of shown) {
    const from = Math.max(match - context, printed + 1)
    const to = Math.min(lines.length - 1, match + context)
    if (context && printed >= 0 && from > printed + 1) output.push('--')
    output.push(...numbered(lines.slice(from, to + 1), from + 1))
    printed = to
  }
  return output.join('\n')
}

export interface TextEdit {
  old_text: string
  new_text: string
  replace_all?: boolean | null
}

function count(haystack: string, needle: string) {
  let total = 0
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  )
    total++
  return total
}

/** Applies exact-text replacements in order. Either every edit applies or none do. */
export function applyEdits(
  source: string,
  edits: readonly TextEdit[],
): { source: string } | { error: string } {
  if (!edits.length) return { error: 'Provide at least one edit.' }
  let result = source
  for (const [index, edit] of edits.entries()) {
    const label = edits.length > 1 ? `Edit ${index + 1}: ` : ''
    if (!edit.old_text) return { error: `${label}old_text must not be empty.` }
    const found = count(result, edit.old_text)
    if (!found)
      return {
        error: `${label}old_text was not found. Copy it exactly from read_score or search_score output, without the line-number prefixes.`,
      }
    if (found > 1 && !edit.replace_all)
      return {
        error: `${label}old_text matches ${found} places. Include more surrounding text to make it unique, or set replace_all.`,
      }
    result = edit.replace_all
      ? result.split(edit.old_text).join(edit.new_text)
      : result.replace(edit.old_text, () => edit.new_text)
  }
  return { source: result }
}
