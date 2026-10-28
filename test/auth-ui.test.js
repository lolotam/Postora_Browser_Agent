import { test } from 'node:test';
import assert from 'node:assert/strict';

import { authMessage, authView, backupAuthView, changedProviders, withLoginEvent } from '../src/sidepanel/auth-ui.js';
import { setLanguage } from '../src/sidepanel/i18n.js';
import { errorResponse } from '../src/lib/errors.js';

// The panel's language, without a document to write it on.
const fakeDocument = { documentElement: {}, querySelectorAll: () => [] };

test('a code the worker sends becomes the wording of the panel', () => {
  assert.equal(authMessage('expired'), 'The sign-in expired. Please sign in again.');
  assert.equal(authMessage('failed'), 'The sign-in failed. Please try again.');
  // A code the panel has no wording for falls back to the worker's own text.
  assert.equal(authMessage('no-such-code', 'the worker text'), 'the worker text');
  assert.equal(authMessage('', 'the worker text'), 'the worker text');
});

test('the wording of a code is translated', () => {
  setLanguage('ar', fakeDocument);
  assert.equal(authMessage('cancelled'), 'تم إلغاء تسجيل الدخول.');
  assert.equal(authMessage('state-mismatch'), 'هذا الكود من محاولة تسجيل دخول أخرى. ابدأ من جديد، ثم الصق الكود الجديد.');
  assert.equal(authMessage('missing-code'), 'لم يُعثر على كود التفويض. الصق الكود كاملًا كما يظهر في صفحة تسجيل الدخول.');
  setLanguage('en', fakeDocument);
  assert.equal(authMessage('cancelled'), 'The sign-in was cancelled.');
  assert.equal(authMessage('state-mismatch'), 'That code is from a different sign-in. Start again, then paste the new code.');
  assert.equal(authMessage('missing-code'), 'No authorization code was found. Paste the whole code shown on the sign-in page.');
});

test('a signed-in provider shows no failure of an earlier sign-in', () => {
  const view = authView('claude', { connected: true, email: 'me@x.y' }, null, 'The sign-in failed. Please try again.');
  assert.equal(view.message, '', 'the old failure is not shown next to Connected');
  assert.match(view.status, /Connected/);
  assert.equal(view.attempt, null);
});

test('a failure of the sign-in shows the wording of its code', () => {
  const view = authView('claude', {
    connected: false,
    login: { phase: 'failed', code: 'expired', message: 'The sign-in expired. Please sign in again.' },
  });
  assert.equal(view.message, 'The sign-in expired. Please sign in again.');
});

test('a sign-in that ended well shows no failure', () => {
  const view = authView('claude', { connected: false, login: { phase: 'signed-in', code: 'failed', message: 'The sign-in failed.' } });
  assert.equal(view.message, '', 'a sign-in that worked has nothing to complain about');
});

test('an attempt the worker lost asks the user to start again', () => {
  const view = authView('claude', { connected: false }, 'attempt-1');
  assert.equal(view.message, 'The sign-in was interrupted — start again.');
  assert.equal(view.attempt, null, 'the panel stops waiting for the lost attempt');
});

test('a sign-in that is still running shows its device code and keeps the attempt', () => {
  const view = authView('chatgpt', {
    connected: false,
    login: { phase: 'authorizing', id: 'attempt-2', deviceCode: 'ABCD-1234', verificationUrl: 'https://auth.openai.com/codex/device' },
  });
  assert.equal(view.deviceCode, 'ABCD-1234');
  assert.equal(view.verificationUrl, 'https://auth.openai.com/codex/device');
  assert.equal(view.attempt, 'attempt-2');
  assert.equal(view.needsCode, false);
});

