// Provider, model and reasoning-effort fields for one model slot. The main model
// and its backup use the same form; fields are found by data-field inside root.
// The model itself is chosen in the shared dialog: this form keeps the id input
// as the canonical state and the effort list that follows from it.

import { t } from './i18n.js';
import { escapeAttr } from './model-picker.js';
import { bindTestButton } from './test-button.js';
import { ANTHROPIC_GROUP } from '../lib/keys.js';
import { ACCOUNT_PROVIDERS, slotSettings as slotOf } from '../lib/settings.js';

const TRANSLATED_EFFORTS = { '': 'effort.default', off: 'effort.off', on: 'effort.on' };
// The efforts a model list does not name. MiniMax cannot stop thinking, so it
// offers no Off. Claude and Grok name the efforts of each model in their own
// list, so these are only what the form shows before that list arrives.
const FALLBACK_EFFORTS = {
  chatgpt: ['low', 'medium', 'high', 'xhigh'],
  reasoning_effort: ['off', 'low', 'medium', 'high'],
  glm: ['on', 'off'],
  none: [],
  gemini: ['minimal', 'low', 'medium', 'high'],
  minimax: ['low', 'medium', 'high', 'xhigh', 'max'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  grok: ['low', 'medium', 'high', 'xhigh'],
};

export function createProviderForm(root, { request, getPresets, keyStore, onChange = null, onModels = null }) {
  const f = (name) => root.querySelector(`[data-field="${name}"]`);
  // Hides a field this form does not have: the backup frame has no sign-in
  // sections, only the note that the account is the one above.
  const hide = (name, hidden) => { const el = f(name); if (el) el.hidden = hidden; };
  // Last filled values; also remembers the other provider's model while switching.
  let saved = null;
  let models = [];
  let latestLoad = 0;
  // What the last list request for this slot is doing, for the shared model
  // dialog: a "loading" line, or the failure a refresh asked to see.
  let listLoading = false;
  let listError = '';
  // Custom endpoint keys are not shared, so the form keeps the last one typed.
  let preset = '';
  let customKey = '';

  function fill(s) {
    latestLoad += 1; // a model list still loading belongs to the values being replaced
    listLoading = false;
    listError = '';
    saved = {
      provider: s.provider,
      chatgpt: { ...s.chatgpt },
      claude: { ...s.claude },
      grok: { ...s.grok },
      compatible: { ...s.compatible },
    };
    f('preset').innerHTML = Object.entries(getPresets()).map(([id, p]) => `<option value="${id}">${escapeAttr(p.label)}</option>`).join('');
    f('provider').value = s.provider;
    f('preset').value = s.compatible.preset;
    f('baseUrl').value = s.compatible.baseUrl;
    f('apiKey').value = s.compatible.apiKey;
    preset = s.compatible.preset;
    customKey = preset === 'custom' ? s.compatible.apiKey : '';
    keyStore.refresh?.(f('apiKey'));
    if (f('claudeAuth')) f('claudeAuth').value = s.claude.auth;
    // The Anthropic key is one key for the whole app, so the shared one wins.
    if (f('claudeApiKey')) {
      keyStore.show(f('claudeApiKey'), ANTHROPIC_GROUP);
      if (!f('claudeApiKey').value) f('claudeApiKey').value = s.claude.apiKey ?? '';
      keyStore.refresh?.(f('claudeApiKey'));
    }
    f('modelInput').value = slotOf(s).model;
    models = [];
    syncSections();
    renderEfforts(slotOf(s).effort);
  }

  function read() {
    const next = structuredClone(saved);
    next.provider = f('provider').value;
    Object.assign(next.compatible, compatibleFields());
    Object.assign(next.claude, claudeFields());
    const slot = slotOf(next);
    slot.model = f('modelInput').value.trim();
    slot.effort = f('effort').value;
    return next;
  }

  const compatibleFields = () => ({ preset: f('preset').value, baseUrl: f('baseUrl').value.trim(), apiKey: f('apiKey').value.trim() });
  const claudeFields = () => ({ auth: f('claudeAuth')?.value ?? 'account', apiKey: f('claudeApiKey')?.value.trim() ?? '' });

  function syncSections() {
    const provider = f('provider').value;
    hide('chatgptSection', provider !== 'chatgpt');
    hide('claudeSection', provider !== 'claude');
    hide('grokSection', provider !== 'grok');
    hide('compatibleSection', provider !== 'compatible');
  }

  /** The efforts of the chosen model, or the ones its provider takes. */
  function renderEfforts(selected) {
    const model = models.find((m) => m.id === f('modelInput').value.trim());
    const levels = model?.efforts?.length ? model.efforts : FALLBACK_EFFORTS[effortStyle()];
    const options = ['', ...levels];
    f('effort').innerHTML = options.map((e) => `<option value="${escapeAttr(e)}">${escapeAttr(TRANSLATED_EFFORTS[e] ? t(TRANSLATED_EFFORTS[e]) : e)}${model?.defaultEffort === e ? t('effort.defaultMark') : ''}</option>`).join('');
    f('effort').value = options.includes(selected) ? selected : '';
  }

  /** The thinking style of the chosen provider: its own, or the preset's. */
  function effortStyle() {
    const provider = f('provider').value;
    if (provider === 'chatgpt' || provider === 'claude' || provider === 'grok') return provider;
    return getPresets()[f('preset').value]?.thinkingStyle ?? 'reasoning_effort';
  }

  /** A provider that signs in with an account needs one before it lists models. */
  function needsSignIn(draft) {
    if (ACCOUNT_PROVIDERS.includes(draft.provider)) {
      // A Claude slot that pays with an API key needs no sign-in.
      if (draft.provider === 'claude' && draft.claude.auth === 'apiKey') return false;
      return true;
    }
    return false;
  }

  async function loadModels(showErrors = false) {
    const draft = read();
    // Numbered before any wait, so a slower earlier load (or a fill since) never wins.
    const load = ++latestLoad;
    models = [];
    listLoading = true;
    listError = '';
    onModels?.();
    f('modelInfo').textContent = t('model.loading');
    try {
      if (needsSignIn(draft)) {
        const status = await request('auth-status', { provider: draft.provider });
        if (load !== latestLoad) return;
        if (!status.connected) {
          models = [];
          listLoading = false;
          f('modelInfo').textContent = listError = t('auth.disconnected');
          onModels?.();
          return;
        }
      }
      const list = await request('list-models', { settings: draft });
      if (load !== latestLoad) return;
      models = list;
      if (!f('modelInput').value && models[0]) f('modelInput').value = models[0].id;
      renderEfforts(f('effort').value || (models.find((m) => m.id === f('modelInput').value)?.defaultEffort ?? ''));
      f('modelInfo').textContent = '';
      listLoading = false;
      onModels?.();
    } catch (err) {
      if (load !== latestLoad) return;
      listLoading = false;
      listError = showErrors ? err.message : t('model.fallback');
      f('modelInfo').textContent = showErrors ? err.message : t('model.fallback');
      onModels?.();
    }
  }

  /**
   * The dialog picked a model: the id input stays the one canonical state, and
   * the efforts follow the model the provider named.
   */
  function chooseModel(id, effort = id === f('modelInput').value.trim() ? f('effort').value : models.find((m) => m.id === id)?.defaultEffort ?? '') {
    const changed = id !== f('modelInput').value.trim();
    f('modelInput').value = id;
    renderEfforts(effort);
    if (changed) showTestStatus('', '');
    // A model id that is not in the list is asked about again, so the efforts
    // Anthropic's own table gives it arrive.
    if (f('provider').value === 'claude') loadModels();
  }

  // Switching provider keeps each provider's own model instead of copying one into the other.
  f('provider').addEventListener('change', () => {
    const leaving = slotOf(saved);
    leaving.model = f('modelInput').value.trim();
    leaving.effort = f('effort').value;
    Object.assign(saved.compatible, compatibleFields());
    Object.assign(saved.claude, claudeFields());
    saved.provider = f('provider').value;
    f('modelInput').value = slotOf(saved).model;
    models = [];
    syncSections();
    renderEfforts(slotOf(saved).effort);
    loadModels();
    onChange?.(saved.provider);
  });
  f('preset').addEventListener('change', () => {
    if (preset === 'custom') customKey = f('apiKey').value.trim();
    preset = f('preset').value;
    const defaults = getPresets()[preset];
    f('baseUrl').value = defaults.baseUrl;
    keyStore.show(f('apiKey'), preset, customKey);
    f('modelInput').value = defaults.model;
    models = [];
    renderEfforts('');
    loadModels();
  });
  f('modelInput').addEventListener('change', () => {
    if (f('provider').value === 'claude') loadModels();
  });
  // Switching between a Claude account and an Anthropic key changes what the
  // model list needs, so it is loaded again.
  f('claudeAuth')?.addEventListener('change', () => {
    saved.claude = { ...saved.claude, ...claudeFields() };
    loadModels();
    onChange?.(saved.provider);
  });
  f('refresh')?.addEventListener('click', () => loadModels(true));
  keyStore.register(f('apiKey'), () => f('preset').value);
  if (f('claudeApiKey')) keyStore.register(f('claudeApiKey'), () => ANTHROPIC_GROUP);
  const showTestStatus = bindTestButton({
    button: f('test'),
    result: f('testResult'),
    scope: root,
    run: async () => {
      const { model, ms, reply } = await request('provider-test', { slot: read() });
      return t('provider.testOk', { model, ms, reply: reply || '—' });
    },
  });

  return {
    fill,
    read,
    loadModels,
    model: () => f('modelInput').value.trim(),
    provider: () => f('provider').value,
    /** The list the provider serves, for the shared model dialog. */
    list: () => models,
    /** What this slot's list request is doing right now. */
    status: () => ({ loading: listLoading, error: listError }),
    chooseModel,
    /** How the Claude slot connects: its account or an Anthropic key. */
    claude: () => claudeFields(),
    rerender() {
      renderEfforts(f('effort').value);
    },
  };
}
