// Background coordinator: routes each side panel to its session's runner,
// answers settings and model-list requests, and owns the ChatGPT sign-in.

import { SessionRunner } from './session-runner.js';
import { testProviderSlot } from '../agent/model-session.js';
import { accountLoginState, cancelAccountLogin, requestedProvider, startAccountLogin, submitAccountInput, withKeepAlive } from './account-login.js';
import { fastClientFor } from '../fast/clients.js';
import { accountsIn, exportBackup, importBackup } from '../lib/backup.js';
import { errorResponse } from '../lib/errors.js';
import { COMPATIBLE_PRESETS, FAST_PRESETS, loadSettings, modelListRoute, saveSettings, slotModels } from '../lib/settings.js';
import { ACCOUNT_STORAGE_KEYS, accountStatus, signOut } from '../providers/account-auth.js';
import { importCodexAuthJson } from '../providers/chatgpt-auth.js';
import { listChatgptModels } from '../providers/chatgpt.js';
import { CLAUDE_CODE_IDENTITY, anthropicEfforts, listAnthropicModels } from '../providers/anthropic.js';
import { headerRules } from './header-rules.js';
import { listCompatibleModels } from '../providers/openai-compatible.js';
import { listGrokModels } from '../providers/responses.js';
import { listGeminiModels } from '../providers/named-api.js';
import { listKimiModels } from '../providers/kimi.js';
import { BrowserController } from '../browser/controller.js';
import * as store from '../sessions/store.js';
import * as tabSessions from '../sessions/tab-sessions.js';
import * as voiceClaims from '../sessions/voice-claims.js';
import { createVoiceAccess } from './voice-access.js';
import { afterGoogleSignIn, backUpToDrive, restoreFromDrive } from '../lib/drive-backup.js';
import { googleAccount } from '../lib/google-account.js';
import { forgetNotification, openFromNotification } from './notifications.js';
import { isMicRelay } from '../sidepanel/voice.js';

const GROUP_COLORS = ['cyan', 'blue', 'green', 'yellow', 'purple', 'pink', 'orange', 'red'];
const runners = new Map(); // sessionId → SessionRunner
const loading = new Map(); // sessionId → Promise<SessionRunner>
const panels = new Set(); // every open panel port, for list updates and sign-in errors
// The live panel connections, by their name. The name carries the session and
// the panel, so a request of the voice path can be checked against the
// connection it claims to come from.
const panelPorts = new Map();
// Blank sessions handed to a panel that has not connected yet; two panels opening
// at once must not both get the same one.
const reserved = new Set();
const RESERVATION_MS = 10000;
const DRIVE_BACKUP_DELAY_MS = 3000; // one upload for a burst of changes (a save writes several keys)
let driveBackupTimer = null;

// The browser the voice path borrows tabs with. One controller: the input of
// two voice commands never runs at the same time, so they cannot fight over
// the tab they work on.
const voiceBrowser = new BrowserController({ title: 'Postora voice' });
let voiceInputQueue = Promise.resolve();
function withVoiceBrowser(task) {
  const run = voiceInputQueue.then(task);
  voiceInputQueue = run.catch(() => {});
  return run;
}

// The worker's side of the voice path: the only place that may change a page
// for a spoken command, and the only place that may ask the authority about
// one.
const voiceAccess = createVoiceAccess({
  getRunner: (sessionId) => runnerFor(sessionId),
  panelPorts,
  voiceBrowser,
  withVoiceBrowser,
  ownerOfTab: (sessionId, tab) => isTakenByOther(sessionId, tab) || sessionWorkingIn(sessionId, tab),
});


chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(installHeaderRules);
chrome.runtime.onStartup.addListener(installHeaderRules);
// A worker that wakes after this file changes still has to install the rules.
// onInstalled does not run for that wake.
installHeaderRules();
chrome.tabs.onRemoved.addListener((tabId) => tabSessions.unbindTab(tabId));
// chrome.notifications exists only once the optional permission is granted, so the
// listeners are added at start-up when it is, and again when it is granted later.
listenToNotifications();
chrome.permissions.onAdded.addListener(listenToNotifications);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !(changes.settings || ACCOUNT_STORAGE_KEYS.some((key) => changes[key]))) return;
  clearTimeout(driveBackupTimer);
  driveBackupTimer = setTimeout(async () => {
    if (await googleAccount()) await backUpToDrive();
  }, DRIVE_BACKUP_DELAY_MS);
});

