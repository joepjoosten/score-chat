import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { checkScore, classifyErrors } from '../server/renderer/check.js'
import { formatDiagnostics } from '../server/tools.ts'

// The server reads these from the static assets; here, from public/.
const asset = async (path: string, binary: boolean) => {
  const file = await readFile(
    new URL(`../public/renderer/${path}`, import.meta.url),
  )
  return binary
    ? file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength)
    : file.toString('utf8')
}
const simple = await readFile(
  new URL('./browser/simple-score.ly', import.meta.url),
  'utf8',
)

describe('the server check', () => {
  it('accepts a supported score', async () => {
    assert.deepEqual(await checkScore(simple, asset), {
      ok: true,
      diagnostics: [],
    })
  })
  it('calls a misspelt command invalid and suggests the spelling', async () => {
    const result = await checkScore(simple.replace('\\clef', '\\cleff'), asset)
    assert.equal(result.ok, false)
    const [typo] = result.diagnostics
    assert.equal(typo?.category, 'invalid')
    assert.deepEqual(typo?.position, {
      line: 10,
      column: 5,
      endLine: 10,
      endColumn: 11,
    })
    assert.equal(typo?.hint, 'Did you mean \\clef?')
    assert.match(
      formatDiagnostics(result.diagnostics),
      /^Line 10, column 5 \(not valid LilyPond, fix the source\): Unknown command \\cleff.* Hint: Did you mean \\clef\?$/,
    )
  })
  it('reports a wrong version and still checks the rest', async () => {
    const result = await checkScore(
      simple.replace('2.24.4', '2.22.0').replace('\\clef', '\\cleff'),
      asset,
    )
    assert.deepEqual(
      result.diagnostics.map((diagnostic) => diagnostic.category).sort(),
      ['invalid', 'unsupported'],
    )
  })
  it('calls unbalanced braces a syntax error', async () => {
    const result = await checkScore(simple.replace('}', ''), asset)
    assert.equal(result.diagnostics[0]?.category, 'syntax')
  })
  it('classifies the browser’s engraving errors, without command-line advice', () => {
    const result = classifyErrors(simple, [
      'V2 renderer engraving: text font metrics are unavailable for "ő"',
    ])
    assert.equal(result.diagnostics[0]?.category, 'unsupported')
    assert.match(
      formatDiagnostics(result.diagnostics),
      /Score Chat cannot add text fonts/,
    )
    assert.doesNotMatch(formatDiagnostics(result.diagnostics), /--font-dir/)
  })
})
