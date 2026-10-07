import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyEdits, readLines, searchLines } from '../src/harness/scoreText.ts'
import { appendChunk } from '../src/state.ts'
import type { Message } from '../src/state.ts'

const source = 'a b\nc d\ne f\nc g\nh'

describe('readLines', () => {
  it('numbers the whole source or a clamped range', () => {
    assert.equal(
      readLines(source),
      'Lines 1–5 of 5:\n1\ta b\n2\tc d\n3\te f\n4\tc g\n5\th',
    )
    assert.equal(readLines(source, 4, 99), 'Lines 4–5 of 5:\n4\tc g\n5\th')
    assert.match(readLines(source, 9, 10), /No lines in that range/)
  })
})

describe('searchLines', () => {
  it('finds case-insensitive text and merges context ranges', () => {
    assert.equal(
      searchLines(source, 'C '),
      '2 matching line(s):\n2\tc d\n4\tc g',
    )
    assert.equal(
      searchLines(source, 'c', { context: 1 }),
      '2 matching line(s):\n1\ta b\n2\tc d\n3\te f\n4\tc g\n5\th',
    )
    assert.equal(
      searchLines(source, 'a', { context: 0 }) + '|' + searchLines(source, 'h'),
      '1 matching line(s):\n1\ta b|1 matching line(s):\n5\th',
    )
  })
  it('supports regular expressions and reports bad ones', () => {
    assert.equal(
      searchLines(source, '^[ae] ', { regex: true }),
      '2 matching line(s):\n1\ta b\n3\te f',
    )
    assert.match(searchLines(source, '(', { regex: true }), /Invalid regular/)
    assert.match(searchLines(source, 'zzz'), /No lines match/)
  })
})

describe('applyEdits', () => {
  it('applies unique replacements in order', () => {
    assert.deepEqual(
      applyEdits(source, [
        { old_text: 'a b', new_text: 'x' },
        { old_text: 'x\nc d', new_text: 'y $&' },
      ]),
      { source: 'y $&\ne f\nc g\nh' },
    )
  })
  it('rejects missing or ambiguous text without partial changes', () => {
    const missing = applyEdits(source, [{ old_text: 'q', new_text: '' }])
    assert.ok('error' in missing)
    assert.match(missing.error, /not found/)
    const ambiguous = applyEdits(source, [
      { old_text: 'a b', new_text: 'z' },
      { old_text: 'c ', new_text: 'C ' },
    ])
    assert.ok('error' in ambiguous)
    assert.match(ambiguous.error, /^Edit 2: .*matches 2 places/)
    assert.deepEqual(
      applyEdits(source, [
        { old_text: 'c ', new_text: 'C ', replace_all: true },
      ]),
      { source: 'a b\nC d\ne f\nC g\nh' },
    )
  })
})

describe('appendChunk', () => {
  it('groups streamed chunks into ordered parts and keeps reply text separate', () => {
    let message: Message = { id: '1', role: 'assistant', text: '' }
    for (const [type, chunk] of [
      ['thinking', 'Let me '],
      ['thinking', 'look.'],
      ['text', 'Done'],
      ['thinking', 'Again'],
      ['text', '!'],
    ] as const)
      message = appendChunk(message, type, chunk)
    assert.equal(message.text, 'Done!')
    assert.deepEqual(message.parts, [
      { type: 'thinking', text: 'Let me look.' },
      { type: 'text', text: 'Done' },
      { type: 'thinking', text: 'Again' },
      { type: 'text', text: '!' },
    ])
  })
})
