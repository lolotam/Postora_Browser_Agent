// Browser adaptations of the public MiniMax CLI and ZCode authorization
// protocols. Credentials stay in the worker; all network destinations are fixed.
const MINIMAX = 'https://account.minimax.io';
const ZCODE = 'https://zcode.z.ai/api/v1';
const ZAI = 'https://api.z.ai';
const CLIENT_ID = '659cf4c1-615c-45f6-a5f6-4bf15eb476e5';

function randomHex(size) {
  return Array.from(crypto.getRandomValues(new Uint8Array(size)), (n) => n.toString(16).padStart(2, '0')).join('');
}

function abortableWait(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/**
 * The OAuth error code of a failed response, when it has one. A token endpoint
 * that answers `invalid_grant` says the sign-in is over for good; without the
 * code the failure looks like a hiccup that another try would fix.
 */
function oauthErrorCode(body) {
  const error = body?.error;
  const code = typeof error === 'string' ? error : error?.code ?? error?.error;
  return typeof code === 'string' && code.trim() ? code.trim() : null;
}

async function json(url, init, signal) {
  const response = await fetch(url, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), credentials: 'omit', redirect: 'error' });
  // A failure may still carry a body, and that body may say what went wrong.
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const code = oauthErrorCode(body);
    throw Object.assign(new Error(`Account authorization failed (HTTP ${response.status})${code ? `: ${code}` : ''}.`), { status: response.status, code });
  }
  if (body.base_resp?.status_code || (body.code !== undefined && ![0, 200, '0', '200'].includes(body.code))) throw new Error('Account authorization was rejected. Sign in again or use a plan key.');
  return body;
}

function requireText(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid account authorization response.');
  return value.trim();
}

export function trustedPlanVerificationUrl(provider, value) {
  try {
    const url = new URL(value);
    const hosts = provider === 'minimax' ? ['account.minimax.io', 'platform.minimax.io'] : provider === 'zai' ? ['zcode.z.ai', 'z.ai', 'chat.z.ai'] : [];
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && hosts.includes(url.hostname);
  } catch { return false; }
}

function notifyLogin(provider, url, userCode, notify) {
  if (!trustedPlanVerificationUrl(provider, url)) throw new Error('Invalid account authorization URL.');
  notify({ type: 'device_code', userCode, verificationUri: url });
}

function tokenCredential(body, previous = {}) {
  const expires = Number(body.expired_in);
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('Invalid account token expiry.');
  return { ...previous, type: 'oauth', access: requireText(body.access_token), refresh: requireText(body.refresh_token || previous.refresh), expires };
}