// Only this extension's own requests change; see header-rules.js for why each
// provider needs its rule.
async function installHeaderRules() {
  const rules = headerRules({
    extensionId: chrome.runtime.id,
    extensionVersion: chrome.runtime.getManifest().version,
    claudeCliVersion: CLAUDE_CODE_IDENTITY.version,
  });
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map((rule) => rule.id), addRules: rules });
}

function listenToNotifications() {
  if (!chrome.notifications || listenToNotifications.done) return;
  listenToNotifications.done = true;
  chrome.notifications.onClicked.addListener((id) => openFromNotification(id, {
    sessionExists: async (sessionId) => Boolean((await store.loadSession(sessionId))?.meta),
    bindTab: (tabId, sessionId) => tabSessions.bindTab(tabId, sessionId),
  }));
  chrome.notifications.onClosed.addListener((id) => forgetNotification(id));
}

async function runnerFor(sessionId) {
  if (runners.has(sessionId)) return runners.get(sessionId);
  if (!loading.has(sessionId)) {
    loading.set(sessionId, store.loadSession(sessionId).then((loaded) => {
      if (!loaded?.meta) throw new Error('This session no longer exists.');
      const runner = new SessionRunner({
        meta: loaded.meta,
        body: loaded,
        color: GROUP_COLORS[runners.size % GROUP_COLORS.length],
        isTakenByOther,
        onSessionsChanged: broadcastSessions,
      });
      runners.set(sessionId, runner);
      return runner;
    }).finally(() => loading.delete(sessionId)));
  }
  return loading.get(sessionId);
}

/** The title of another session that is running a task in this tab's group, or null. */
function isTakenByOther(selfId, tab) {
  // A session that is working in this very tab holds it, even when the tab is
  // not in a group: the user may have ungrouped it, or the group may be gone.
  for (const runner of runners.values()) {
    if (runner.id === selfId || !runner.running) continue;
    if (runner.browser.tabId === tab.id) return runner.title || 'another session';
  }
  if (tab.groupId === undefined || tab.groupId < 0) return null;
  for (const runner of runners.values()) {
    if (runner.id !== selfId && runner.running && runner.browser.groupId === tab.groupId) return runner.title || 'another session';
  }
  return null;
}

/**
 * The task of the session itself that is working in this tab. The voice path
 * belongs to a session too: it does not work on the page of a task that is
 * still running.
 */
function sessionWorkingIn(sessionId, tab) {
  const runner = runners.get(sessionId);
  if (!runner?.running) return null;
  if (runner.browser.tabId === tab.id || runner.browser.ownsTab(tab)) return runner.title || 'this session';
  return null;
}

function broadcastSessions() {
  for (const port of panels) port.postMessage({ type: 'sessions-changed' });
}

chrome.runtime.onConnect.addListener((port) => {
  // The port name carries the panel: 'panel:<session>' or, when the panel
  // takes part in the voice path, 'panel:<session>:<panel>'.
  const [kind, sessionId, panelId] = port.name.split(':');
  if (kind !== 'panel' || !sessionId) return;
  panels.add(port);
  panelPorts.set(port.name, port);
  reserved.delete(sessionId);
  port.onDisconnect.addListener(() => {
    panels.delete(port);
    if (panelPorts.get(port.name) === port) panelPorts.delete(port.name);
    // The panel is gone: the tabs it held are freed. The authorization of
    // every one of them is withdrawn at once, and each tab is given back when
    // its own cleanup is over.
    if (panelId) void releaseVoiceClaims(panelId);
  });
  // A panel whose port closed when the worker stopped reconnects as it sends, so
  // its task arrives while the session is still loading; it waits for the runner
  // instead of being dropped.
  const early = [];
  const hold = (msg) => early.push(msg);
  port.onMessage.addListener(hold);
  runnerFor(sessionId).then(
    (runner) => {
      port.onMessage.removeListener(hold);
      runner.attach(port, early);
    },
    () => port.postMessage({ type: 'session-missing' }),
  );
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // The microphone window talks to the side panel. It is not a worker request,
  // and an unknown type here would be reported as a failed call.
  if (isMicRelay(msg)) {
    sendResponse({ ok: true });
    return false;
  }
  handleRequest(msg, sender).then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse(errorResponse(err)),
  );
  return true;
});

