// Moonshot API keys and Kimi Code OAuth are different products and credentials.
// Never send a subscription token to the pay-as-you-go API or spoof a CLI's
// identity. Entitlement/region rejection is surfaced, not bypassed.
import { KIMI_CODE_URL, MOONSHOT_API_URL, kimiEfforts } from '../lib/settings.js';
import { getValidCredential } from './account-auth.js';
import { CompatibleSession, listCompatibleModels } from './openai-compatible.js';

/** A catalog or inference request may refresh a rejected account token once. */
async function withKimiAccount(request, signal) {
  const credential = await getValidCredential('kimi', { signal });
  try {
    return await request(credential.access);
  } catch (error) {
    if (signal?.aborted || error.status !== 401) throw error;
    const refreshed = await getValidCredential('kimi', { forceRefresh: true, signal });
    return request(refreshed.access);
  }
}

/** Loads only the chosen product's catalog; no anonymous or cross-product fallback. */
export async function listKimiModels(config) {
  const account = config.auth === 'account';
  const signal = AbortSignal.timeout(30000);
  const load = (key) => listCompatibleModels(account ? KIMI_CODE_URL : MOONSHOT_API_URL, key, {
    anonymousFallback: false, redirect: 'error', signal,
  });
  if (!account && !config.apiKey?.trim()) throw new Error('Enter a Moonshot API key in settings first.');
  const models = account ? await withKimiAccount(load, signal) : await load(config.apiKey);
  return models.filter((model) => !model.decision && model.tools !== false)
    .map((model) => ({ ...model, efforts: kimiEfforts(model.id, config.auth) }));
}

export class KimiSession extends CompatibleSession {
  constructor({ auth = 'apiKey', ...options }) {
    if (auth !== 'account' && !options.apiKey?.trim()) throw new Error('Enter a Moonshot API key in settings first.');
    super({ ...options, apiKey: auth === 'account' ? '' : options.apiKey,
      baseUrl: auth === 'account' ? KIMI_CODE_URL : MOONSHOT_API_URL,
      thinkingStyle: 'kimi', usage: true, strictRedirects: true });
    this.account = auth === 'account';
  }

  request(toolChoice, signal, deadline) {
    if (!this.account) return super.request(toolChoice, signal, deadline);
    return withKimiAccount((key) => {
      this.apiKey = key;
      return super.request(toolChoice, signal, deadline);
    }, signal);
  }

  requestBody(toolChoice) {
    const body = super.requestBody(toolChoice);
    if (!kimiEfforts(this.model, this.account ? 'account' : 'apiKey').includes(body.reasoning_effort)) delete body.reasoning_effort;
    return body;
  }
}
