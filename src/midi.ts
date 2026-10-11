/**
 * Adds an empty `\midi { }` block to every `\score` in the source, so a score
 * written for print only can still be performed. The block goes just before
 * each score's closing brace on the same line, so every earlier position keeps
 * its line and column and stays comparable with the rendered score's anchors.
 * Returns the source unchanged when it has no `\score` block.
 */
export function withMidiOutput(source: string): string {
  const inserts: number[] = []
  // Open braces of `\score` blocks still waiting for their closing brace.
  const scores: number[] = []
  let depth = 0
  let scorePending = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (char === '%') {
      const block = source[i + 1] === '{'
      const end = block ? source.indexOf('%}', i + 2) : source.indexOf('\n', i)
      if (end < 0) break
      i = block ? end + 1 : end
    } else if (char === '"') {
      for (i++; i < source.length && source[i] !== '"'; i++)
        if (source[i] === '\\') i++
    } else if (char === '\\') {
      const name = /^[A-Za-z]+/.exec(source.slice(i + 1))?.[0] ?? ''
      if (name === 'score') scorePending = true
      i += Math.max(name.length, 1)
    } else if (char === '{') {
      depth++
      if (scorePending) scores.push(depth)
      scorePending = false
    } else if (char === '}') {
      if (scores.at(-1) === depth) {
        scores.pop()
        inserts.push(i)
      }
      depth--
    }
  }
  let result = source
  for (const at of inserts.reverse())
    result = `${result.slice(0, at)} \\midi { } ${result.slice(at)}`
  return result
}
