import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextWindowFor } from '../src/lib/context-window.js';

test('known model families resolve to their approximate context window', () => {
  assert.equal(contextWindowFor('gpt-5'), 400000);
  assert.equal(contextWindowFor('gpt-4.1-mini'), 1000000);
  assert.equal(contextWindowFor('gpt-4o'), 128000);
  assert.equal(contextWindowFor('o3'), 200000);
  assert.equal(contextWindowFor('claude-sonnet-4-5'), 200000);
  assert.equal(contextWindowFor('gemini-3-flash'), 1000000);
  assert.equal(contextWindowFor('grok-4'), 256000);
  assert.equal(contextWindowFor('kimi-k3'), 256000);
  assert.equal(contextWindowFor('glm-5.3'), 200000);
  assert.equal(contextWindowFor('MiniMax-M3.1-Flash'), 1000000);
  assert.equal(contextWindowFor('deepseek-chat'), 128000);
  assert.equal(contextWindowFor('qwen3-max'), 262144);
  assert.equal(contextWindowFor('nemotron-3.5-q8_0'), 128000);
});

test('a model the table does not know takes the conservative default', () => {
  assert.equal(contextWindowFor('apodex/apodex-1.1-mini:free'), 128000);
  assert.equal(contextWindowFor('some-brand-new-model-v99'), 128000);
  assert.equal(contextWindowFor(''), 128000);
  assert.equal(contextWindowFor(), 128000);
  assert.equal(contextWindowFor(null), 128000);
});
