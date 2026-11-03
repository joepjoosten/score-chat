import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { defaultPrefs } from '../src/model.ts'
import {
  DOCUMENTS_KEY,
  LEGACY_SCORE_KEY,
  PREFS_KEY,
  isLocalId,
  readLocalDocuments,
  readPrefs,
} from '../src/storage.ts'

const storage = (values: Record<string, string>) => ({
  getItem: (key: string) => values[key] ?? null,
})

describe('preferences', () => {
  it('restores valid preferences and drops what older versions stored', () => {
    const stored = {
      apiKey: 'test-key',
      model: 'provider/model',
      view: 'source',
      pages: 'inline',
      dock: { width: 420, height: 300 },
      corner: 'top-left',
    }
    assert.deepEqual(
      readPrefs(storage({ [PREFS_KEY]: JSON.stringify(stored) })),
      {
        view: 'source',
        pages: 'inline',
        dock: { width: 420, height: 300 },
        corner: 'top-left',
      },
    )
  })
  for (const raw of [
    '{broken',
    '{"view":"unknown","corner":"middle"}',
    '{"dock":{"width":"wide"}}',
  ]) {
    it(`falls back to defaults for missing or corrupt values: ${raw}`, () => {
      assert.deepEqual(readPrefs(storage({ [PREFS_KEY]: raw })), defaultPrefs)
    })
  }
  it('remains usable when browser storage throws', () => {
    assert.deepEqual(
      readPrefs({
        getItem: () => {
          throw new Error('blocked')
        },
      }),
      defaultPrefs,
    )
  })
})

describe('local documents', () => {
  it('lists the newest first', () => {
    const documents = [
      { id: 'local-a', title: 'A', source: 'a', updatedAt: 1 },
      { id: 'local-b', title: 'B', source: 'b', updatedAt: 2 },
    ]
    assert.deepEqual(
      readLocalDocuments(
        storage({ [DOCUMENTS_KEY]: JSON.stringify(documents) }),
      ).map((doc) => doc.id),
      ['local-b', 'local-a'],
    )
  })
  it('turns the single score of earlier versions into a document', () => {
    const [document] = readLocalDocuments(
      storage({ [LEGACY_SCORE_KEY]: '\\header { title = "Old tune" }' }),
      5,
    )
    assert.ok(document && isLocalId(document.id))
    assert.equal(document.title, 'Old tune')
    assert.equal(document.updatedAt, 5)
  })
  it('recovers from corrupt storage', () => {
    assert.deepEqual(
      readLocalDocuments(storage({ [DOCUMENTS_KEY]: '[{"id":1}]' })),
      [],
    )
  })
})
