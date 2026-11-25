// Stamps the shared provider-slot template into #mainProvider and #fallbackProvider
// before panel.js wires their forms and event listeners.

export const MAIN_SLOT_IDS = [
  ['[data-field="provider"]', 'provider'],
  ['[data-field="chatgptSection"]', 'chatgptSection'],
  ['[data-field="authJson"]', 'authJson'],
  ['[data-field="importBtn"]', 'importBtn'],
  ['[data-field="claudeSection"]', 'claudeSection'],
  ['[data-field="grokSection"]', 'grokSection'],
  ['[data-field="compatibleSection"]', 'compatibleSection'],
  ['[data-field="preset"]', 'preset'],
  ['[data-field="baseUrl"]', 'baseUrl'],
  ['[data-field="apiKey"]', 'apiKey'],
  ['[data-field="modelBtn"]', 'modelBtnMain'],
  ['[data-field="modelLabel"]', 'modelMainLabel'],
  ['[data-field="modelInput"]', 'modelInput'],
  ['[data-field="modelInfo"]', 'modelInfo'],
  ['[data-field="effort"]', 'effort'],
];

export const BACKUP_SLOT_IDS = [
  ['[data-field="authJson"]', 'backupAuthJson'],
  ['[data-field="importBtn"]', 'backupImportBtn'],
  ['[data-field="modelBtn"]', 'modelBtnBackup'],
  ['[data-field="modelLabel"]', 'modelBackupLabel'],
  ['[data-field="modelInfo"]', 'modelBackupInfo'],
];

export const STAMPED_PROVIDER_SLOT_IDS = [
  ...MAIN_SLOT_IDS.map(([, id]) => id),
  ...BACKUP_SLOT_IDS.map(([, id]) => id),
];

export function stampProviderSlots(root = document) {
  const template = root.getElementById?.('providerSlotTemplate');
  if (!template?.content) return false;
  for (const [containerId, idMap] of [
    ['mainProvider', MAIN_SLOT_IDS],
    ['fallbackProvider', BACKUP_SLOT_IDS],
  ]) {
    const container = root.getElementById(containerId);
    if (!container || container.children?.length > 0) continue;
    const fragment = template.content.cloneNode(true);
    for (const [selector, id] of idMap) {
      const el = fragment.querySelector(selector);
      if (el) el.id = id;
    }
    container.append(fragment);
  }
  return true;
}
