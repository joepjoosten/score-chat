import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  errorMessage,
  locateErrors,
  markErrors,
  offsetOf,
} from '../src/sourceErrors.ts'

test('marks every use of the command or identifier a render error names', () => {
  const source = '{ c4 \\foo d \\foobar \\foo }\nhello = 1\n\\hello'
  const errors = locateErrors(source, [
    'V2 renderer parse: Unsupported LilyPond command `\\foo`; preserved as a parser stub.; Unresolved music identifier `hello`; preserved as a parser stub.; Expected `}` to close sequential music.',
  ])
  assert.deepEqual(
    errors.map(({ from, to }) => source.slice(from, to)),
    ['\\foo', '\\foo', 'hello'],
  )
  assert.equal(errors[0].message, 'Unsupported LilyPond command `\\foo`.')
  assert.equal(errors[2].message, 'Unresolved music identifier `hello`.')
})

test('errors without a named command mark nothing', () => {
  assert.deepEqual(
    locateErrors('{ c4', ['Expected `}` to close sequential music.']),
    [],
  )
})

test('positioned errors are marked exactly, the rest by the name they give', () => {
  const source = '\\version "2.24.4"\n{ c4 d\n  \\foo e f }\n\\bar'
  const marks = markErrors(
    source,
    [
      'V2 renderer parse: Unsupported LilyPond command `\\foo`; preserved as a parser stub.',
      'V2 renderer parse: Unsupported LilyPond command `\\bar`; preserved as a parser stub.',
    ],
    [{ line: 3, column: 3, endLine: 3, endColumn: 7 }, null],
  )
  assert.deepEqual(
    marks.map(({ from, to }) => source.slice(from, to)),
    ['\\foo', '\\bar'],
  )
  assert.equal(
    marks[0].message,
    'Unsupported LilyPond command `\\foo`; preserved as a parser stub.',
  )
})

test('a zero-width position is a point, and positions are clamped to the source', () => {
  const source = '{ c4\n'
  const [mark] = markErrors(
    source,
    ['Expected `}`.'],
    [{ line: 2, column: 1, endLine: 2, endColumn: 1 }],
  )
  assert.deepEqual([mark.from, mark.to], [5, 5])
  assert.equal(offsetOf(source, 1, 99), 4)
  assert.equal(offsetOf(source, 9, 1), source.length)
})

test('error messages drop the renderer stage prefix', () => {
  assert.equal(
    errorMessage(
      'V2 renderer music-validation: unsupported text markup command: foo.',
    ),
    'unsupported text markup command: foo.',
  )
})
