import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pageError, pageErrorKey, selectAllChord } from '../src/voice/voice-input.js';

// The parts of the trusted input path that belong to the worker: the chord
// that selects everything in a field is the platform's own, and a page failure
// carries the key the panel translates.

test('the chord that selects everything is the one of the platform', () => {
  assert.equal(selectAllChord({ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh)' }), 'Meta+A');
  assert.equal(selectAllChord({ platform: '', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }), 'Meta+A');
  assert.equal(selectAllChord({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }), 'Control+A');
  assert.equal(selectAllChord({ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' }), 'Control+A');
  assert.equal(selectAllChord({}), 'Control+A', 'a platform that does not say anything gets the usual chord');
  assert.equal(selectAllChord(null), 'Control+A');
});

test('a page failure carries the key the panel translates', () => {
  const error = pageError('voice.pageFocusLost');
  assert.equal(error.code, 'voice.pageFocusLost');
  assert.equal(pageErrorKey(error), 'voice.pageFocusLost');
  assert.equal(pageErrorKey(new Error('voice.pageGone')), 'voice.pageGone');
  assert.equal(pageErrorKey(new Error('something else')), null);
  assert.equal(pageErrorKey(null), null);
});
