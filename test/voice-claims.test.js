import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimTab, claimOf, holderOf, releasePanel, releaseTab, tabHolder } from '../src/sessions/voice-claims.js';

// The claim is what keeps two commands off the same page. It lives in the
// worker, so the panel that holds it is the only one that may use it.

test('two commands cannot hold the same tab at the same time', () => {
  const first = claimTab(11, { panelId: 'panel-a', sessionId: 'session-a' });
  const second = claimTab(11, { panelId: 'panel-b', sessionId: 'session-a' });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false, 'the second claim is refused');
  assert.equal(second.owner, 'voice control', 'the one that holds it is named');
  assert.equal(claimOf(11)?.panelId, 'panel-a', 'the first claim is still the one that holds it');
});

test('the panel that holds the claim may take it again', () => {
  assert.equal(claimTab(12, { panelId: 'panel-a', sessionId: 'session-a' }).ok, true);
  assert.equal(claimTab(12, { panelId: 'panel-a', sessionId: 'session-a' }).ok, true);
  assert.equal(claimTab(12, { panelId: 'panel-b', sessionId: 'session-b' }).ok, false);
});

test('a claim is given back by the panel that holds it, and by nobody else', () => {
  claimTab(13, { panelId: 'panel-a', sessionId: 'session-a' });
  assert.equal(releaseTab(13, 'panel-b'), false, 'another panel cannot give it back');
  assert.ok(claimOf(13), 'the claim is still held');
  assert.equal(releaseTab(13, 'panel-a'), true);
  assert.equal(claimOf(13), null, 'the tab is free again');
});

test('a panel that goes away gives every claim it holds back', () => {
  claimTab(14, { panelId: 'panel-a', sessionId: 'session-a' });
  claimTab(15, { panelId: 'panel-a', sessionId: 'session-a' });
  claimTab(16, { panelId: 'panel-b', sessionId: 'session-b' });

  releasePanel('panel-a');

  assert.equal(claimOf(14), null);
  assert.equal(claimOf(15), null);
  assert.ok(claimOf(16), 'the claim of the other panel is untouched');
});

test('a regular runner sees a tab that the voice path holds', () => {
  claimTab(17, { panelId: 'panel-a', sessionId: 'session-a' });
  const tab = { id: 17 };

  // No other session is working in the tab, but the voice path holds it.
  assert.equal(tabHolder(() => null, tab, { sessionId: 'session-b' }), 'voice control');
  assert.equal(holderOf(17), 'voice control');
});

test('the panel that holds the claim does not see its own tab as taken', () => {
  claimTab(18, { panelId: 'panel-a', sessionId: 'session-a' });
  const tab = { id: 18 };

  assert.equal(tabHolder(() => null, tab, { sessionId: 'session-a', exceptPanelId: 'panel-a' }), null);
  assert.equal(tabHolder(() => null, tab, { sessionId: 'session-a', exceptPanelId: 'panel-b' }), 'voice control');
});

test('a session that is working in a tab is named before the voice claim', () => {
  claimTab(19, { panelId: 'panel-a', sessionId: 'session-a' });
  const tab = { id: 19 };

  assert.equal(tabHolder(() => 'other session', tab, { sessionId: 'session-b' }), 'other session');
});
