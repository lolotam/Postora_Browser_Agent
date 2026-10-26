// The two rules the voice path follows on a page: what it may do without
// asking, and what it must never read or write.
//
// The agent's own tools hide the value of a field that holds a secret and ask
// the user before anything that sends, buys, deletes or submits. The fast
// voice path acts on the page directly, without the agent's tools, so it
// follows the same two rules here.

// The autocomplete tokens that mark a field as holding a secret. A field with
// one of them is never described, never read and never written to.
export const SECRET_TOKENS = [
  'password', 'current-password', 'new-password', 'passcode', 'one-time-code',
  'otp', 'pin', 'transaction-pin', 'cvc', 'cvv', 'security-code', 'card-number',
  'credit-card', 'iban', 'account-number', 'mfa-code',
];

/** True for an autocomplete token that marks a field as holding a secret. */
export function isSecretToken(token) {
  const value = String(token ?? '').toLowerCase();
  return value.startsWith('cc-') || SECRET_TOKENS.includes(value);
}

/**
 * True for a field that holds a secret. `field` is a plain description of an
 * element ({ tag, type, autocomplete }), so the rule can be checked without a
 * page; the copy inside the injected page script follows the same list.
 */
export function isSecretField(field) {
  if (!field) return false;
  if (String(field.tag ?? '').toUpperCase() === 'INPUT' && String(field.type ?? '').toLowerCase() === 'password') return true;
  return String(field.autocomplete ?? '').toLowerCase().split(/\s+/).filter(Boolean).some(isSecretToken);
}

// The steps that only move the browser: what is on screen changes, but nothing
// on the site does.
export const BROWSER_ACTIONS = new Set([
  'navigate', 'new_tab', 'web_search', 'scroll_down', 'scroll_up', 'scroll_top',
  'scroll_bottom', 'go_back', 'go_forward', 'reload', 'switch_tab', 'next_tab',
  'previous_tab', 'zoom_in', 'zoom_out', 'zoom_reset', 'media_play_pause',
  'media_mute', 'find_on_page',
]);

// The steps that act on the page itself: they can send, buy, delete, log in or
// submit. The user confirms each of them before it runs.
export const PAGE_ACTIONS = new Set(['click', 'type_text', 'press_enter']);

// Closing a tab throws away what was in it.
export const DESTRUCTIVE_ACTIONS = new Set(['close_tab']);

/** True when the step needs the user's confirmation before it runs. */
export function needsConfirmation(action) {
  return PAGE_ACTIONS.has(action) || DESTRUCTIVE_ACTIONS.has(action);
}
