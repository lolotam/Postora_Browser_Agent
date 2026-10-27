// The two rules the voice path follows on a page: what it may do without
// asking, and what it must never read or write.
//
// The agent's own tools hide the value of a field that holds a secret and ask
// the user before anything that sends, buys, deletes or submits. The fast
// voice path acts on the page directly, without the agent's tools, so it
// follows the same two rules here.
//
// The secret rule is written once, here. The page scripts cannot share module
// scope, so they get the lists as an argument and match them the same way;
// test/voice-page.test.js runs the real page script against the real rule and
// fails when the two drift apart.

// The autocomplete tokens that mark a field as holding a secret. A field with
// one of them is never described, never read and never written to.
export const SECRET_TOKENS = [
  'password', 'current-password', 'new-password', 'passcode', 'one-time-code',
  'otp', 'pin', 'transaction-pin', 'cvc', 'cvv', 'security-code', 'card-number',
  'credit-card', 'iban', 'account-number', 'mfa-code',
];

// Words that mark a field as holding a secret when they stand alone in its
// name, its id, its aria-label or its label. A whole word only, so an ordinary
// field ("pinned", "select", "tokenizer") stays usable.
export const SECRET_WORDS = [
  'password', 'passwd', 'pwd', 'passphrase', 'passcode', 'pass',
  'otp', 'cvv', 'cvc', 'csc', 'mfa', '2fa', 'totp', 'secret', 'token',
  'pin', 'pincode', 'iban', 'ssn',
  'cardnumber', 'creditcard', 'debitcard', 'cardcvv', 'cardcvc', 'onetimecode',
  'accountnumber', 'securitycode', 'verificationcode', 'verifycode', 'authcode',
  'securitypin', 'transactionpin', 'apikey', 'accesstoken', 'refreshtoken',
  'clientsecret',
  // The expiry of a payment card is a secret of its own: a card that is
  // nearly over is worth as much as the card.
  'expiry', 'expiration',
  // The same words in Arabic, as a field of a page in that language names
  // them: the password, the code, the safety code and the card.
  'المرور', 'السر', 'التحقق', 'الأمان', 'البطاقة',
];

// The same words in the shape a name takes when it has no separators at all:
// "cardNumber", "card_number" and "cardnumber" are one word to the eye. The
// Arabic names are written the same way, so "كلمة المرور" and "كلمةالمرور"
// are one word too.
export const SECRET_FRAGMENTS = [
  'password', 'passwd', 'passphrase', 'passcode',
  'onetimecode', 'verificationcode', 'verifycode', 'securitycode', 'authcode',
  'otpcode', 'mfacode', '2facode',
  'cardnumber', 'creditcard', 'debitcard', 'paymentcard', 'cardcvv', 'cardcvc',
  'cardsecuritycode', 'cardexpiry',
  // The expiry of a card, on its own: "MM/YY", "Expiry", "Exp Date".
  'mmyy', 'expirydate', 'expdate', 'expirationdate', 'validthru', 'validuntil',
  'accountnumber', 'routingnumber', 'socialsecurity',
  'securitypin', 'transactionpin', 'atmpin', 'pincode',
  'apikey', 'accesstoken', 'refreshtoken', 'clientsecret', 'authtoken',
  'sessiontoken', 'secretkey', 'sharedsecret',
  // The Arabic names of the password, the one-time code, the safety code and
  // the card number.
  'كلمةالمرور', 'كلمةالسر', 'رمزالتحقق', 'رمزالتأكيد', 'رمزالأمان', 'رمزالامان',
  'رقمالبطاقة', 'الرمزالسري', 'كودالتحقق', 'رمزالدخول',
  // The expiry of a card in Arabic: "تاريخ الانتهاء", "انتهاء الصلاحية" and
  // "تاريخ انتهاء الصلاحية" are the three spellings of the same name.
  'تاريخالانتهاء', 'انتهاءالصلاحية', 'تاريخانتهاءالصلاحية',
];

/** True for an autocomplete token that marks a field as holding a secret. */
export function isSecretToken(token) {
  const value = String(token ?? '').toLowerCase();
  return value.startsWith('cc-') || SECRET_TOKENS.includes(value);
}

/**
 * The name of a field with its separators and its case removed. Letters of
 * every language are kept: an Arabic name is not emptied by the cleaning, so
 * it can still be matched.
 */
function compactName(text) {
  return String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** The words of a name: "cardNumber" and "card_number" both give card, number. */
function nameWords(text) {
  return String(text ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * True for a name that marks a field as holding a secret: a payment card, a
 * code, a password. The name is the field's id, name, aria-label or label.
 */
export function isSecretName(text) {
  const value = String(text ?? '').trim();
  if (!value) return false;
  const flat = compactName(value);
  if (SECRET_FRAGMENTS.some((fragment) => flat.includes(fragment))) return true;
  return nameWords(value).some((word) => SECRET_WORDS.includes(word));
}

/**
 * True for a field that holds a secret. `field` is a plain description of an
 * element ({ tag, type, autocomplete, id, name, ariaLabel, label }), so the rule
 * can be checked without a page.
 */
export function isSecretField(field) {
  if (!field) return false;
  if (String(field.tag ?? '').toUpperCase() === 'INPUT' && String(field.type ?? '').toLowerCase() === 'password') return true;
  const tokens = String(field.autocomplete ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.some(isSecretToken)) return true;
  return isSecretName([field.id, field.name, field.ariaLabel, field.label].filter(Boolean).join(' '));
}

/**
 * The rule as the page scripts get it: the lists themselves, so the page and
 * this module always agree on what a secret field is.
 */
export function secretRule() {
  return {
    tokens: [...SECRET_TOKENS],
    words: [...SECRET_WORDS],
    fragments: [...SECRET_FRAGMENTS],
  };
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
