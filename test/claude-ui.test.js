import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { MESSAGES } from '../src/sidepanel/messages.js';
import { DEFAULT_SETTINGS, mergeSettings } from '../src/lib/settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'src/sidepanel/index.html'), 'utf8');
const PANEL_CSS = fs.readFileSync(path.join(ROOT, 'src/sidepanel/panel.css'), 'utf8');
const WORKSPACE_CSS = fs.readFileSync(path.join(ROOT, 'src/sidepanel/workspace.css'), 'utf8');
const PANEL_JS = fs.readFileSync(path.join(ROOT, 'src/sidepanel/panel.js'), 'utf8');

function extractSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('header exposes the 3-button layout and moves settings/language into the overflow menu', () => {
  const actionsBlock = extractSlice(HTML, '<div class="actions">', '</header>');
  assert.match(actionsBlock, /id="sessionBtn"/);
  assert.match(actionsBlock, /id="newChatBtn"/);
  assert.match(actionsBlock, /id="overflowBtn"/);
  assert.doesNotMatch(actionsBlock, /id="settingsBtn"/);

  const overflowBlock = extractSlice(HTML, '<div id="overflowMenu"', '<div id="accountMenu"');
  assert.match(overflowBlock, /id="settingsBtn"/);
  assert.match(overflowBlock, /id="langBtn"/);
  assert.match(overflowBlock, /id="langSubmenu"/);
  assert.match(overflowBlock, /class="menu-row lang-option" data-lang="en"/);
  assert.match(overflowBlock, /class="menu-row lang-option" data-lang="ar"/);
  assert.match(overflowBlock, /id="accountBtn"/);
  assert.match(overflowBlock, /id="feedbackBtn"/);
});

