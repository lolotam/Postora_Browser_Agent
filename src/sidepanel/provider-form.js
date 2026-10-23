// Provider, model and reasoning-effort fields for one model slot. The main model
// and its backup use the same form; fields are found by data-field inside root.

import { t } from './i18n.js';
import { bindSearch, escapeAttr, pickModel, renderPicker } from './model-picker.js';
import { bindTestButton } from './test-button.js';

const TRANSLATED_EFFORTS = { '': 'effort.default', off: 'effort.off', on: 'effort.on' };
// The efforts a model list does not name. MiniMax cannot stop thinking, so it
// offers no Off.
const FALLBACK_EFFORTS = { chatgpt: ['low', 'medium', 'high', 'xhigh'], reasoning_effort: ['off', 'low', 'medium', 'high'], glm: ['on', 'off'], none: [], gemini: ['minimal', 'low', 'medium', 'high'], minimax: ['low', 'medium', 'high', 'xhigh', 'max'] };

const slotOf = (s) => (s.provider === 'chatgpt' ? s.chatgpt : s.compatible);

export function createProviderForm(root, { request, getPresets, keyStore }) {
  const f = (name) => root.querySelector(`[data-field="${name}"]`);
  // Last filled values; also remembers the other provider's model while switching.
  let saved = null;
  let models = [];
  let latestLoad = 0;
  // Custom endpoint keys are not shared, so the form keeps the last one typed.
  let preset = '';
  let customKey = '';

  function fill(s) {
    latestLoad += 1; // a model list still loading belongs to the values being replaced
    saved = { provider: s.provider, chatgpt: { ...s.chatgpt }, compatible: { ...s.compatible } };
    f('preset').innerHTML = Object.entries(getPresets()).map(([id, p]) => `<option value="${id}">${escapeAttr(p.label)}</option>`).join('');
    f('provider').value = s.provider;
    f('preset').value = s.compatible.preset;
    f('baseUrl').value = s.compatible.baseUrl;
    f('apiKey').value = s.compatible.apiKey;
    preset = s.compatible.preset;
    customKey = preset === 'custom' ? s.compatible.apiKey : '';
    f('modelInput').value = slotOf(s).model;
    models = [];
    syncSections();
    renderModels();
    renderEfforts(slotOf(s).effort);
  }

  function read() {
    const next = structuredClone(saved);
    next.provider = f('provider').value;
    Object.assign(next.compatible, compatibleFields());
    const slot = slotOf(next);
    slot.model = f('modelInput').value.trim();
    slot.effort = f('effort').value;
    return next;
  }

  const compatibleFields = () => ({ preset: f('preset').value, baseUrl: f('baseUrl').value.trim(), apiKey: f('apiKey').value.trim() });

  function syncSections() {
    const chatgpt = f('provider').value === 'chatgpt';
    f('chatgptSection').hidden = !chatgpt;
    f('compatibleSection').hidden = chatgpt;
  }

  function renderModels() {
    renderPicker(f('modelSelect'), f('modelInput'), models, f('modelSearch'));
  }

  function renderEfforts(selected) {
    const model = models.find((m) => m.id === f('modelInput').value.trim());
    const style = f('provider').value === 'chatgpt' ? 'chatgpt' : getPresets()[f('preset').value]?.thinkingStyle ?? 'reasoning_effort';
    const levels = model?.efforts?.length ? model.efforts : FALLBACK_EFFORTS[style];
    const options = ['', ...levels];
    f('effort').innerHTML = options.map((e) => `<option value="${escapeAttr(e)}">${escapeAttr(TRANSLATED_EFFORTS[e] ? t(TRANSLATED_EFFORTS[e]) : e)}${model?.defaultEffort === e ? t('effort.defaultMark') : ''}</option>`).join('');
    f('effort').value = options.includes(selected) ? selected : '';
  }

  async function loadModels(showErrors = false) {
    const draft = read();
    // Numbered before any wait, so a slower earlier load (or a fill since) never wins.
    const load = ++latestLoad;
    if (draft.provider === 'chatgpt' && !(await request('auth-status')).connected) return;
    if (load !== latestLoad) return;
    f('modelInfo').textContent = t('model.loading');
    try {
      const list = await request('list-models', { settings: draft });
      if (load !== latestLoad) return;
      models = list;
      if (!f('modelInput').value && models[0]) f('modelInput').value = models[0].id;
      renderModels();
      renderEfforts(f('effort').value || (models.find((m) => m.id === f('modelInput').value)?.defaultEffort ?? ''));
      f('modelInfo').textContent = '';
    } catch (err) {
      if (load === latestLoad) f('modelInfo').textContent = showErrors ? err.message : t('model.fallback');
    }
  }

  // Switching provider keeps each provider's own model instead of copying one into the other.
  f('provider').addEventListener('change', () => {
    const leaving = slotOf(saved);
    leaving.model = f('modelInput').value.trim();
    leaving.effort = f('effort').value;
    Object.assign(saved.compatible, compatibleFields());
    saved.provider = f('provider').value;
    f('modelInput').value = slotOf(saved).model;
    models = [];
    syncSections();
    renderModels();
    renderEfforts(slotOf(saved).effort);
    loadModels();
  });
  f('preset').addEventListener('change', () => {
    if (preset === 'custom') customKey = f('apiKey').value.trim();
    preset = f('preset').value;
    const defaults = getPresets()[preset];
    f('baseUrl').value = defaults.baseUrl;
    keyStore.show(f('apiKey'), preset, customKey);
    f('modelInput').value = defaults.model;
    models = [];
    renderModels();
    renderEfforts('');
    loadModels();
  });
  f('modelSelect').addEventListener('change', () => {
    pickModel(f('modelSelect'), f('modelInput'));
    renderEfforts(models.find((m) => m.id === f('modelSelect').value)?.defaultEffort ?? '');
  });
  f('modelInput').addEventListener('input', () => renderEfforts(f('effort').value));
  f('refresh').addEventListener('click', () => loadModels(true));
  keyStore.register(f('apiKey'), () => f('preset').value);
  bindTestButton({
    button: f('test'),
    result: f('testResult'),
    scope: root,
    run: async () => {
      const { model, ms, reply } = await request('provider-test', { slot: read() });
      return t('provider.testOk', { model, ms, reply: reply || '—' });
    },
  });
  bindSearch(f('modelSearch'), f('modelSelect'), () => models, renderModels);

  return {
    fill,
    read,
    loadModels,
    model: () => f('modelInput').value.trim(),
    rerender() {
      renderModels();
      renderEfforts(f('effort').value);
    },
  };
}
