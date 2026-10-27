import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  claimTab,
  claimOf,
  holderOf,
  isAuthorized,
  releaseTab,
  revokePanel,
  revokeTab,
  tabHolder,
} from '../src/sessions/voice-claims.js';

// The claim is what keeps two commands off the same page. It lives in the
// worker, so the panel that holds it is the only one that may use it.
//
// A claim is given back in two steps: the authorization goes first, and the
// tab stays busy until the input that is still running has drained. The tests
// below follow both steps.

test('a malformed panel identity cannot create an unreleasable lease', () => {
  for (const panelId of [undefined, null, '', '   ', 12]) {
    assert.equal(claimTab(99010, { panelId }).ok, false);
    assert.equal(claimOf(99010), null);
  }
});

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

test('another command of the same panel may not take a lease that is still held', () => {
  const first = claimTab(1200, { panelId: 'panel-a', sessionId: 'session-a', commandId: 'cmd-1' });
  assert.equal(first.ok, true);

  // The same command may take it again: it keeps its token.
  const same = claimTab(1200, { panelId: 'panel-a', sessionId: 'session-a', commandId: 'cmd-1' });
  assert.equal(same.ok, true);
  assert.equal(same.token, first.token, 'the same command keeps the same lease');

  // Another command of the same panel may not: the tab is busy until the old
  // lease is given back and its cleanup is over.
  const other = claimTab(1200, { panelId: 'panel-a', sessionId: 'session-a', commandId: 'cmd-2' });
  assert.equal(other.ok, false, 'the second command is refused');
  assert.equal(claimOf(1200)?.commandId, 'cmd-1', 'the first command still holds the lease');

  // The late cleanup of the first command frees the lease it held, and there
  // is no lease of the second command that it could free.
  assert.equal(releaseTab(1200, { panelId: 'panel-a', token: first.token }), true);
  assert.equal(claimOf(1200), null, 'the tab is free again');
});

test('another session of the same panel may not take a lease that is still held', () => {
  const first = claimTab(1201, { panelId: 'panel-a', sessionId: 'session-a', commandId: 'cmd-1' });
  assert.equal(first.ok, true);
  const other = claimTab(1201, { panelId: 'panel-a', sessionId: 'session-b', commandId: 'cmd-1' });
  assert.equal(other.ok, false, 'the lease of another session is not this panel\'s to take');
  assert.equal(claimOf(1201)?.sessionId, 'session-a', 'the first session still holds the lease');
  assert.equal(releaseTab(1201, { panelId: 'panel-a', token: first.token }), true);
});

test('a lease that was taken without a command belongs to the first command that claims it', () => {
  const first = claimTab(1202, { panelId: 'panel-a', sessionId: 'session-a' });
  assert.equal(first.ok, true);
  const tagged = claimTab(1202, { panelId: 'panel-a', sessionId: 'session-a', commandId: 'cmd-1' });
  assert.equal(tagged.ok, true);
  assert.equal(tagged.token, first.token);
  assert.equal(claimOf(1202)?.commandId, 'cmd-1', 'the lease belongs to the command that claimed it');
  assert.equal(releaseTab(1202, { panelId: 'panel-a', token: first.token }), true);
});

test('a claim is given back by the panel that holds it, and by nobody else', () => {
  const { token } = claimTab(13, { panelId: 'panel-a', sessionId: 'session-a' });
  assert.equal(releaseTab(13, { panelId: 'panel-b', token }), false, 'another panel cannot give it back');
  assert.ok(claimOf(13), 'the claim is still held');
  assert.equal(releaseTab(13, { panelId: 'panel-a', token }), true);
  assert.equal(claimOf(13), null, 'the tab is free again');
});