test('empty canvas renders an inline SVG watermark and hides #chatLogSummary via workspace.css', () => {
  const emptyBlock = extractSlice(HTML, '<div class="empty" id="emptyState">', '</section>');
  assert.match(emptyBlock, /<svg class="empty-watermark"/);
  assert.doesNotMatch(emptyBlock, /<img\b/i);
  assert.match(emptyBlock, /class="empty-title sr-only"/);
  assert.match(emptyBlock, /class="empty-body muted sr-only"/);
  assert.match(emptyBlock, /class="empty-steps sr-only"/);

  assert.match(WORKSPACE_CSS, /#chatLog:has\(#emptyState:not\(\[hidden\]\)\)\s*>\s*#chatLogSummary\s*\{\s*display:\s*none;\s*\}/);
  assert.match(PANEL_CSS, /--bg:\s*#FAF9F5;/i);
});

test('composer popovers expose only real Postora actions (+ upload/project and Manual/Auto access)', () => {
  const plusBlock = extractSlice(HTML, '<div id="composerPlusMenu"', '<div id="accessMenu"');
  const plusButtons = plusBlock.match(/<button\b/g) ?? [];
  assert.equal(plusButtons.length, 2);
  assert.match(plusBlock, /id="uploadFilesBtn"/);
  assert.match(plusBlock, />Ctrl\+U</);
  assert.match(plusBlock, /id="projectBtn"/);
  assert.match(plusBlock, /data-i18n="project\.addToProject"/);

  const accessBlock = extractSlice(HTML, '<div id="accessMenu"', '<textarea id="input"');
  assert.match(accessBlock, /data-i18n="access\.menuTitle"/);
  assert.match(accessBlock, /id="accessOptionManual" data-mode="ask-first"/);
  assert.match(accessBlock, /id="accessOptionAuto" data-mode="full-access"/);
});

test('new Claude UI copy keys are defined in both English and Arabic', () => {
  const keys = [
    'composer.uploadFiles',
    'project.addToProject',
    'access.menuTitle',
    'access.manualTitle',
    'access.manualDesc',
    'access.autoTitle',
    'access.autoDesc',
    'thread.workedFor',
    'report.helpful',
    'report.notHelpful',
    'report.justNow',
    'report.minsAgo',
    'report.hoursAgo',
    'report.daysAgo',
  ];
  for (const lang of ['en', 'ar']) {
    for (const key of keys) {
      assert.equal(typeof MESSAGES[lang][key], 'string', `missing ${lang} key: ${key}`);
      assert.ok(MESSAGES[lang][key].length > 0, `empty ${lang} key: ${key}`);
    }
  }
});

test('reportActions renders helpfulness buttons, relative timestamp, and mutually exclusive thumbs state', () => {
  const code = extractSlice(PANEL_JS, 'function formatRelativeTime(', '\n/** Two overlapping squares');

  function makeClassList() {
    const set = new Set();
    return {
      add: (...cls) => { for (const c of cls) set.add(c); },
      remove: (...cls) => { for (const c of cls) set.delete(c); },
      contains: (c) => set.has(c),
      toggle: (c, force) => {
        const next = force === undefined ? !set.has(c) : Boolean(force);
        if (next) set.add(c);
        else set.delete(c);
        return next;
      },
      toString: () => [...set].join(' '),
    };
  }

  function createEl(tag) {
    const el = {
      tagName: tag.toUpperCase(),
      children: [],
      dataset: {},
      attrs: {},
      listeners: {},
      textContent: '',
      className: '',
      classList: null,
      append: (...nodes) => { el.children.push(...nodes); },
      setAttribute: (k, v) => { el.attrs[k] = String(v); },
      addEventListener: (ev, fn) => { (el.listeners[ev] ??= []).push(fn); },
      click: () => { for (const fn of el.listeners.click ?? []) fn(); },
    };
    el.classList = makeClassList();
    return el;
  }

  let feedbackClicks = 0;
  const feedbackMenu = { hidden: true };
  const feedbackBtn = { click: () => { feedbackClicks += 1; } };
  const now = 1_700_000_000_000;
  const FakeDate = class extends Date {
    static now() { return now; }
  };

  const ctx = {
    Date: FakeDate,
    Number,
    Math,
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
    Blob: class {},
    sessionId: 's1',
    sessionList: [],
    setTimeout: () => {},
    t: (key, vars = {}) => (vars.n !== undefined ? `${key}:${vars.n}` : key),
    $: (id) => ({ feedbackMenu, feedbackBtn }[id] ?? null),
    sessionLabel: () => 'Chat',
    reportFileName: () => 'report.md',
    copySquares: () => createEl('svg'),
    copyText: async () => {},
    showCopied: () => {},
    document: {
      createElement: createEl,
      createElementNS: (_ns, tag) => createEl(tag),
    },
    reportButton: (labelKey, child) => {
      const btn = createEl('button');
      btn.dataset.i18nTitle = labelKey;
      btn.append(child);
      return btn;
    },
  };

  vm.runInNewContext(code, ctx);

  assert.equal(ctx.formatRelativeTime(null), '');
  assert.equal(ctx.formatRelativeTime(now - 20_000), 'report.justNow');
  assert.equal(ctx.formatRelativeTime(now - 5 * 60_000), 'report.minsAgo:5');
  assert.equal(ctx.formatRelativeTime(now - 4 * 3_600_000), 'report.hoursAgo:4');
  assert.equal(ctx.formatRelativeTime(now - 2 * 86_400_000), 'report.daysAgo:2');

  const bar = ctx.reportActions('# Result', now - 4 * 3_600_000);
  assert.equal(bar.className, 'report-actions');
  assert.equal(bar.children.length, 5);
  const [copyBtn, upBtn, downBtn, exportBtn, timeEl] = bar.children;
  assert.equal(copyBtn.dataset.i18nTitle, 'report.copy');
  assert.equal(upBtn.dataset.i18nTitle, 'report.helpful');
  assert.equal(downBtn.dataset.i18nTitle, 'report.notHelpful');
  assert.equal(exportBtn.dataset.i18nTitle, 'report.export');
  assert.equal(timeEl.className, 'report-time');
  assert.equal(timeEl.textContent, 'report.hoursAgo:4');

  upBtn.click();
  assert.equal(upBtn.classList.contains('active'), true);
  assert.equal(downBtn.classList.contains('active'), false);

  downBtn.click();
  assert.equal(upBtn.classList.contains('active'), false);
  assert.equal(downBtn.classList.contains('active'), true);
  assert.equal(feedbackClicks, 1);

  downBtn.click();
  assert.equal(downBtn.classList.contains('active'), false);
  assert.equal(feedbackClicks, 1);
});

test('settings expose the uiTheme dropdown switching between Claude Minimal and Postora Classic', () => {
  assert.equal(DEFAULT_SETTINGS.uiTheme, 'claude');
  assert.equal(mergeSettings({ uiTheme: 'classic' }).uiTheme, 'classic');
  assert.equal(mergeSettings({ uiTheme: 'unexpected' }).uiTheme, 'claude');

  assert.match(HTML, /<html[^>]+data-ui-theme="claude"/);
  const settingsBlock = extractSlice(HTML, '<div class="settings-page" id="settingsIndex">', '<div class="settings-rows"');
  assert.match(settingsBlock, /id="uiTheme"/);
  assert.match(settingsBlock, /<option value="claude" data-i18n="theme\.claude"/);
  assert.match(settingsBlock, /<option value="classic" data-i18n="theme\.classic"/);

  for (const lang of ['en', 'ar']) {
    for (const key of ['theme.label', 'theme.claude', 'theme.classic']) {
      assert.equal(typeof MESSAGES[lang][key], 'string', `missing ${lang} key: ${key}`);
      assert.ok(MESSAGES[lang][key].length > 0, `empty ${lang} key: ${key}`);
    }
  }

  assert.match(WORKSPACE_CSS, /:root\[data-ui-theme="classic"\]\s+\.empty-watermark\s*\{\s*display:\s*none;\s*\}/);
  assert.match(WORKSPACE_CSS, /:root\[data-ui-theme="classic"\]\s+\.access-select\s*\{/);
  assert.match(WORKSPACE_CSS, /:root\[data-ui-theme="classic"\]\s+#brandCluster\s*\{/);
});

test('applyAndSaveTheme updates data-ui-theme, persists selection, and rolls back on save failure', async () => {
  const code = extractSlice(PANEL_JS, 'function applyTheme(', "\n$('uiTheme').addEventListener");
  const uiTheme = { value: 'claude' };
  const docEl = { dataset: { uiTheme: 'claude' } };
  const shownErrors = [];
  let failSave = false;

  const ctx = {
    settings: { uiTheme: 'claude' },
    document: { documentElement: docEl },
    $: (id) => (id === 'uiTheme' ? uiTheme : null),
    saveSettings: async (fn) => {
      if (failSave) throw new Error('disk full');
      ctx.settings = fn(ctx.settings);
      return ctx.settings;
    },
    showSettingsError: (msg) => { shownErrors.push(msg); },
  };

  vm.runInNewContext(code, ctx);

  await ctx.applyAndSaveTheme('classic');
  assert.equal(docEl.dataset.uiTheme, 'classic');
  assert.equal(uiTheme.value, 'classic');
  assert.equal(ctx.settings.uiTheme, 'classic');
  assert.deepEqual(shownErrors, []);

  failSave = true;
  await ctx.applyAndSaveTheme('claude');
  assert.equal(docEl.dataset.uiTheme, 'classic');
  assert.equal(uiTheme.value, 'classic');
  assert.equal(ctx.settings.uiTheme, 'classic');
  assert.deepEqual(shownErrors, ['disk full']);
});
