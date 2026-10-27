// The parts of the trusted input path that both the worker and its tests use.
//
// The input is real: it goes through the debugger, so the page sees what a
// user's hand would do. Two things are decided here, and both belong to the
// worker and not to the panel, because the panel does not know the machine the
// command runs on.

// The chord that selects everything in a field. It is the platform's own: a
// Mac takes the Command key, everything else the Control key.
export function selectAllChord(nav = globalThis.navigator) {
  const platform = String(nav?.platform ?? '');
  const agent = String(nav?.userAgent ?? '');
  if (/mac|iphone|ipad|ipod/i.test(platform)) return 'Meta+A';
  if (/macintosh|mac os x/i.test(agent)) return 'Meta+A';
  return 'Control+A';
}

// The error a page failure carries: the panel translates its key.
export function pageError(errorKey) {
  const error = new Error(errorKey);
  error.code = errorKey;
  return error;
}

// The key of a page failure, when the error is one.
export function pageErrorKey(err) {
  const code = String(err?.code ?? err?.message ?? '');
  return /^voice\.page[A-Za-z]+$/.test(code) ? code : null;
}
