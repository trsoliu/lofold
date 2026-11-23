import assert from 'node:assert/strict'
import test from 'node:test'
import { canonicalAddress, generationEndpoint, normalizeModel, readPreferences, validModelId } from '../src/ai-protocols.ts'

test('legacy compatible and Ollama settings keep their former model and active service', () => {
  const profile = { baseUrl: 'https://example.test/team/v1', model: 'old-model' }
  for (const [legacy, active] of [['compatible', 'chat_completions'], ['ollama', 'ollama']]) {
    assert.deepEqual(readPreferences(JSON.stringify({ provider: legacy, ...profile })), {
      active, profiles: { chat_completions: profile },
    })
  }
  assert.deepEqual(readPreferences(null), { active: 'ollama', profiles: {} })
})

test('service profiles retain independent models sharing the same canonical base', () => {
  const baseUrl = 'https://example.test/team/v1'
  const saved = { active: 'responses', profiles: {
    chat_completions: { baseUrl, model: 'first' }, responses: { baseUrl, model: 'second' },
    gemini: { baseUrl, model: 'models/gemini-test' },
  } }
  assert.deepEqual(readPreferences(JSON.stringify(saved)), {
    active: 'responses', profiles: { ...saved.profiles, gemini: { baseUrl, model: 'gemini-test' } },
  })
})

test('confirmation URLs retain custom paths and use the selected protocol', () => {
  const base = canonicalAddress('https://example.test:443/team/v1/')
  assert.equal(base, 'https://example.test/team/v1')
  for (const [protocol, suffix] of [['chat_completions', '/chat/completions'], ['responses', '/responses'],
    ['anthropic', '/messages'], ['gemini', '/models/example:generateContent']]) {
    assert.equal(generationEndpoint(protocol, base, 'models/example'), base + suffix)
  }
})

test('Gemini accepts one optional models/ prefix and rejects path delimiters before saving', () => {
  assert.equal(normalizeModel('gemini', 'models/example-1.0'), 'example-1.0')
  assert.ok(validModelId('gemini', 'models/' + 'a'.repeat(256)))
  for (const value of ['models/', '..', '.', 'models/models/nested', 'id?key=test', '../models/x', 'id:other', 'a'.repeat(257)]) {
    assert.equal(validModelId('gemini', value), false, value)
  }
  assert.equal(normalizeModel('responses', 'models/example'), 'models/example')
  assert.ok(validModelId('responses', 'vendor/model'))
})
