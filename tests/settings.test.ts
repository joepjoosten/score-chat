import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { defaults, readSettings } from '../src/state.ts'

describe('settings recovery', () => {
  it('restores validated preferences', () => {
    const settings = {
      apiKey: 'test-key',
      model: 'provider/model',
      view: 'source',
    }
    assert.deepEqual(
      readSettings({ getItem: () => JSON.stringify(settings) }),
      settings,
    )
  })
  for (const raw of [
    null,
    '{broken',
    '{"view":"unknown"}',
    '{"apiKey":123,"model":"a","view":"score"}',
  ]) {
    it(`recovers from missing or corrupt settings: ${raw}`, () => {
      assert.deepEqual(readSettings({ getItem: () => raw }), defaults)
    })
  }
  it('remains usable when browser storage throws', () => {
    assert.deepEqual(
      readSettings({
        getItem: () => {
          throw new Error('blocked')
        },
      }),
      defaults,
    )
  })
})
