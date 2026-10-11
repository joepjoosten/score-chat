import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { withMidiOutput } from '../src/midi.ts'

describe('withMidiOutput', () => {
  it('adds a MIDI block before the closing brace of every score', () => {
    assert.equal(
      withMidiOutput('\\score { c4 \\layout { } }\n\\score { d4 }'),
      '\\score { c4 \\layout { }  \\midi { } }\n\\score { d4  \\midi { } }',
    )
  })

  it('keeps earlier lines and columns in place', () => {
    const source = '\\score {\n  { c4 d e f }\n}\n\\score { g1 }'
    const result = withMidiOutput(source)
    assert.deepEqual(
      result.split('\n').slice(0, 2),
      source.split('\n').slice(0, 2),
    )
    assert.equal(result.split('\n').length, source.split('\n').length)
  })

  it('finds scores inside books', () => {
    assert.equal(
      withMidiOutput('\\book { \\score { c4 } }'),
      '\\book { \\score { c4  \\midi { } } }',
    )
  })

  it('ignores braces in comments and strings', () => {
    assert.equal(
      withMidiOutput('\\score { % }\n c4^"}" %{ } %} }'),
      '\\score { % }\n c4^"}" %{ } %}  \\midi { } }',
    )
  })

  it('leaves music outside a score alone', () => {
    const source = "\\relative c' { c4 d e f }"
    assert.equal(withMidiOutput(source), source)
  })
})
