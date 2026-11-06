import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Review } from '../shared/protocol.ts'
import {
  describeSystem,
  isEdited,
  stripSystemMarkers,
  systemCrops,
  systemRanges,
  systemText,
} from '../shared/review.ts'

const score = (first = "c'4 d' e' f' |") =>
  [
    '\\version "2.24.4"', // 1
    '\\score {', // 2
    '<<', // 3
    '\\new Staff {', // 4
    '    % system 1', // 5
    `    ${first}`, // 6
    '    % system 2', // 7
    '    \\break', // 8
    "    g'1 |", // 9
    '  }', // 10
    '\\new Staff {', // 11
    '    % system 1', // 12
    '    c1 |', // 13
    '    % system 2', // 14
    '    d1 |', // 15
    '  }', // 16
    '>>', // 17
    '}', // 18
  ].join('\n')

const review = (source: string): Review => ({
  source,
  systems: [
    {
      system: 1,
      confidence: 0.7,
      flags: ['Bar 1 adds up to 5/4, not 1'],
      staves: 2,
      reviewed: false,
    },
    { system: 2, confidence: 0.9, flags: [], staves: 2, reviewed: false },
  ],
})

const anchor = (page: number, system: number, line: number, y: number) => ({
  page,
  system,
  line,
  y,
  height: 4,
})

test('a system has a range of lines in every staff', () => {
  assert.deepEqual(systemRanges(score()).get(1), [
    { start: 6, end: 6 },
    { start: 13, end: 13 },
  ])
  assert.deepEqual(systemRanges(score()).get(2), [
    { start: 8, end: 9 },
    { start: 15, end: 15 },
  ])
})

test('a score without markers has no systems', () => {
  assert.equal(systemRanges("{ c'4 }").size, 0)
})

test('an edit marks only the system it touched', () => {
  const edited = score("c'4 d' e' g' |")
  assert.equal(isEdited(review(score()), 1, edited), true)
  assert.equal(isEdited(review(score()), 2, edited), false)
})

test('moving lines around without changing the music is not an edit', () => {
  const moved = `% a comment on top\n\n${score().replace("c'4 d' e' f' |", "c'4   d' e' f' |")}`
  assert.equal(isEdited(review(score()), 1, moved), false)
  assert.equal(systemText(score(), 2), "g'1 | d1 |")
})

test('a system that lost its marker counts as edited', () => {
  const lost = score().replace(/ *% system 2\n/g, '')
  assert.equal(isEdited(review(score()), 2, lost), true)
  assert.equal(systemRanges(lost).get(2), undefined)
})

test('the model is told where the scan belongs and what is in doubt', () => {
  const note = describeSystem(review(score()), 1, score())
  assert.match(note, /scan of system 1, which is on lines 6-6, 13-13/)
  assert.match(note, /Bar 1 adds up to 5\/4, not 1/)
  assert.doesNotMatch(describeSystem(review(score()), 2, score()), /doubts/)
})

test('finishing removes the markers and nothing else', () => {
  const stripped = stripSystemMarkers(score())
  assert.doesNotMatch(stripped, /% system/)
  assert.match(stripped, /\\break/)
  assert.match(stripped, /g'1 \|/)
})

test('a crop spans everything engraved in the systems a marker reached', () => {
  const anchors = [
    anchor(0, 0, 6, 20),
    anchor(0, 0, 13, 40),
    anchor(0, 1, 9, 80),
    anchor(1, 0, 15, 10),
  ]
  assert.deepEqual(systemCrops(systemRanges(score()).get(1)!, anchors), [
    { page: 0, y: 18, height: 28 },
  ])
  // An edit pushed system 2 over a page turn: it shows both pieces.
  assert.deepEqual(
    systemCrops(systemRanges(score()).get(2)!, anchors).map(({ page }) => page),
    [0, 1],
  )
})

test('a crop stops halfway to a system that comes close', () => {
  const anchors = [
    anchor(0, 0, 6, 20), // Down to 24.
    anchor(0, 1, 9, 25), // From 25, closer than the padding.
  ]
  const [crop] = systemCrops(systemRanges(score()).get(1)!, anchors)
  assert.equal(crop!.y + crop!.height, 24.5)
  const [next] = systemCrops(systemRanges(score()).get(2)!, anchors)
  assert.equal(next!.y, 24.5)
})

test('nothing engraved means no crops', () => {
  assert.deepEqual(systemCrops(systemRanges(score()).get(1)!, []), [])
})
