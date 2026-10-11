import { test } from 'node:test'
import assert from 'node:assert/strict'
import { locateErrors } from '../src/sourceErrors.ts'

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
