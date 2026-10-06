import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  anchorKey,
  anchorsInBox,
  describeSelection,
  dragBox,
  markerStrokes,
  selectedNotes,
} from '../src/selection.ts'
import type { Anchor } from '../src/selection.ts'

const note = (
  line: number,
  column: number,
  endColumn: number,
  x: number,
  y = 30,
  system = 0,
): Anchor => ({
  kind: 'note',
  page: 0,
  system,
  x,
  y,
  width: 1.3,
  height: 1.1,
  line,
  column,
  endLine: line,
  endColumn,
})
const source = ["\\relative c' {", '  c4\\p e g e |', '  f4 a g2 |', '}'].join(
  '\n',
)
// Columns are 1-based: `c4` starts at column 3 on line 2.
const anchors = [
  note(2, 3, 5, 10),
  note(2, 8, 9, 16),
  note(2, 10, 11, 22),
  note(2, 12, 13, 28),
  note(3, 3, 5, 10, 50, 1),
]

describe('marker selection', () => {
  it('selects the notes a swipe covers', () => {
    const box = dragBox({ x: 15, y: 28 }, { x: 23, y: 33 })
    assert.deepEqual(anchorsInBox(anchors, box, 0).map(anchorKey), [
      '2:8',
      '2:10',
    ])
    assert.deepEqual(anchorsInBox(anchors, box, 1), [])
  })
  it('treats a tiny swipe as a tap on the nearest note', () => {
    const tap = dragBox({ x: 16.9, y: 30.5 }, { x: 17, y: 30.6 })
    assert.deepEqual(anchorsInBox(anchors, tap, 0).map(anchorKey), ['2:8'])
    assert.deepEqual(
      anchorsInBox(anchors, dragBox({ x: 40, y: 30 }, { x: 40, y: 30 }), 0),
      [],
    )
  })
  it('draws one stroke per system around the highlighted notes', () => {
    const strokes = markerStrokes(anchors, new Set(['2:3', '2:12', '3:3']), 0)
    assert.equal(strokes.length, 2)
    const [first, second] = strokes
    assert.ok(first.x < 10 && first.x + first.width > 29.3)
    assert.ok(second.y < 50 && second.y + second.height > 51.1)
  })
  it('resolves highlighted notes to source text in document order', () => {
    const notes = selectedNotes(anchors, new Set(['3:3', '2:8', '2:3']), source)
    assert.deepEqual(
      notes.map((n) => [n.line, n.column, n.text]),
      [
        [2, 3, 'c4'],
        [2, 8, 'e'],
        [3, 3, 'f4'],
      ],
    )
  })
  it('describes the selection with 1-based positions for the model', () => {
    const text = describeSelection(
      selectedNotes(anchors, new Set(['2:3', '2:8']), source),
    )
    assert.match(text, /highlighted 2 notes/)
    assert.match(text, /line 2, columns 3-4: `c4`/)
    assert.match(text, /line 2, columns 8-8: `e`/)
    assert.equal(describeSelection([]), '')
  })
})