export const minimaxOAuth = {
  async login({ signal, notify }) {
    const verifier = randomHex(32);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...hash)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    const state = randomHex(16);
    const form = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
    const start = await json(`${MINIMAX}/oauth2/device/code`, form({ client_id: CLIENT_ID, scope: 'openid profile coding_plan', code_challenge: challenge, code_challenge_method: 'S256', state }), signal);
    if (start.state !== state) throw new Error('Account authorization state mismatch.');
    const code = requireText(start.user_code);
    notifyLogin('minimax', start.verification_uri, code, notify);
    const deadline = Math.min(Number(start.expired_in), Date.now() + 15 * 60 * 1000);
    if (!Number.isFinite(deadline)) throw new Error('Invalid account authorization expiry.');
    while (Date.now() < deadline) {
      await abortableWait(Math.max(1000, Math.min(Number(start.interval) || 3000, 30000)), signal);
      const body = await json(`${MINIMAX}/oauth2/token`, form({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', client_id: CLIENT_ID, user_code: code, code_verifier: verifier }), signal);
      if (body.status === 'pending') continue;
      if (body.status !== 'success') throw new Error('Account authorization was denied.');
      return tokenCredential(body);
    }
    throw new Error('Account authorization timed out.');
  },
  async refresh(credential, signal) {
    const body = await json(`${MINIMAX}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, refresh_token: credential.refresh }) }, signal);
    if (body.status !== 'success') throw new Error('Account authorization expired. Sign in again.');
    return tokenCredential(body, credential);
  },
};

async function zaiProjectToken(oauth, signal, previous = {}) {
  const post = (body, token) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const login = (await json(`${ZAI}/api/auth/z/login`, post({ token: oauth }), signal)).data;
  const business = requireText(login?.access_token || login?.accessToken);
  let location = previous.location;
  if (!location) {
    const customer = (await json(`${ZAI}/api/biz/customer/getCustomerInfo`, { headers: { Authorization: business } }, signal)).data;
    const organizations = customer?.organizations ?? [];
    const org = organizations.find((o) => o.organizationName?.includes('默认机构')) ?? organizations.find((o) => o.projects?.length);
    const project = org?.projects?.find((p) => p.projectName?.includes('默认项目')) ?? org?.projects?.[0];
    if (!org?.organizationId || !project?.projectId) throw new Error('No Z.ai coding-plan project is available.');
    location = { organizationId: org.organizationId, projectId: project.projectId };
    const path = `${ZAI}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}/projects/${encodeURIComponent(location.projectId)}/api_keys`;
    const keys = (await json(path, { headers: { Authorization: `Bearer ${business}` } }, signal)).data;
    if (!Array.isArray(keys)) throw new Error('Invalid account authorization response.');
    const key = keys.find((k) => k.name === 'postora-coding-plan') ?? (await json(path, post({ name: 'postora-coding-plan', usageScene: 1 }, business), signal)).data;
    location.apiKeyId = requireText(key?.apiKey);
  }
  const path = `${ZAI}/api/biz/v1/organization/${encodeURIComponent(location.organizationId)}/projects/${encodeURIComponent(location.projectId)}/api_keys/${encodeURIComponent(location.apiKeyId)}/access_tokens`;
  const startedAt = Date.now();
  const token = (await json(path, post({ clientType: 'postora', clientVersion: '0.4.7' }, business), signal)).data;
  if (token?.enable === false) throw new Error('Z.ai project access tokens are not enabled for this account. Use a plan key.');
  if (token?.tokenType !== 'Bearer') throw new Error('Invalid account token type.');
  const expires = Math.min(Number(token?.expiresAt) * 1000, startedAt + Number(token?.expiresIn) * 1000);
  if (!Number.isFinite(expires) || expires <= Date.now()) throw new Error('Invalid account token expiry.');
  return { ...previous, type: 'oauth', access: requireText(token?.accessToken), refresh: oauth, expires, location };
}

export const zaiOAuth = {
  async login({ signal, notify }) {
    const pollToken = randomHex(32);
    const headers = { Authorization: `Bearer ${pollToken}`, 'Content-Type': 'application/json' };
    const start = (await json(`${ZCODE}/oauth/cli/init`, { method: 'POST', headers, body: JSON.stringify({ provider: 'zai' }) }, signal)).data;
    const flow = requireText(start?.flow_id);
    const toMs = (value) => (Number(value) < 1e12 ? Number(value) * 1000 : Number(value));
    const expiresAt = toMs(start.expires_at);
    // The server says how long the flow lasts relative to its own clock; a
    // local clock that is off must not make a fresh flow look already expired.
    const lifetime = start.server_time == null ? NaN : expiresAt - toMs(start.server_time);
    const cap = Date.now() + 15 * 60 * 1000;
    const deadline = Number.isFinite(lifetime) && lifetime > 0 ? Math.min(Date.now() + lifetime, cap) : Math.min(expiresAt, cap);
    if (!Number.isFinite(deadline)) throw new Error('Invalid account authorization expiry.');
    notifyLogin('zai', start.authorize_url, '', notify);
    while (Date.now() < deadline) {
      await abortableWait(Math.max(1000, Math.min(Number(start.poll_interval_sec) * 1000 || 3000, 30000)), signal);
      const data = (await json(`${ZCODE}/oauth/cli/poll/${encodeURIComponent(flow)}`, { headers }, signal)).data;
      if (data?.status === 'pending') continue;
      if (data?.status !== 'ready') throw new Error('Account authorization was denied.');
      const oauth = requireText(data.zai?.access_token || data.zai?.accessToken);
      return zaiProjectToken(oauth, signal, { email: data.user?.email, accountId: data.user?.user_id });
    }
    throw new Error('Account authorization timed out.');
  },
  refresh(credential, signal) { return zaiProjectToken(credential.refresh, signal, credential); },
};
