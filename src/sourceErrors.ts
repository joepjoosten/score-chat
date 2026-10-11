export type SourceError = { from: number; to: number; message: string }

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Render errors carry no positions, but most name the offending command or
// identifier (``Unsupported LilyPond command `\foo` ``); mark each use of it.
export function locateErrors(
  source: string,
  errors: readonly string[],
  limit = 50,
): SourceError[] {
  const found: SourceError[] = []
  const seen = new Set<string>()
  for (const error of errors)
    for (const part of error
      .replace(/^[^:`]*renderer[^:`]*:\s*/i, '')
      .split(/;\s+/)) {
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