test('the backup frame shares the sign-in above, or shows its own', () => {
  // The same provider: the sign-in above is the one it uses.
  assert.deepEqual(backupAuthView({ main: 'claude', backup: 'claude' }), { note: true, signIn: null });
  // Another provider: the backup frame shows the sign-in of its own.
  assert.deepEqual(backupAuthView({ main: 'chatgpt', backup: 'claude' }), { note: false, signIn: 'claude' });
  assert.deepEqual(backupAuthView({ main: 'claude', backup: 'grok' }), { note: false, signIn: 'grok' });
  // A Claude slot that pays with an API key needs no sign-in at all.
  assert.deepEqual(backupAuthView({ main: 'chatgpt', backup: 'claude', claudeAuth: 'apiKey' }), { note: false, signIn: null });
  // A compatible backup has no account of its own.
  assert.deepEqual(backupAuthView({ main: 'chatgpt', backup: 'compatible' }), { note: false, signIn: null });
});

test('Kimi API and subscription modes do not share a hidden sign-in surface', () => {
  assert.deepEqual(backupAuthView({ main: 'kimi', backup: 'kimi', kimiAuth: 'apiKey' }), { note: false, signIn: null });
  assert.deepEqual(backupAuthView({ main: 'kimi', backup: 'kimi', kimiAuth: 'account', mainKimiAuth: 'apiKey' }), { note: false, signIn: 'kimi' });
  assert.deepEqual(backupAuthView({ main: 'kimi', backup: 'kimi', kimiAuth: 'account', mainKimiAuth: 'account' }), { note: true, signIn: null });
});

test('the storage listener asks for every provider whose credential changed', () => {
  assert.deepEqual(changedProviders({ 'accountAuth.chatgpt': {}, 'accountAuth.grok': {} }), ['chatgpt', 'grok']);
  assert.deepEqual(changedProviders({ 'accountAuth.claude': {} }), ['claude']);
  assert.deepEqual(changedProviders({ settings: {}, driveBackup: {} }), []);
  assert.deepEqual(changedProviders({}), []);
});

test('a failed request carries the code the panel translates', async () => {
  const { AccountAuthError } = await import('../src/providers/account-auth.js');
  const { request } = await import('../src/sidepanel/request.js');

  // What the worker answers when a refresh finds the sign-in dead.
  const response = errorResponse(new AccountAuthError('The sign-in expired. Please sign in again.', { retryable: false, code: 'expired' }));
  assert.equal(response.ok, false);
  assert.equal(response.code, 'expired');

  globalThis.chrome = { runtime: { sendMessage: async () => response } };
  try {
    const failure = await request('auth-start').catch((err) => err);
    assert.equal(failure.code, 'expired', 'the panel learns the code of the failure');
    assert.equal(authMessage(failure.code, failure.message), 'The sign-in expired. Please sign in again.');
  } finally {
    delete globalThis.chrome;
  }
});

test('a redraw while Claude waits for its code still shows the code field of that sign-in', () => {
  // The panel knew the provider as signed out, then the worker asked for the code.
  let state = { connected: false, provider: 'claude', login: null };
  state = withLoginEvent(state, { type: 'auth-event', provider: 'claude', attemptId: 'a1', kind: 'opened' });
  state = withLoginEvent(state, { type: 'auth-prompt', provider: 'claude', attemptId: 'a1', kind: 'manual_code' });

  const view = authView('claude', state, 'a1');

  assert.equal(view.needsCode, true, 'the code field stays');
  assert.equal(view.attempt, 'a1', 'the attempt id is kept for the submit');
  assert.equal(view.message, '', 'no "interrupted" note for a sign-in that is still running');
});

test('a failure event replaces the waiting state with the failure', () => {
  let state = withLoginEvent(null, { type: 'auth-prompt', provider: 'claude', attemptId: 'a1', kind: 'manual_code' });
  state = withLoginEvent(state, { type: 'auth-error', provider: 'claude', attemptId: 'a1', code: 'timed-out', message: 'x' });

  const view = authView('claude', state, 'a1');

  assert.equal(view.needsCode, false);
  assert.equal(view.attempt, null);
  assert.equal(view.message, authMessage('timed-out'));
});