test('a panel that goes away gives every claim it holds back', () => {
  claimTab(140, { panelId: 'panel-x', sessionId: 'session-a' });
  claimTab(150, { panelId: 'panel-x', sessionId: 'session-a' });
  claimTab(160, { panelId: 'panel-y', sessionId: 'session-b' });

  const revoked = revokePanel('panel-x');

  assert.deepEqual(revoked.map((lease) => lease.tabId).sort(), [140, 150], 'both claims of the panel are withdrawn');
  assert.ok(claimOf(160), 'the claim of the other panel is untouched');

  // The tabs stay busy until their cleanup is over, and then they are free.
  for (const lease of revoked) releaseTab(lease.tabId, { panelId: 'panel-x', token: lease.token });
  assert.equal(claimOf(140), null);
  assert.equal(claimOf(150), null);
  assert.ok(claimOf(160), 'the claim of the other panel is untouched');
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

test('a revoked claim is busy until it is given back, for everybody', () => {
  const { token } = claimTab(20, { panelId: 'panel-a', sessionId: 'session-a' });

  assert.equal(revokeTab(20, { panelId: 'panel-a', token }).state, 'revoking');

  // The panel itself sees the tab as busy: its old input may still be running.
  assert.equal(holderOf(20, { exceptPanelId: 'panel-a' }), 'voice control');
  assert.equal(holderOf(20), 'voice control');
  // Another panel may not take it either.
  assert.equal(claimTab(20, { panelId: 'panel-b', sessionId: 'session-b' }).ok, false);
  // The panel that holds it may not take it again either, not while it is
  // still being cleaned up.
  assert.equal(claimTab(20, { panelId: 'panel-a', sessionId: 'session-a' }).ok, false);
  // And no input may be sent under it any more.
  assert.equal(isAuthorized(20, { panelId: 'panel-a', token }), false);

  assert.equal(releaseTab(20, { panelId: 'panel-a', token }), true);
  assert.equal(holderOf(20), null, 'the tab is free again');
  assert.equal(claimTab(20, { panelId: 'panel-b', sessionId: 'session-b' }).ok, true, 'another panel may take it now');
});

test('a cleanup that arrives late cannot give back a lease that replaced it', () => {
  const first = claimTab(21, { panelId: 'panel-a', sessionId: 'session-a' });
  assert.equal(releaseTab(21, { panelId: 'panel-a', token: first.token }), true);

  // The tab is taken again by somebody else.
  const second = claimTab(21, { panelId: 'panel-b', sessionId: 'session-b' });
  assert.equal(second.ok, true);

  // The old cleanup arrives now: it must not touch the new lease.
  assert.equal(releaseTab(21, { panelId: 'panel-a', token: first.token }), false);
  assert.equal(claimOf(21)?.panelId, 'panel-b', 'the new lease still holds the tab');
  assert.equal(isAuthorized(21, { panelId: 'panel-a', token: first.token }), false);
  assert.equal(isAuthorized(21, { panelId: 'panel-b', token: second.token }), true);
});

test('an input that waits for a lease that was given back may not run', () => {
  const { token } = claimTab(22, { panelId: 'panel-a', sessionId: 'session-a' });
  assert.equal(isAuthorized(22, { panelId: 'panel-a', token }), true);
  revokeTab(22, { panelId: 'panel-a', token });
  assert.equal(isAuthorized(22, { panelId: 'panel-a', token }), false, 'a withdrawn lease may not send anything');
});

test('the panel that goes away may not release a lease of another panel', () => {
  claimTab(230, { panelId: 'panel-y', sessionId: 'session-b' });
  revokePanel('panel-x');
  assert.ok(claimOf(230), 'the lease of the other panel is untouched');
});

test('a lease is used only by the panel that holds it and only under its token', () => {
  const { token } = claimTab(240, { panelId: 'panel-a', sessionId: 'session-a' });

  assert.equal(isAuthorized(240, { panelId: 'panel-a', token }), true, 'the holder may use it');
  assert.equal(isAuthorized(240, { panelId: 'panel-a' }), false, 'a request without a token may not');
  assert.equal(isAuthorized(240, { token }), false, 'a request without a panel may not');
  assert.equal(isAuthorized(240, {}), false, 'a request without either may not');
  assert.equal(isAuthorized(240, { panelId: 'panel-b', token }), false, 'another panel may not');
});

test('a lease is withdrawn and given back only under its token and its panel', () => {
  const { token } = claimTab(241, { panelId: 'panel-a', sessionId: 'session-a' });

  assert.equal(revokeTab(241, { panelId: 'panel-a' }), null, 'a request without a token withdraws nothing');
  assert.equal(revokeTab(241, { token }), null, 'a request without a panel withdraws nothing');
  assert.equal(revokeTab(241, { panelId: 'panel-b', token }), null, 'another panel withdraws nothing');
  assert.equal(claimOf(241)?.state, 'active', 'the lease is still authorized');

  assert.equal(releaseTab(241, { panelId: 'panel-a' }), false, 'a request without a token frees nothing');
  assert.equal(releaseTab(241, { token }), false, 'a request without a panel frees nothing');
  assert.equal(releaseTab(241, { panelId: 'panel-b', token }), false, 'another panel frees nothing');
  assert.ok(claimOf(241), 'the lease is still held');

  assert.equal(revokeTab(241, { panelId: 'panel-a', token }).state, 'revoking', 'the holder may withdraw it');
  assert.equal(releaseTab(241, { panelId: 'panel-a', token }), true, 'the holder may give it back');
  assert.equal(claimOf(241), null);
});

test('a cleanup that arrives late cannot free a replacement, even with the panel that held it', () => {
  const first = claimTab(242, { panelId: 'panel-a', sessionId: 'session-a' });
  assert.equal(releaseTab(242, { panelId: 'panel-a', token: first.token }), true);

  const second = claimTab(242, { panelId: 'panel-a', sessionId: 'session-a' });
  assert.notEqual(second.token, first.token, 'the new lease has its own token');

  assert.equal(releaseTab(242, { panelId: 'panel-a', token: first.token }), false, 'the old token frees nothing');
  assert.equal(revokeTab(242, { panelId: 'panel-a', token: first.token }), null, 'the old token withdraws nothing');
  assert.ok(claimOf(242), 'the new lease still holds the tab');
  assert.equal(isAuthorized(242, { panelId: 'panel-a', token: second.token }), true);
});
