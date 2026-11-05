// OpenRouter's documented PKCE flow returns a user-owned API key. It does not
// grant a subscription or copy a browser session cookie.
let pending;

export async function signInOpenRouter({ identity = chrome.identity, fetcher = fetch, cryptoApi = crypto } = {}) {
  if (pending) throw new Error('OpenRouter sign-in is already open.');
  const flow = async () => {
    const random = () => Array.from(cryptoApi.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, '0')).join('');
    const verifier = random();
    const hash = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const challenge = btoa(String.fromCharCode(...new Uint8Array(hash))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const callback = identity.getRedirectURL(`openrouter/${random()}`);
    const url = new URL('https://openrouter.ai/auth');
    url.search = new URLSearchParams({ callback_url: callback, code_challenge: challenge, code_challenge_method: 'S256' });
    const result = await identity.launchWebAuthFlow({ url: url.href, interactive: true });
    const returned = new URL(result);
    const expected = new URL(callback);
    if (returned.origin !== expected.origin || returned.pathname !== expected.pathname || !returned.searchParams.get('code')) {
      throw new Error('OpenRouter returned an invalid sign-in callback.');
    }
    const response = await fetcher('https://openrouter.ai/api/v1/auth/keys', {
      method: 'POST', credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: returned.searchParams.get('code'), code_verifier: verifier, code_challenge_method: 'S256' }),
    });
    if (!response.ok) throw new Error(`OpenRouter sign-in failed (HTTP ${response.status}).`);
    const { key } = await response.json();
    if (typeof key !== 'string' || !key.trim()) throw new Error('OpenRouter returned no API key.');
    return key;
  };
  pending = flow();
  try { return await pending; } finally { pending = null; }
}