async function handleRequest(msg, sender) {
  switch (msg.type) {
    case 'overlay-stop':
      return stopFromPage(sender);
    case 'get-settings':
      return { settings: await loadSettings(), presets: COMPATIBLE_PRESETS, fastPresets: FAST_PRESETS };
    case 'save-settings':
      return saveSettings(msg.settings);
    case 'auth-status':
      return authStatusFor(requestedProvider(msg));
    case 'backup-export':
      return exportBackup();
    case 'backup-import': {
      // A sign-in still running would poll, keep its tab and overwrite the
      // record the file brings.
      for (const provider of Object.keys(accountsIn(msg.data))) await cancelAccountLogin(provider);
      return importBackup(msg.data);
    }
    case 'auth-start':
      return startAccountLogin(requestedProvider(msg), { post: postToPanels });
    case 'auth-cancel':
      await cancelAccountLogin(requestedProvider(msg));
      return null;
    case 'auth-input':
      return submitAccountInput(requestedProvider(msg), msg.attemptId, msg.value);
    case 'auth-import':
      // A sign-in still running would poll, keep its tab and keep the worker awake.
      await cancelAccountLogin('chatgpt');
      await importCodexAuthJson(msg.text);
      return authStatusFor('chatgpt');
    case 'auth-logout': {
      const provider = requestedProvider(msg);
      await cancelAccountLogin(provider);
      await signOut(provider);
      return authStatusFor(provider);
    }
    case 'fast-test': {
      const ask = fastClientFor(msg.config);
      const { answers, model } = await ask({
        ...msg.config,
        state: { message: 'Hello, can you hear me?' },
        questions: { greeting: { type: 'noul', instructions: 'The message is a greeting or a connection check.' } },
      });
      return { model, noul: answers.greeting?.noul ?? null };
    }
    case 'provider-test':
      return withKeepAlive(async () => testProviderSlot(msg.slot, await loadSettings()));
    case 'list-fast-models': {
      const fixed = FAST_PRESETS[msg.config.provider]?.models;
      if (fixed) return fixed.map((id) => ({ id, name: id, efforts: [], decision: true }));
      return (await listCompatibleModels(msg.config.baseUrl, msg.config.apiKey)).filter((m) => m.decision);
    }
    case 'list-models': {
      const settings = msg.settings ?? (await loadSettings());
      // The model list needs a valid token, and a refresh takes longer than the
      // worker may idle, so it is kept awake until the token is stored.
      const route = modelListRoute(settings);
      if (route === 'chatgpt') return withKeepAlive(() => listChatgptModels());
      if (route === 'claude') {
        return withKeepAlive(async () => {
          const list = await listAnthropicModels({ auth: settings.claude?.auth ?? 'account', apiKey: settings.claude?.apiKey ?? '' });
          return withChosenModel(list, settings.claude?.model);
        });
      }
      if (route === 'grok') return withKeepAlive(() => listGrokModels());
      if (route === 'gemini') return withKeepAlive(() => listGeminiModels(settings.gemini));
      if (route === 'kimi') return withKeepAlive(() => listKimiModels(settings.kimi));
      const preset = settings.compatible.preset;
      let list = [];
      try {
        // The agent works through tool calls, so models known not to support them are left out.
        list = (await listCompatibleModels(settings.compatible.baseUrl, settings.compatible.apiKey)).filter((m) => !m.decision && m.tools !== false);
      } catch (err) {
        // A provider that serves no list of its own falls back to the preset's.
        if (!slotModels(preset, []).length) throw err;
      }
      return slotModels(preset, list);
    }
    case 'sessions-list':
      return (await store.listSessions()).map((meta) => ({ ...meta, running: Boolean(runners.get(meta.id)?.running) }));
    case 'session-create': {
      const meta = await store.createStoredSession();
      broadcastSessions();
      return meta;
    }
    case 'session-rename':
      await store.renameSession(msg.id, msg.title);
      await runners.get(msg.id)?.rename(String(msg.title).trim());
      broadcastSessions();
      return null;
    case 'session-delete':
      return deleteSession(msg.id);
    case 'drive-after-sign-in':
      return afterGoogleSignIn();
    case 'drive-backup-now':
      return backUpToDrive({ force: true });
    case 'drive-restore':
      return restoreFromDrive();
    case 'tab-session':
      return sessionForTab(await chrome.tabs.get(msg.tabId));
    case 'bind-tab':
      return tabSessions.bindTab(msg.tabId, msg.sessionId);
    case 'tab-owner':
      return tabOwner(await chrome.tabs.get(msg.tabId), msg.sessionId, msg.panelId);
    case 'voice-claim':
      return voiceAccess.handleClaim(msg, sender);
    case 'voice-release':
      await voiceAccess.releaseClaim(msg.tabId, msg.panelId, msg.token);
      return null;
    case 'voice-release-all':
      await voiceAccess.releasePanel(msg.panelId);
      return null;
    case 'voice-cancel':
      await voiceAccess.cancelCommand(msg, sender);
      return null;
    case 'voice-action':
      return voiceAccess.handleAction(msg, sender);
    default:
      throw new Error(`Unknown request ${msg.type}`);
  }
}

