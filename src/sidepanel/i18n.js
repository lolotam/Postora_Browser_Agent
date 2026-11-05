// Interface language for the side panel. Static markup carries data-i18n*
// attributes; runtime strings go through t().

import { MESSAGES } from './messages.js';

export const LANGUAGES = Object.keys(MESSAGES);
const RTL = new Set(['ar']);

let current = 'en';

/** An explicit choice wins; "auto" follows the browser's UI language. */
export function resolveLanguage(preference, browserLanguage) {
  if (LANGUAGES.includes(preference)) return preference;
  const base = String(browserLanguage ?? '').toLowerCase().split('-')[0];
  return LANGUAGES.includes(base) ? base : 'en';
}

export function t(key, vars = {}) {
  return translateFor(current, key, vars);
}

/** Translate a voice reply without changing the interface language. */
export function translateFor(language, key, vars = {}) {
  const text = MESSAGES[language]?.[key] ?? MESSAGES.en[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ''));
}

export function currentLanguage() {
  return current;
}

export function setLanguage(language, root = document) {
  current = language;
  root.documentElement.lang = language;
  root.documentElement.dir = RTL.has(language) ? 'rtl' : 'ltr';
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
    el.setAttribute('aria-label', el.title);
  });
}
