import { CompatibleSession } from './openai-compatible.js';
import { getValidCredential } from './account-auth.js';

export function planAccountProvider(slot) {
  return slot.provider === 'compatible' ? { 'minimax-auth': 'minimax', 'zai-auth': 'zai' }[slot.connectionRoute] : undefined;
}

export const PLAN_ENDPOINTS = { minimax: 'https://api.minimax.io/v1', zai: 'https://api.z.ai/api/coding/paas/v4' };

export class PlanAccountSession extends CompatibleSession {
  constructor({ accountProvider, ...options }) {
    super({ ...options, apiKey: '', baseUrl: PLAN_ENDPOINTS[accountProvider], strictRedirects: true });
    this.accountProvider = accountProvider;
  }

  async request(toolChoice, signal, deadline) {
    this.apiKey = (await getValidCredential(this.accountProvider, { signal })).access;
    return super.request(toolChoice, signal, deadline);
  }
}