/**
 * Gives every lease of a panel back, and the command it was holding with
 * them. The panel is gone: nothing of it may run any more.
 */
async function releaseVoiceClaims(panelId) {
  await voiceAccess.releasePanel(panelId);
}
function sessionForTab(tab) {
  return tabSessions.sessionForTab(tab, {
    ownerOf: groupOwner,
    exists: async (id) => (await store.listSessions()).some((s) => s.id === id),
    createBlank: blankSession,
  });
}

/**
 * The session that is working in this tab, when it is not the one asking. The
 * voice path asks before it acts on a tab, so two sessions never work on the
 * same page. The claim of the voice path counts too: a tab it holds is not
 * free.
 */
function tabOwner(tab, sessionId, panelId) {
  const owner = isTakenByOther(sessionId, tab)
    || sessionWorkingIn(sessionId, tab)
    || voiceClaims.holderOf(tab.id, { exceptPanelId: panelId });
  return { taken: Boolean(owner), owner: owner ?? null };
}

/** The session whose tab group holds the tab; saved sessions count too, since the worker may have restarted. */
async function groupOwner(tab) {
  if (tab.groupId === undefined || tab.groupId < 0) return null;
  const live = [...runners.values()].find((r) => r.browser.ownsTab(tab));
  return live?.id ?? (await store.listSessions()).find((s) => s.groupId === tab.groupId)?.id ?? null;
}

/**
 * A fresh session for a tab that has none. An empty session no panel shows and no
 * other tab is bound to (`excluded`) is reused, so opening tabs does not pile up
 * blank sessions.
 */
async function blankSession(excluded = new Set()) {
  const unused = (await store.listSessions()).find((s) => {
    const runner = runners.get(s.id);
    return !s.titled && !reserved.has(s.id) && !excluded.has(s.id) && !runner?.running && !runner?.ports.size;
  });
  const id = unused?.id ?? (await store.createStoredSession()).id;
  reserved.add(id);
  setTimeout(() => reserved.delete(id), RESERVATION_MS);
  return id;
}

/** The Stop button the overlay draws on a page stops the session working in that tab. */
function stopFromPage(sender) {
  const tabId = sender.tab?.id;
  if (sender.id !== chrome.runtime.id || tabId === undefined) return null;
  for (const runner of runners.values()) {
    if (runner.running && runner.browser.tabId === tabId) runner.stop();
  }
  return null;
}

async function deleteSession(id) {
  const runner = runners.get(id);
  if (runner) {
    runner.dispose();
    await runner.browser.detachAll();
    runners.delete(id);
  }
  await store.deleteSession(id);
  await tabSessions.unbindSession(id);
  broadcastSessions();
  return null;
}

/** The account status of a provider, with the state of any sign-in running for it. */
async function authStatusFor(provider) {
  return { ...await accountStatus(provider), provider, login: accountLoginState(provider) };
}

/**
 * The model the user chose, with the efforts Anthropic's own table gives it,
 * even when the provider's list does not name it. The panel asks for the
 * efforts of the model it shows, and it cannot compute them itself.
 */
function withChosenModel(list, model) {
  const id = String(model ?? '').trim();
  if (!id || list.some((m) => m.id === id)) return list;
  return [...list, { id, name: id, description: '', efforts: anthropicEfforts(id), defaultEffort: null }];
}

/** Sends a message to every open panel. */
function postToPanels(message) {
  for (const port of panels) port.postMessage(message);
}
