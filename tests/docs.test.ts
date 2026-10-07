import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createDocsIndex,
  formatSearchResults,
  readDoc,
  searchDocs,
  tokenize,
} from '../src/harness/docs.ts'
import type { Doc } from '../src/harness/docs.ts'

const doc = (id: string, fields: Partial<Doc>): Doc => ({
  id,
  kind: 'notation',
  title: id,
  path: [],
  keywords: [],
  text: '',
  examples: [0, 0],
  ...fields,
})
const docs = [
  doc('dynamics', {
    title: 'Dynamics',
    path: ['Musical notation', 'Expressive marks'],
    keywords: ['\\<', 'crescendo', 'hairpin'],
    text: 'A crescendo mark is started with `\\<` and ended with `\\!`.',
    examples: [2, 3],
  }),
  doc('glossary/crescendo', {
    kind: 'glossary',
    title: 'crescendo',
    text: 'Increasing volume.',
  }),
  doc('snippet/tuplets', {
    kind: 'snippet',
    title: 'Tuplet numbers',
    text: 'Use \\tuplet 3/2 for triplets.\n\n' + 'x\n'.repeat(20_000),
  }),
]
const index = createDocsIndex(docs)

describe('docs search', () => {
  it('keeps LilyPond commands and their bare words', () => {
    assert.deepEqual(tokenize('Use \\Tuplet 3/2'), [
      'use',
      '\\tuplet',
      'tuplet',
      '3',
      '2',
    ])
  })
  it('ranks titles and index entries and filters by kind', () => {
    assert.deepEqual(
      searchDocs(index, 'crescendo').map(({ doc }) => doc.id),
      ['glossary/crescendo', 'dynamics'],
    )
    assert.deepEqual(
      searchDocs(index, 'crescendo hairpin', { kind: 'notation' }).map(
        ({ doc }) => doc.id,
      ),
      ['dynamics'],
    )
    assert.equal(searchDocs(index, '\\tuplet')[0].doc.id, 'snippet/tuplets')
  })
  it('formats results with ids, paths, example support and excerpts', () => {
    assert.equal(
      formatSearchResults(index, 'hairpin'),
      [
        'Top 1 results for "hairpin" (read one with read_doc):',
        '1. Dynamics [notation] id: dynamics',
        '   Musical notation › Expressive marks',
        '   2 of 3 examples render in Score Chat',
        '   A crescendo mark is started with `\\<` and ended with `\\!`.',
      ].join('\n'),
    )
    assert.match(formatSearchResults(index, 'zzz'), /^No documentation/)
  })
  it('reads documents in pages at line breaks', () => {
    const first = readDoc(index, 'snippet/tuplets')
    const offset = Number(/offset (\d+)/.exec(first)?.[1])
    assert.ok(offset > 11_000 && offset <= 12_000)
    assert.ok(first.startsWith('# Tuplet numbers\nLilyPond 2.24.4 snippets'))
    assert.doesNotMatch(readDoc(index, 'snippet/tuplets', 39_000), /Continues/)
    assert.match(readDoc(index, 'nope'), /No document has the id/)
  })
})
