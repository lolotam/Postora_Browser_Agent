import { renderMarkdown, reportFileName } from './markdown.js';
import { MIC_PANEL, MIC_WINDOW, micListenTarget, speechLang, voiceErrorKey } from './voice.js';
import { currentLanguage, resolveLanguage, setLanguage, t } from './i18n.js';
import { bindSearch, escapeAttr, pickModel, renderPicker } from './model-picker.js';
import { authMessage, authView, backupAuthView, changedProviders, withLoginEvent } from './auth-ui.js';
import { createKeyStore } from './key-store.js';
import { createProviderForm } from './provider-form.js';
import { request } from './request.js';
import { bindTestButton } from './test-button.js';
import { FEEDBACK_FORM_ID, afterDismissal, afterRating, sendFeedback, shouldAskForRating } from '../lib/feedback.js';
import { googleAccount, signInWithGoogle, signOutOfGoogle } from '../lib/google-account.js';
import { ACCOUNT_PROVIDERS, PROVIDER_LABELS, RECOMMENDED_SETUP, recommendedSlots, settingsProblem, slotSettings } from '../lib/settings.js';
import { STORE_BUILD } from '../lib/build.js';
import { packFiles } from '../lib/read-file.js';
import { FILE_LIMITS, readLocalFile } from './attach.js';
import { createFastAsk } from '../fast/clients.js';
import { approvalText as approvalMessage } from '../voice/voice-approval.js';
import { createVoiceController } from '../voice/voice-controller.js';
import { runFastCommand } from '../voice/voice-runner.js';
import { SECRET_TOKENS } from '../voice/voice-safety.js';
import { createChromeBrowser } from '../voice/voice-browser.js';

const $ = (id) => document.getElementById(id);

// The question that waits for an answer, and its number: a question that
// arrives while another one is being answered is a different question.
// `answering` is the number of the question whose answer is on its way: the
// question is answered once, and a second answer to it is refused.
const ui = { thread: null, pending: [], running: false, question: null, questionId: 0, answering: null, liveText: null, liveReasoning: null, trace: null, steps: new Map(), replayed: false, notices: [], stats: newStats() };
const MAX_NOTICES = 3;
let settings = null;
let presets = {};
let fastPresets = {};
let fastModels = [];
let fastFallbackModels = [];
const loads = { fast: 0, fastFallback: 0 }; // newest request wins when lists load concurrently
// The account providers: what the panel knows about each one's sign-in, the
// attempt it waits for, and the message its section shows.
const authState = { chatgpt: null, claude: null, grok: null };
const authAttempt = { chatgpt: null, claude: null, grok: null };
const authNote = { chatgpt: '', claude: '', grok: '' };

setLanguage(resolveLanguage('auto', chrome.i18n.getUILanguage()));

// ---------- chat ----------

// The panel shows one session; the port name tells the worker which.
// The worker can be stopped while the panel stays open, which closes the port,
// so it reconnects lazily on the next message instead of looping on restarts.
let port = null;
let sessionId = null;
let sessionList = [];
// The worker was gone and the panel is connected again: its sign-in state may
// have been lost with it.
let reconnected = false;

function connect() {
  // The port name carries the panel: the worker gives the tabs this panel
  // holds back when the port closes.
  port = chrome.runtime.connect({ name: `panel:${sessionId}:${voicePanelId}` });
  port.onMessage.addListener(onEvent);
  // The worker is gone: the task it was running is gone with it.
  port.onDisconnect.addListener(() => {
    port = null;
    reconnected = true;
    cancelVoiceTask(t('voice.cancelled'));
    // The claims of this panel are given back: the worker may be gone, and a
    // tab that nobody holds is free again.
    releaseVoiceClaims();
  });
  // The worker may have restarted and lost the sign-in it was in the middle of.
  if (reconnected) {
    reconnected = false;
    refreshAuthStates().catch(() => {});
  }
}

// Picking the session (as the panel opens, or after a tab switch) takes a round
// trip to the worker. A message sent meanwhile waits for it: sent at once, it would
// go to no session yet, or to the one the panel is leaving, and vanish from view.
let picking = null;

function pick(choose) {
  const run = choose().finally(() => {
    if (picking === run) picking = null;
  });
  picking = run;
  return run;
}

async function send(message, { signal, expectedSessionId } = {}) {
  while (picking) await picking.catch(() => {});
  if (!sessionId) await showTabSession(); // the lookup on open failed; the message still needs a session
  signal?.throwIfAborted();
  if (expectedSessionId !== undefined && expectedSessionId !== sessionId) {
    throw new DOMException('Session changed', 'AbortError');
  }
  if (!port) connect();
  port.postMessage(message);
}

function onEvent(event) {
  switch (event.type) {
    case 'replay':
      // A restarted worker replays the transcript. It is history: it is drawn
      // again, but it does not act on what is on screen now.
      if (!ui.replayed || event.events?.length) {
        clearMessages();
        replaying = true;
        ui.replayed = false; // the finals of the history are not live ones
        event.events.forEach(onEvent);
        ui.replayed = true;
        replaying = false;
      }
      setRunning(event.running);
      if (event.question) setQuestion(event.question);
      ui.pending = event.pending ?? [];
      renderPending();
      break;
    case 'status':
      setRunning(event.running);
      if (!event.running) {
        // The task ended without a report: it did not succeed.
        const entry = voiceEntryFor(event);
        if (entry) {
          entry.setErr(t('voice.failed'));
          finishVoiceTask();
        }
      }
      break;
    case 'user': {
      const node = add(event.steer ? 'msg user steer' : 'msg user', event.text);
      if (event.steer) node.dataset.tag = t('msg.steered');
      // An answer to ask_user or a message sent while working is part of the task.
      if (!event.answer && !event.steer) ui.stats = newStats(event.at);
      break;
    }
    case 'pending-added':
      ui.pending.push(event.item);
      renderPending();
      break;
    case 'pending-removed':
      ui.pending = ui.pending.filter((m) => m.id !== event.id);
      renderPending();
      break;
    case 'turn-end':
      addTurn(event);
      break;
    case 'usage':
      if (event.source === 'fast' && event.usage) {
        ui.stats.fastIn += event.usage.input;
        ui.stats.fastOut += event.usage.output;
      }
      break;
    case 'thinking':
      openThread(event.step);
      break;
    case 'reasoning-delta':
      ui.liveReasoning ??= threadPart('msg reasoning');
      ui.liveReasoning.textContent += event.delta;
      if (ui.thread) {
        ui.thread.reasoning += event.delta;
        ui.thread.title.textContent = threadTitle(ui.thread);
      }
      scrollDown();
      break;
    case 'text-delta':
      ui.liveText ??= threadPart('msg assistant');
      ui.liveText.textContent += event.delta;
      scrollDown();
      break;
    case 'text-reset':
      ui.liveText?.remove();
      ui.liveText = null;
      break;
    case 'assistant-text':
      (ui.liveText ?? threadPart('msg assistant')).innerHTML = renderMarkdown(event.text);
      ui.liveText = null;
      if (ui.thread) {
        ui.thread.text = event.text;
        ui.thread.title.textContent = threadTitle(ui.thread);
      }
      break;
    case 'turn-interrupted':
      ui.thread?.box.classList.add('interrupted');
      closeThread();
      break;
    case 'tool-start':
      if (event.fast) closeThread(); // the fast layer acts between model turns
      if (ui.thread) {
        ui.thread.tools.push(event.name);
        ui.thread.title.textContent = threadTitle(ui.thread);
      }
      addStep(event);
      voiceEntryFor(event)?.setStatus(`${t('status.running')} · ${event.name}`, 'thinking');
      break;
    case 'fast-handoff':
      closeThread();
      traceBlock().append(Object.assign(document.createElement('div'), { className: 'step handoff', textContent: `⚡→🧠 ${event.reason}` }));
      scrollDown();
      break;
    case 'tool-end': {
      // Sessions saved before call ids existed match by step and name.
      const row = ui.steps.get(event.callId ?? event.step + event.name);
      if (row) {
        row.classList.toggle('fail', !event.ok);
        row.querySelector('.mark').textContent = event.ok ? '✓' : '✗';
        row.title = event.summary;
        if (Number.isFinite(event.ms)) row.append(span('time', formatDuration(event.ms)));
      }
      const voiceEntry = voiceEntryFor(event);
      if (voiceEntry) {
        const mark = event.ok ? '✓' : '✗';
        voiceEntry.setStatus(`${mark} ${event.summary || event.name}`, event.ok ? 'ok' : 'err');
      }
      break;
    }
    case 'ask':
      closeThread();
      if (replaying) {
        // A question from the history: it is shown, but it is not a question
        // that is waiting for an answer, and it changes nothing on screen.
        add('msg ask', event.question);
        break;
      }
      // The question has to be answered: the chat is shown, so it is never
      // hidden behind the voice screen.
      showChat();
      setQuestion(event.question);
      // The task waits for the answer, but the command that started it is
      // over: the screen is free again, so the answer may be given by voice,
      // and no new task is started for it. The entry of the command keeps
      // the events of the task.
      settleVoiceCommand();
      break;
    case 'final': {
      ui.liveText?.remove();
      ui.liveText = null;
      const node = add(`msg final${event.success ? '' : ' partial'}`, '');
      node.innerHTML = renderMarkdown(event.report);
      const heading = document.createElement('h3');
      heading.textContent = t(event.success ? 'report.final' : 'report.partial');
      node.prepend(heading);
      const totals = totalsLine(event.at);
      if (totals) node.append(totals);
      node.append(reportActions(event.report));
      if (ui.replayed) askForRating(); // live finals only, not the history replayed on open
      const voiceEntry = voiceEntryFor(event);
      if (voiceEntry) {
        // A report that says the task failed is never shown as a success.
        if (event.success) {
          voiceEntry.setOk(t('voice.success'));
          voiceController?.speak(t('voice.doneSpoken'));
        } else {
          voiceEntry.setErr(t('voice.partial'));
          voiceController?.speak(t('voice.partialSpoken'));
        }
        finishVoiceTask();
      }
      break;
    }
    case 'error':
      add('msg error', event.message);
      voiceEntryFor(event)?.setErr(event.message);
      if (!replaying) finishVoiceTask();
      break;
    case 'stopped':
      add('msg error', t('msg.stopped'));
      voiceEntryFor(event)?.setErr(t('voice.cancelled'));
      if (!replaying) finishVoiceTask();
      break;
    case 'notice':
      ui.notices.push(event);
      renderNotices();
      break;
    case 'notice-dismissed':
      ui.notices = ui.notices.filter((n) => n.id !== event.id);
      renderNotices();
      break;
    case 'sessions-changed':
      refreshSessions();
      break;
    case 'session-missing':
      showTabSession();
      break;
    case 'auth-success':
      authNote[event.provider] = '';
      refreshAuthState(event.provider).catch(() => {});
      break;
    case 'auth-event':
      // The worker opened the sign-in page, or it has a device code to show.
      authState[event.provider] = withLoginEvent(authState[event.provider], event);
      authAttempt[event.provider] = event.attemptId;
      if (event.kind === 'device_code') showDeviceCode(event.provider, event.userCode, event.verificationUrl);
      break;
    case 'auth-prompt':
      // The flow asks for the code the provider's page shows.
      authState[event.provider] = withLoginEvent(authState[event.provider], event);
      authAttempt[event.provider] = event.attemptId;
      showCodePrompt(event.provider, true);
      break;
    case 'auth-error':
      authState[event.provider] = withLoginEvent(authState[event.provider], event);
      showAuthError(event.provider, event.message, event.code);
      break;
    default:
      break;
  }
}

/** A message inside the current turn's thread, or in the chat when there is none. */
function threadPart(className) {
  if (!ui.thread) return add(className, '');
  const node = Object.assign(document.createElement('div'), { className, dir: 'auto' });
  if (ui.thread.trace) ui.thread.body.insertBefore(node, ui.thread.trace);
  else ui.thread.body.append(node);
  scrollDown();
  return node;
}

/** A message in the chat itself (the user, a report, an error): the open thread closes. */
function add(className, text) {
  closeThread();
  $('emptyState').hidden = true;
  ui.trace = null;
  const node = document.createElement('div');
  node.className = className;
  node.dir = 'auto';
  node.textContent = text;
  $('messages').append(node);
  scrollDown();
  return node;
}

/**
 * Consecutive tool steps and fast-layer hand-overs share one trace block: inside the
 * current model turn's thread, or on its own for fast-layer steps between turns.
 */
function traceBlock() {
  $('emptyState').hidden = true;
  if (ui.thread) {
    if (!ui.thread.trace) {
      ui.thread.trace = Object.assign(document.createElement('div'), { className: 'trace' });
      ui.thread.body.append(ui.thread.trace);
    }
    return ui.thread.trace;
  }
  if (!ui.trace) {
    ui.trace = document.createElement('div');
    ui.trace.className = 'trace';
    $('messages').append(ui.trace);
  }
  return ui.trace;
}

/**
 * One model turn as a thread: a single collapsible line (its first thought, or its
 * text or tools) holding the reasoning, any text and the turn's tool steps. Open
 * while the turn works; it closes when the next turn starts or the task ends,
 * unless the user opened or closed it by hand.
 */
function openThread(step) {
  closeThread();
  $('emptyState').hidden = true;
  ui.trace = null;
  const box = Object.assign(document.createElement('details'), { className: 'thread', open: true });
  const summary = document.createElement('summary');
  const title = span('title', t('thread.thinking'));
  title.dir = 'auto';
  const meta = span('meta', '');
  summary.append(title, meta);
  const body = Object.assign(document.createElement('div'), { className: 'thread-body' });
  box.append(summary, body);
  $('messages').append(box);
  const thread = { box, title, meta, body, step, reasoning: '', text: '', tools: [], trace: null, userToggled: false };
  summary.addEventListener('click', () => { thread.userToggled = true; });
  ui.thread = thread;
  scrollDown();
}

function closeThread() {
  const thread = ui.thread;
  if (!thread) return;
  if (!thread.userToggled) thread.box.open = false;
  thread.title.textContent = threadTitle(thread);
  ui.thread = null;
  ui.liveReasoning = null;
  ui.liveText = null;
}

/** The thread's line: its first sentence of thought, else its text, else its tools. */
function threadTitle(thread) {
  const first = (text) => text.trim().split(/(?<=[.!?؟])\s|\n/)[0].trim();
  const line = first(thread.reasoning) || first(thread.text) || [...new Set(thread.tools)].join(', ');
  if (!line) return t('thread.step', { n: thread.step ?? '' });
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
}

function addStep({ step, callId, name, args, fast }) {
  const row = document.createElement('div');
  row.className = fast ? 'step fast' : 'step';
  const compact = JSON.stringify(args ?? {}).replace(/^\{|\}$/g, '');
  row.innerHTML = '<span class="mark">…</span><span class="name"></span><span class="args"></span>';
  row.querySelector('.name').textContent = `${step}. ${name}`;
  row.querySelector('.args').textContent = compact;
  traceBlock().append(row);
  ui.steps.set(callId ?? step + name, row);
  scrollDown();
}

function newStats(start = null) {
  return { start, input: 0, output: 0, missing: 0, turns: 0, fastIn: 0, fastOut: 0 };
}

function span(className, text) {
  return Object.assign(document.createElement('span'), { className, textContent: text });
}

const number = (n) => n.toLocaleString('en-US');

/** 0.4s, 12.3s, 2m 05s. */
function formatDuration(ms) {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** One model turn in the trace: who answered, how long it thought, and its tokens. */
function addTurn({ model, ms, retryWaitMs, usage }) {
  ui.stats.turns += 1;
  if (usage) {
    ui.stats.input += usage.input;
    ui.stats.output += usage.output;
  } else {
    ui.stats.missing += 1;
  }
  const tokens = usage ? t('stats.tokens', { input: number(usage.input), output: number(usage.output) }) : '';
  const waited = retryWaitMs ? t('stats.retryWait', { time: formatDuration(retryWaitMs) }) : '';
  const time = Number.isFinite(ms) ? formatDuration(ms) : '';
  if (ui.thread) {
    // On the thread's own line: the model, its time and its tokens.
    ui.thread.meta.textContent = [time, tokens, waited].filter(Boolean).join(' · ');
    ui.thread.meta.title = model || '';
    return;
  }
  const row = document.createElement('div');
  row.className = 'step turn';
  row.append(span('mark', '◆'), span('name', model || 'model'));
  row.append(span('args', [tokens, waited].filter(Boolean).join(' · ')));
  if (time) row.append(span('time', time));
  traceBlock().append(row);
  scrollDown();
}

/** Under the final report: the whole task's time and tokens. */
function totalsLine(end) {
  const { start, input, output, missing, turns, fastIn, fastOut } = ui.stats;
  if (!start || !end) return null; // sessions saved before timings existed
  const parts = [t('stats.total', { time: formatDuration(end - start) })];
  if (turns > missing) parts.push(t('stats.totalTokens', { input: number(input), output: number(output) }) + (missing ? ` ${t('stats.partial')}` : ''));
  if (fastIn || fastOut) parts.push(t('stats.fast', { input: number(fastIn), output: number(fastOut) }));
  return Object.assign(document.createElement('div'), { className: 'totals', textContent: parts.join(' · ') });
}

/** Copy and Markdown export, in the report's lower corner. */
function reportActions(markdown) {
  const bar = document.createElement('div');
  bar.className = 'report-actions';
  const copy = reportButton('report.copy', copySquares());
  const save = reportButton('report.export', Object.assign(document.createElement('span'), { className: 'md', textContent: 'md' }));
  copy.addEventListener('click', async () => {
    try {
      await copyText(markdown);
      showCopied(copy);
    } catch {
      copy.dataset.i18nTitle = 'report.copyFailed';
      copy.title = t('report.copyFailed');
      copy.setAttribute('aria-label', copy.title);
    }
  });
  save.addEventListener('click', () => {
    const title = sessionLabel(sessionList.find((s) => s.id === sessionId));
    const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown' }));
    const name = reportFileName(title, new Date().toISOString().slice(0, 10), t('session.untitled'));
    Object.assign(document.createElement('a'), { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  bar.append(copy, save);
  return bar;
}

function reportButton(labelKey, child) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost';
  button.dataset.i18nTitle = labelKey;
  button.title = t(labelKey);
  button.setAttribute('aria-label', button.title);
  button.append(child);
  return button;
}

/** Two overlapping squares, the usual copy mark. */
function copySquares() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '13');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = '<rect x="5.4" y="5.4" width="8" height="8" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.4"></rect><path d="M10.4 4.6V3.4A1.4 1.4 0 0 0 9 2H3.4A1.4 1.4 0 0 0 2 3.4V9A1.4 1.4 0 0 0 3.4 10.4H4.6" fill="none" stroke="currentColor" stroke-width="1.4"></path>';
  return svg;
}

function showCopied(button) {
  button.classList.add('copied');
  button.dataset.i18nTitle = 'report.copied';
  button.title = t('report.copied');
  button.setAttribute('aria-label', button.title);
  const mark = Object.assign(document.createElement('span'), { className: 'tick', textContent: '✓' });
  button.replaceChildren(mark);
  setTimeout(() => {
    button.classList.remove('copied');
    button.dataset.i18nTitle = 'report.copy';
    button.title = t('report.copy');
    button.setAttribute('aria-label', button.title);
    button.replaceChildren(copySquares());
  }, 1500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // The side panel sometimes has no clipboard permission; the selection fallback still works.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy failed');
}

function clearMessages() {
  ui.thread = null;
  $('messages').querySelectorAll('.msg, .trace, .thread').forEach((n) => n.remove());
  ui.pending = [];
  renderPending();
  ui.steps.clear();
  ui.trace = null;
  ui.notices = [];
  renderNotices();
}

const NOTICE_TEXT = { switched: 'notice.switched', 'both-failed': 'notice.bothFailed', 'fast-switched': 'notice.fastSwitched', retrying: 'notice.retrying' };

/** Newest first; the full provider error is in the tooltip. */
function renderNotices() {
  $('notices').replaceChildren(...ui.notices.slice(-MAX_NOTICES).reverse().map((notice) => {
    const reason = notice.code && notice.code !== 'other' ? t(`failure.${notice.code}`) : notice.reason;
    const row = document.createElement('div');
    row.className = `notice ${notice.level}`;
    row.title = notice.detail ?? '';
    row.dir = 'auto';
    const text = document.createElement('span');
    text.textContent = `⚠ ${t(NOTICE_TEXT[notice.kind] ?? 'notice.switched', { from: notice.from ?? '', to: notice.to ?? '', reason })}`;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'ghost icon';
    close.textContent = '×';
    close.setAttribute('aria-label', t('notice.dismiss'));
    close.addEventListener('click', () => send({ type: 'dismiss-notice', id: notice.id }));
    row.append(text, close);
    return row;
  }));
}

const PENDING_CHIP = { 'next-step': 'pending.nextStep', interrupt: 'pending.interrupt', queue: 'pending.queue' };

/** Messages waiting to be read, above the composer, each with Send now and Remove. */
function renderPending() {
  const list = $('pending');
  list.hidden = !ui.pending.length;
  list.replaceChildren(...ui.pending.map((m) => {
    const row = document.createElement('li');
    const text = span('text', m.text);
    text.dir = 'auto';
    text.title = m.text;
    row.append(text, span('chip', t(m.now ? 'pending.interrupt' : PENDING_CHIP[m.mode] ?? 'pending.nextStep')));
    if (!m.now) {
      const now = Object.assign(document.createElement('button'), { type: 'button', textContent: '⚡', title: t('pending.sendNow') });
      now.setAttribute('aria-label', t('pending.sendNow'));
      now.addEventListener('click', () => send({ type: 'steer-now', id: m.id }));
      row.append(now);
    }
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '×', title: t('pending.remove') });
    remove.setAttribute('aria-label', t('pending.remove'));
    remove.addEventListener('click', () => send({ type: 'steer-cancel', id: m.id }));
    row.append(remove);
    return row;
  }));
}

function setQuestion(question) {
  ui.question = question;
  ui.questionId += 1;
  add('msg ask', question);
  showPendingQuestion(question);
  $('hint').textContent = t('status.waiting');
  $('sendBtn').hidden = false;
  $('input').focus();
}

/**
 * A question that is waiting for an answer stays visible in the voice screen:
 * it is never hidden behind it, and the user can go back to the chat to
 * answer it there.
 */
function showPendingQuestion(question) {
  const box = $('voicePending');
  if (!box) return;
  if (!question) {
    box.hidden = true;
    return;
  }
  $('voicePendingText').textContent = question;
  box.hidden = false;
}

/**
 * The question that was answered is gone: the card is hidden, the panel waits
 * for the task again and the send button goes away with it. A question that
 * arrived while the answer was on its way is a different one: it keeps its
 * card, its hint and its button.
 */
function clearAnsweredQuestion(questionId) {
  if (ui.questionId !== questionId) return false;
  ui.question = null;
  showPendingQuestion(null);
  $('hint').textContent = t('status.running');
  $('sendBtn').hidden = true;
  return true;
}

/**
 * The answer to a question went out (or failed): the question may be
 * answered again. Only the answer that is on its way is released, so a newer
 * question keeps its own.
 */
function releaseAnswer(questionId) {
  if (ui.answering === questionId) ui.answering = null;
}

function setRunning(running) {
  ui.running = running;
  if (!running) closeThread();
  $('statusDot').classList.toggle('running', running);
  $('stopBtn').hidden = !running;
  $('sendBtn').hidden = false; // while running, a message steers the task (see steerMode)
  if (!running) {
    ui.question = null;
    showPendingQuestion(null);
    $('hint').textContent = '';
  } else if (!ui.question) {
    $('hint').textContent = t('status.running');
  }
}

function scrollDown() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

let attachments = [];

function fileWarning(file) {
  if (file.warning === 'too-big') return t('composer.fileBig', { name: file.name });
  if (file.warning === 'unreadable-image') return t('composer.fileBad', { name: file.name });
  return file.warning || '';
}

function renderFiles() {
  const list = $('fileChips');
  list.hidden = attachments.length === 0;
  list.replaceChildren(...attachments.map((file) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'text';
    name.textContent = file.pending ? `${file.name}…` : file.name;
    const warning = fileWarning(file);
    if (warning) name.title = warning;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = t('composer.removeFile');
    remove.setAttribute('aria-label', t('composer.removeFile'));
    remove.addEventListener('click', () => {
      attachments = attachments.filter((item) => item.id !== file.id);
      renderFiles();
    });
    li.append(name, remove);
    return li;
  }));
}

async function addFiles(files) {
  const room = FILE_LIMITS.maxFiles - attachments.length;
  if (files.length > room) $('hint').textContent = t('composer.fileMany', { n: FILE_LIMITS.maxFiles });
  for (const file of files.slice(0, Math.max(0, room))) {
    const id = crypto.randomUUID();
    attachments.push({ id, name: file.name, pending: true, text: '', warning: '', images: [] });
    renderFiles();
    try {
      const read = await readLocalFile(file);
      const slot = attachments.find((item) => item.id === id);
      if (slot) Object.assign(slot, read, { pending: false, id });
    } catch {
      const slot = attachments.find((item) => item.id === id);
      if (slot) Object.assign(slot, { pending: false, warning: 'unreadable-image' });
    }
    renderFiles();
  }
}

function submitComposer(text, { tabId, signal, expectedSessionId } = {}) {
  signal?.throwIfAborted();
  const value = text.trim();
  if (!value && !attachments.length) return Promise.resolve(false);
  if (attachments.some((file) => file.pending)) {
    $('hint').textContent = t('composer.reading');
    return Promise.resolve(false);
  }
  const packed = packFiles(value, attachments, t('composer.filesTask'));
  if (!packed) {
    $('hint').textContent = t('composer.fileNone');
    return Promise.resolve(false);
  }
  // The question that is answered is remembered by its number: it is only
  // cleared when the answer really went out, and only when it is still the
  // question that waits.
  const questionId = ui.questionId;
  const answering = Boolean(ui.question);
  // One question is answered once: while the answer is on its way, another
  // answer to the same question is refused, and the draft of the user is left
  // alone. The guard is taken before anything is cleared or sent.
  if (answering && ui.answering === questionId) return Promise.resolve(false);
  if (answering) ui.answering = questionId;
  attachments = [];
  renderFiles();
  $('input').value = '';
  const message = { text: packed.task, display: packed.display, images: packed.images };
  const options = { signal, expectedSessionId };
  let sent;
  if (ui.question) {
    sent = send({ type: 'answer', ...message }, options);
  } else if (ui.running) {
    sent = send({ type: 'steer', ...message, mode: settings?.steerMode ?? 'next-step' }, options);
  } else {
    // The tab the task works on: the one the voice command was meant for.
    sent = send({ type: 'run', ...message, ...(tabId ? { tabId } : {}) }, options);
  }
  return sent.then(() => {
    if (answering) clearAnsweredQuestion(questionId);
    releaseAnswer(questionId);
    return true;
  }, (err) => {
    // The answer did not go out: the question stays, and it may be answered
    // again.
    releaseAnswer(questionId);
    throw err;
  });
}

/**
 * A voice command is a message of its own: it never takes the files the user
 * attached, it never clears what they wrote, and it never waits for a file
 * that is still being read. It answers the question that is waiting, or it
 * starts a task.
 */
function sendVoiceMessage(text, { tabId, signal, expectedSessionId } = {}) {
  signal?.throwIfAborted();
  const value = String(text ?? '').trim();
  if (!value) return Promise.resolve(false);
  const message = { text: value, display: value, images: [] };
  const options = { signal, expectedSessionId };
  let sent;
  // The question that is answered is remembered by its number: it is only
  // cleared when the answer really went out, and only when it is still the
  // question that waits.
  const questionId = ui.questionId;
  const answering = Boolean(ui.question);
  // The same guard as the composer: one question is answered once, and the
  // answer of the voice and the answer of the keyboard do not both go out.
  if (answering && ui.answering === questionId) return Promise.resolve(false);
  if (answering) ui.answering = questionId;
  if (ui.question) {
    sent = send({ type: 'answer', ...message }, options);
  } else if (ui.running) {
    sent = send({ type: 'steer', ...message, mode: settings?.steerMode ?? 'next-step' }, options);
  } else {
    // The tab the task works on: the one the voice command was meant for.
    sent = send({ type: 'run', ...message, ...(tabId ? { tabId } : {}) }, options);
  }
  return sent.then(() => {
    if (answering) clearAnsweredQuestion(questionId);
    releaseAnswer(questionId);
    return true;
  }, (err) => {
    releaseAnswer(questionId);
    throw err;
  });
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  submitComposer($('input').value).catch(() => {});
});
$('attachBtn').addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', () => {
  addFiles([...$('fileInput').files]);
  $('fileInput').value = '';
});
$('composerBox').addEventListener('dragover', (event) => {
  event.preventDefault();
  $('composerBox').classList.add('dropping');
});
$('composerBox').addEventListener('dragleave', () => $('composerBox').classList.remove('dropping'));
$('composerBox').addEventListener('drop', (event) => {
  event.preventDefault();
  $('composerBox').classList.remove('dropping');
  addFiles([...event.dataTransfer.files]);
});

// ---------- voice control ----------

// The pages the extension may not work on: its own pages and Chrome's.
const RESTRICTED_URL = /^(chrome|chrome-extension|edge|about|devtools|view-source):/;

// 'prompt' until Chrome reports the extension's own microphone permission.
let micPermission = 'prompt';
// Set when the side panel is allowed the microphone and recognition still refuses.
let panelMicBroken = false;
let micWindowId = null;
// Every microphone window carries the epoch it was opened with. A window from
// an earlier command cannot answer the current one, and a panel only stops the
// window it opened.
// Each panel gets a distinct counter range; two panels must not share epoch 1.
let micEpoch = crypto.getRandomValues(new Uint32Array(1))[0] * 1048576;
let micCaptureOpen = false;
let voiceViewToken = 0;
// The tab the voice commands act on. The microphone window takes the focus, so
// the tab is remembered before that window opens.
let voiceOrigin = null;
// Every panel has its own id: the claim it takes on a tab belongs to it, and
// no other panel may take it away.
const voicePanelId = crypto.randomUUID();
// The command the worker is running for this panel, and the log entry it owns.
let voiceTask = null;
let voiceController = null;
let voiceState = 'idle';
// The approval that is waiting for the user, so it can be withdrawn.
let voiceApproval = null;
// The history the worker replayed is not a live event.
let replaying = false;

function watchMicrophone() {
  const query = navigator.permissions?.query;
  if (!query) {
    micPermission = 'unknown';
    return;
  }
  query.call(navigator.permissions, { name: 'microphone' }).then((status) => {
    micPermission = status.state;
    status.onchange = () => { micPermission = status.state; };
  }).catch(() => { micPermission = 'unknown'; });
}

function relayMic(kind) {
  chrome.runtime.sendMessage({ source: MIC_PANEL, kind, epoch: micEpoch }).catch(() => {});
}

/** The tab the user is looking at, when the extension may work on it. */
async function userTab() {
  const [focused] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused && !RESTRICTED_URL.test(focused.url ?? '')) {
    return { id: focused.id, windowId: focused.windowId, url: focused.url || '', title: focused.title || '' };
  }
  // The window that has the focus may be one the extension cannot work on
  // (the microphone's own window, on its way out): the tab of the window the
  // panel is in is the one the user is looking at.
  const [own] = windowId == null ? [] : await chrome.tabs.query({ active: true, windowId });
  if (!own || RESTRICTED_URL.test(own.url ?? '')) return null;
  return { id: own.id, windowId: own.windowId, url: own.url || '', title: own.title || '' };
}

/**
 * The tab the voice commands act on. While the microphone window is open it
 * has the focus, so the tab the user was on is the one that is remembered.
 * The window that has the focus may be one the extension cannot work on (the
 * microphone's own window, on its way out): the tab of the window the panel
 * is in is the one the user is looking at.
 */
async function voiceTarget() {
  if (micCaptureOpen) return voiceOrigin;
  const tab = await userTab();
  voiceOrigin = tab;
  return voiceOrigin;
}

/** Gives every tab this panel holds back, so another command may use it. */
async function releaseVoiceClaims() {
  try {
    await request('voice-release-all', { panelId: voicePanelId });
  } catch {
    /* the worker is gone: the claims are gone with it */
  }
}

/** The microphone window: a real window, so Chrome can ask for the microphone. */
async function openMicWindow({ continuous = false } = {}) {
  $('voiceLive').textContent = t(micPermission === 'denied' ? 'composer.micDenied' : 'composer.micAsk');
  if (micWindowId != null) {
    try {
      await chrome.windows.update(micWindowId, { focused: true });
      return;
    } catch { micWindowId = null; }
  }
  // The window takes the focus: the tab the command belongs to is remembered
  // before it opens.
  const epoch = ++micEpoch;
  await voiceTarget();
  if (micEpoch !== epoch) return;
  micCaptureOpen = true;
  const url = chrome.runtime.getURL(`src/sidepanel/mic.html?lang=${encodeURIComponent(currentLanguage())}&epoch=${epoch}&continuous=${continuous ? '1' : '0'}`);
  let created;
  try {
    created = await chrome.windows.create({ url, type: 'popup', width: 420, height: 360, focused: true });
  } catch {
    if (micEpoch === epoch) {
      micCaptureOpen = false;
      voiceController?.handleCaptureEnded();
    }
    $('voiceLive').textContent = t('composer.micFailed');
    return;
  }
  // The capture may have been stopped while the window was being created: the
  // window that arrived late is closed again, so it does not keep recording.
  if (micEpoch !== epoch) {
    chrome.windows.remove(created.id).catch(() => {});
    return;
  }
  micWindowId = created?.id ?? null;
}

function closeMicWindow() {
  const epoch = micEpoch;
  micWindowId = null;
  micCaptureOpen = false;
  micEpoch += 1; // what the old window says from now on is stale
  chrome.runtime.sendMessage({ source: MIC_PANEL, kind: 'cancel', epoch }).catch(() => {});
}

/** What the microphone window heard. Only the window of this epoch counts. */
function onMicMessage(message) {
  if (message?.source !== MIC_WINDOW || Number(message.epoch) !== micEpoch) return;
  if (message.kind === 'partial') {
    voiceController?.handlePartial(message.text || '');
    return;
  }
  if (message.kind === 'moved') {
    // The window moved to a tab, where Chrome can ask for the microphone.
    $('voiceLive').textContent = t('composer.micAsk');
    // The permission tab owns the relay now; closing the old popup is not an end.
    micWindowId = null;
    return;
  }
  if (message.kind === 'final' || message.kind === 'end') {
    const text = String(message.text || '').trim();
    if (!text) {
      $('voiceLive').textContent = t('composer.micEmpty');
      return;
    }
    voiceController?.handleFinal(text);
    return;
  }
  if (message.kind === 'ended') {
    // The window stopped listening: the capture is over.
    voiceController?.handleCaptureEnded();
    return;
  }
  if (message.kind === 'error') {
    voiceController?.handleError(message.code);
  }
}

// ---------- the voice screen ----------

/** One line of the activity log: the command, and what came of it. */
function voiceLogEntry(command) {
  const log = $('voiceLog');
  const li = document.createElement('li');
  li.className = 'voice-entry';
  const cmd = document.createElement('div');
  cmd.className = 'voice-entry-cmd';
  cmd.dir = 'auto';
  cmd.textContent = command;
  const detail = document.createElement('div');
  detail.className = 'voice-entry-detail';
  const status = document.createElement('span');
  status.className = 'voice-entry-status';
  status.textContent = t('voice.executing');
  detail.append(status);
  li.append(cmd, detail);
  log.prepend(li);
  return {
    node: li,
    setStatus(text, state) {
      status.textContent = text;
      li.className = `voice-entry${state ? ` ${state}` : ''}`;
    },
    addDecision(action, confidence, ms) {
      const badge = document.createElement('span');
      badge.className = 'voice-entry-badge';
      const pct = Math.round((confidence ?? 0) * 100);
      badge.textContent = `${action} · ${t('voice.confidence', { pct })}${Number.isFinite(ms) ? ` · ${ms}ms` : ''}`;
      detail.append(badge);
    },
    addNote(text) {
      const note = document.createElement('span');
      note.className = 'voice-entry-note';
      note.textContent = text;
      detail.append(note);
    },
    setOk(text, ms) {
      status.textContent = `✓ ${text}`;
      li.className = 'voice-entry ok';
      if (Number.isFinite(ms)) {
        const time = document.createElement('span');
        time.className = 'muted';
        time.textContent = `${ms}ms`;
        detail.append(time);
      }
    },
    setErr(text) {
      status.textContent = `✗ ${text}`;
      li.className = 'voice-entry err';
    },
  };
}

function setVoiceState(state) {
  voiceState = state;
  const stateEl = $('voiceState');
  if (!stateEl) return;
  stateEl.textContent = t(`voice.state${state.charAt(0).toUpperCase()}${state.slice(1)}`);
  stateEl.className = `pill voice-pill${state === 'idle' ? '' : ` ${state}`}`;
  $('voiceMicBtn')?.classList.toggle('on', state === 'listening');
}

/** What the microphone could not do, said in the panel's language. */
function voiceFailure(code) {
  const key = code === 'not-supported' ? 'composer.micMissing'
    : code === 'restart-limit' ? 'voice.micRestarts'
      : voiceErrorKey(code);
  if (!key) return;
  $('voiceLive').textContent = t(key);
}

/** The voice output, spoken by the browser. It is never a command of its own. */
function speakNow(text, { onEnd } = {}) {
  const synth = window.speechSynthesis;
  if (!synth) {
    onEnd?.();
    return;
  }
  try {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    utterance.lang = currentLanguage() === 'ar' ? 'ar-EG' : 'en-US';
    utterance.onend = () => onEnd?.();
    utterance.onerror = () => onEnd?.();
    synth.speak(utterance);
  } catch {
    onEnd?.();
  }
}

const VOICE_PREF_KEYS = ['voiceHandsfree', 'voiceSpeak'];

async function loadVoicePrefs() {
  const saved = await chrome.storage.local.get(VOICE_PREF_KEYS).catch(() => ({}));
  return { handsFree: saved.voiceHandsfree !== false, speakReplies: saved.voiceSpeak === true };
}

async function saveVoicePrefs(prefs) {
  await chrome.storage.local.set({
    voiceHandsfree: Boolean(prefs.handsFree),
    voiceSpeak: Boolean(prefs.speakReplies),
  }).catch(() => {});
}

function createVoice() {
  return createVoiceController({
    createRecognition: () => {
      const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Ctor) return null;
      const rec = new Ctor();
      rec.lang = speechLang(currentLanguage());
      return rec;
    },
    // The side panel cannot ask Chrome for the microphone; a real window can.
    canListenInPanel: () => !panelMicBroken && micListenTarget(micPermission) === 'panel',
    openMicWindow,
    closeMicWindow,
    // The voice output holds the microphone window as well.
    pauseCapture: () => { if (micCaptureOpen) relayMic('pause'); },
    resumeCapture: () => { if (micCaptureOpen) relayMic('resume'); },
    say: speakNow,
    stopSpeech: () => { try { window.speechSynthesis?.cancel(); } catch { /* no speech */ } },
    speaking: () => Boolean(window.speechSynthesis?.speaking),
    onState: setVoiceState,
    onTranscript: (text, { final }) => {
      const live = $('voiceLive');
      live.textContent = text;
      live.classList.toggle('final', Boolean(final));
    },
    onCommand: (text, { signal, entry }) => runVoiceCommand(text, { signal, entry }),
    onLog: voiceLogEntry,
    loadPrefs: loadVoicePrefs,
    savePrefs: saveVoicePrefs,
    onFailure: voiceFailure,
    onMicBlocked: () => { panelMicBroken = true; },
    // A command that is dropped before it runs says so in the panel's language.
    cancelledText: () => t('voice.cancelled'),
  });
}

function syncVoiceToggles() {
  const prefs = voiceController?.prefs;
  if (!prefs) return;
  $('voiceHandsfree').checked = prefs.handsFree;
  $('voiceSpeak').checked = prefs.speakReplies;
}

/** The texts of the voice screen that are drawn, not translated in place. */
function updateVoiceLabels() {
  $('voiceLog')?.setAttribute('data-empty', t('voice.emptyLog'));
  setVoiceState(voiceState);
  syncVoiceToggles();
}

/** The voice screen is shown: the microphone may start listening. */
async function openVoice() {
  const token = ++voiceViewToken;
  $('voiceView').hidden = false;
  $('chatView').hidden = true;
  $('settingsView').hidden = true;
  voiceController ??= createVoice();
  // A question that is waiting for an answer is shown in the voice screen too:
  // it must never be hidden behind it.
  showPendingQuestion(ui.question);
  await voiceTarget();
  if (token !== voiceViewToken || $('voiceView').hidden) return;
  await voiceController.open();
  updateVoiceLabels();
  if (voiceController.listening) $('voiceLive').textContent = t('voice.listeningNow');
}

/** The voice screen is left: the microphone stops and the voice output stops. */
function closeVoice({ cancel = false } = {}) {
  voiceViewToken += 1;
  if ($('voiceView').hidden) return;
  $('voiceView').hidden = true;
  $('chatView').hidden = false;
  voiceController?.close();
  voiceApproval?.();
  if (cancel) {
    voiceController?.cancelCommand();
    // Only a task the worker is running for this command is stopped: a fast
    // command never asked the worker to do anything.
    if (voiceTask) {
      cancelVoiceTask(t('voice.cancelled'));
      send({ type: 'stop' }).catch(() => {});
    }
  }
}

/** The chat is shown, so a question can be answered in it. */
function showChat() {
  closeVoice();
}

// ---------- the commands ----------

/** The log entry of the command the worker is running, when this event is its. */
function voiceEntryFor(event) {
  if (replaying) return null;
  const task = voiceTask;
  if (!task) return null;
  if (task.sessionId !== sessionId) return null;
  // The history that was replayed on open is older than the command.
  if (Number.isFinite(event?.at) && event.at < task.startedAt) return null;
  return task.entry;
}

function finishVoiceTask() {
  const task = voiceTask;
  if (!task) return;
  voiceTask = null;
  task.resolve?.();
}

/**
 * The command that is running asks a question: the task waits for the answer,
 * but the command itself is over. The screen is free again, so the answer may
 * be given by voice. The entry keeps the events of the task, so the task is
 * still shown where it belongs.
 */
function settleVoiceCommand() {
  voiceTask?.resolve?.();
}

function cancelVoiceTask(message) {
  const task = voiceTask;
  if (!task) return;
  voiceTask = null;
  task.entry?.setErr?.(message || t('voice.cancelled'));
  task.resolve?.();
}

/** Runs one spoken command on the engine the user chose. */
async function runVoiceCommand(text, { signal, entry }) {
  if (signal.aborted) return;
  // A question that waits for an answer may be answered by voice while the
  // task is still working: the answer belongs to that question, not to a new
  // command. Every other command is refused while the session is busy.
  const answering = Boolean(ui.question);
  if (ui.running && !answering) {
    entry.setErr(t('voice.busy'));
    return;
  }
  if (answering) {
    // The answer goes to the question that waits. No fresh task is started
    // for it: the task that asked is still running, and it is the one that
    // continues when the answer arrives.
    try {
      const sent = await sendVoiceMessage(text, { signal, expectedSessionId: sessionId });
      if (signal.aborted) return;
      if (!sent) entry.setErr(t('voice.failed'));
      else {
        // The answer belongs to the task in the chat, and so does its
        // report: the panel hands the screen back to the chat.
        showChat();
        entry.setOk(t('voice.success'));
      }
    } catch (err) {
      // Only a cancellation of this command is silent: every other failure is
      // a failure the user has to see.
      if (signal.aborted) return;
      entry.setErr(String(err?.message ?? err));
    }
    return;
  }
  if ((settings?.voiceEngine ?? 'postora') === 'fast_only') {
    return runFastVoiceCommand(text, { signal, entry });
  }
  // Postora: the worker runs the task and its events fill the log entry. A
  // session that is already working on something is not steered by a voice
  // command: the result would belong to a task the user did not ask for.
  return new Promise((resolve) => {
    const task = { entry, text, startedAt: Date.now(), sessionId, resolve };
    voiceTask = task;
    voiceTarget().then((target) => {
      if (signal.aborted || voiceTask !== task || sessionId !== task.sessionId) {
        resolve();
        return;
      }
      return sendVoiceMessage(text, { tabId: target?.id, signal, expectedSessionId: task.sessionId }).then((sent) => {
        if (!sent) {
          entry.setErr(t('voice.failed'));
          if (voiceTask === task) finishVoiceTask();
        }
      }, (err) => {
        // A command that was cancelled says so; the screen is closed and
        // nothing of it may be written into it. The task is finished anyway,
        // or the command would keep the screen busy for ever.
        if (signal.aborted) {
          if (voiceTask === task) finishVoiceTask();
          return;
        }
        if (voiceTask === task) {
          // The task never left the panel: the command must not stay open,
          // and the failure is shown. An abort that this command did not ask
          // for is a failure too: a provider or a browser that timed out.
          entry.setErr(String(err?.message ?? err));
          finishVoiceTask();
          return;
        }
        // The command was stopped for another reason (the session was left,
        // the screen was closed): its entry keeps what it says, and the
        // command must not keep the screen busy.
        task.resolve?.();
      });
    }).catch((err) => {
      // A command that was cancelled is not a failure of the page: nothing of
      // it may be written into the screen.
      if (signal.aborted) {
        if (voiceTask === task) finishVoiceTask();
        return;
      }
      if (voiceTask === task) {
        entry.setErr(err?.message ? String(err.message) : t('voice.failed'));
        finishVoiceTask();
        return;
      }
      task.resolve?.();
    });
  });
}

/** The fast layer runs the command itself, without the main model. */
async function runFastVoiceCommand(text, { signal, entry }) {
  const fast = settings?.fast ?? {};
  if (!fast.apiKey) {
    entry.setErr(t('err.fastKey'));
    return;
  }
  if (!fast.baseUrl) {
    entry.setErr(t('err.fastUrl'));
    return;
  }
  // The same provider-aware client the fast layer uses: the configured
  // provider, model, endpoint and key, with the configured backup.
  const ask = createFastAsk(fast, (notice) => entry.addNote(`${notice.from} → ${notice.to}`));
  const browser = createChromeBrowser({ sessionId, target: voiceTarget, panelId: voicePanelId });
  let result;
  try {
    result = await runFastCommand({
      ask,
      browser,
      command: text,
      emit: (event) => {
        if (event.kind === 'decision') entry.addDecision(voiceActionName(event.action), event.confidence, event.ms);
      },
      approve: askVoiceApproval,
      signal,
      secretTokens: SECRET_TOKENS,
      t,
    });
  } catch (err) {
    // A command that was cancelled is not a failure of the page: the screen
    // may be closed already, and nothing of it may be written into it. An
    // abort that this command did not ask for is a failure of the provider or
    // of the browser, and it is shown.
    if (signal.aborted) return;
    entry.setErr(String(err?.message ?? err));
    return;
  }
  // A command that was cancelled while it was running reports nothing: the
  // screen is not changed and nothing is spoken behind the user's back.
  if (signal.aborted) return;
  // The tab the command ended on is the one the next command acts on: the
  // microphone window takes the focus, so the tab has to be remembered.
  if (result.closedTarget) voiceOrigin = null;
  else if (result.target) voiceOrigin = result.target;
  if (result.ok) {
    entry.setOk(result.say || t('voice.success'), result.ms);
    voiceController?.speak(result.say);
  } else {
    entry.setErr(result.say || t('voice.failed'));
    voiceController?.speak(result.say);
  }
  if (result.stopListening) voiceController?.stopListening();
}

/** The name of a step, in the panel's language. */
const VOICE_ACTIONS = {
  navigate: 'voice.actionNavigate',
  new_tab: 'voice.actionNewTab',
  web_search: 'voice.actionSearch',
  click: 'voice.actionClick',
  type_text: 'voice.actionType',
  press_enter: 'voice.actionEnter',
  scroll_down: 'voice.actionScrollDown',
  scroll_up: 'voice.actionScrollUp',
  scroll_top: 'voice.actionTop',
  scroll_bottom: 'voice.actionBottom',
  go_back: 'voice.actionBack',
  go_forward: 'voice.actionForward',
  reload: 'voice.actionReload',
  close_tab: 'voice.actionCloseTab',
  switch_tab: 'voice.actionSwitchTab',
  next_tab: 'voice.actionNextTab',
  previous_tab: 'voice.actionPreviousTab',
  zoom_in: 'voice.actionZoomIn',
  zoom_out: 'voice.actionZoomOut',
  zoom_reset: 'voice.actionZoomReset',
  media_play_pause: 'voice.actionMedia',
  media_mute: 'voice.actionMute',
  find_on_page: 'voice.actionFind',
  stop_listening: 'voice.actionStop',
  unknown: 'voice.actionUnknown',
};

function voiceActionName(action) {
  const key = VOICE_ACTIONS[action];
  return key ? t(key) : String(action ?? '');
}

/**
 * The question the user answers before a step that can send, buy, delete or
 * submit. It is shown in the voice screen, with a yes and a no; it is never a
 * browser dialog.
 */
function askVoiceApproval(what) {
  return new Promise((resolve) => {
    const box = $('voiceApproval');
    box.hidden = false;
    box.replaceChildren();
    const title = document.createElement('strong');
    title.textContent = t('voice.approveTitle');
    const detail = document.createElement('div');
    detail.className = 'voice-approve-detail';
    detail.dir = 'auto';
    detail.textContent = approvalText(what);
    const actions = document.createElement('div');
    actions.className = 'voice-approve-actions';
    const yes = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: t('voice.approve') });
    const no = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: t('voice.cancel') });
    const done = (answer) => {
      box.hidden = true;
      box.replaceChildren();
      voiceApproval = null;
      resolve(answer);
    };
    voiceApproval = () => done(false);
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    actions.append(yes, no);
    box.append(title, detail, actions);
    if ($('voiceView').hidden) openVoice();
    yes.focus();
  });
}

/** What the user is asked to approve, in words that say what will happen. */
function approvalText(what) {
  return approvalMessage(what, t);
}

$('voiceToggle').addEventListener('click', (e) => {
  e.preventDefault();
  openVoice();
});
$('voiceBackBtn').addEventListener('click', () => closeVoice({ cancel: true }));
$('voicePendingBtn').addEventListener('click', () => showChat());
$('voiceMicBtn').addEventListener('click', () => voiceController?.toggleListening());
$('voiceClearLog').addEventListener('click', () => {
  $('voiceLog').replaceChildren();
});
$('voiceTypedForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('voiceTypedInput');
  const val = input.value.trim();
  if (val) {
    input.value = '';
    voiceController?.submit(val);
  }
});
$('voiceHandsfree').addEventListener('change', (e) => {
  (voiceController ??= createVoice()).setHandsFree(e.target.checked);
});
$('voiceSpeak').addEventListener('change', (e) => {
  (voiceController ??= createVoice()).setSpeakReplies(e.target.checked);
});

window.addEventListener('keydown', (e) => {
  if (e.altKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
    e.preventDefault();
    if ($('voiceView').hidden) {
      openVoice();
    } else {
      voiceController?.toggleListening();
    }
  }
});
window.addEventListener('pagehide', () => {
  voiceController?.close();
  voiceApproval?.();
});
chrome.runtime.onMessage.addListener(onMicMessage);
chrome.windows.onRemoved.addListener((id) => {
  if (id !== micWindowId) return;
  micWindowId = null;
  voiceController?.handleCaptureEnded();
});
watchMicrophone();
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $('composer').requestSubmit();
  }
});
$('stopBtn').addEventListener('click', () => send({ type: 'stop' }));
$('newChatBtn').addEventListener('click', async () => {
  const meta = await request('session-create');
  await chooseSession(meta.id);
});
document.querySelectorAll('.examples li').forEach((li) => li.addEventListener('click', () => {
  $('input').value = li.textContent;
  $('input').focus();
}));

// ---------- sessions ----------

// The panel follows the tab the user is looking at: each tab has its own session,
// a new tab starts on a blank one, and a tab where a task ran keeps its session.
let windowId = null;
let tabLookups = 0;

async function startSessions() {
  windowId = (await chrome.windows.getCurrent()).id;
  // Opened as a page in a tab (as the e2e tests do), the panel is that tab's own
  // and must not jump to the session of whichever tab gets focus.
  const ownTab = await chrome.tabs.getCurrent();
  if (!ownTab) {
    chrome.tabs.onActivated.addListener((info) => {
      if (info.windowId === windowId) showTabSession(info.tabId).catch(() => {}); // the tab may close mid-lookup
    });
  }
  await showTabSession(ownTab?.id);
  await refreshSessions();
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  return tab?.id;
}

function showTabSession(tabId) {
  return pick(async () => {
    const lookup = ++tabLookups;
    const id = await request('tab-session', { tabId: tabId ?? (await activeTabId()) });
    if (lookup === tabLookups) await openSession(id); // a later tab switch wins
  });
}

/** A session picked by the user (from the list, or a new one) becomes the current tab's. */
function chooseSession(id) {
  return pick(async () => {
    tabLookups += 1; // a tab lookup still in flight must not replace the user's pick
    await request('bind-tab', { tabId: await activeTabId(), sessionId: id });
    await openSession(id);
  });
}

async function openSession(id) {
  closeSessionMenu();
  if (id === sessionId && port) return;
  port?.disconnect();
  port = null;
  sessionId = id;
  ui.replayed = false;
  ui.running = false;
  // The command that was running belongs to the session that is left: it is
  // stopped with the microphone, and the approval with it, so nothing acts on
  // the tab of the session that is gone.
  cancelVoiceTask(t('voice.cancelled'));
  voiceApproval?.();
  closeVoice();
  voiceController?.close();
  clearMessages();
  $('emptyState').hidden = false;
  connect();
  renderSessionTitle();
}

async function refreshSessions() {
  sessionList = await request('sessions-list');
  renderSessionTitle();
  if (!$('sessionMenu').hidden) renderSessionList();
}

function sessionLabel(meta) {
  return meta?.title || t('session.untitled');
}

function renderSessionTitle() {
  $('sessionTitle').textContent = sessionLabel(sessionList.find((s) => s.id === sessionId));
}

function renderSessionList() {
  const query = $('sessionSearch').value.trim().toLowerCase();
  // Every open panel starts on an empty session; only the current one of those is worth listing.
  // A running session is always listed, so another tab can open it.
  const shown = sessionList
    .filter((s) => s.titled || s.running || s.id === sessionId)
    .filter((s) => !query || sessionLabel(s).toLowerCase().includes(query));
  $('sessionList').replaceChildren(...shown.map(sessionRow));
}

function sessionRow(meta) {
  const row = document.createElement('li');
  row.className = `session-item${meta.id === sessionId ? ' active' : ''}`;
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(meta.id === sessionId));
  const dot = document.createElement('span');
  dot.className = `dot${meta.running ? ' running' : ''}`;
  dot.title = meta.running ? t('session.running') : '';
  const title = document.createElement('button');
  title.type = 'button';
  title.className = 'session-open';
  // <bdi> keeps an English title readable in the Arabic list without flipping the row's alignment.
  title.append(Object.assign(document.createElement('bdi'), { textContent: sessionLabel(meta) }));
  title.addEventListener('click', () => chooseSession(meta.id));
  const rename = iconButton(ICONS.rename, t('session.rename'), () => startRename(row, title, meta));
  const remove = iconButton(ICONS.remove, t('session.delete'), () => deleteSessionAsked(meta));
  row.append(dot, title, rename, remove);
  return row;
}

const ICONS = {
  close: 'M6 6l12 12M18 6L6 18',
  rename: 'M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4',
  remove: 'M5 7h14M10 11v6M14 11v6M7 7l1 12h8l1-12M9 7V4h6v3',
};

function iconButton(path, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost icon';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  button.append(svg);
  button.title = label;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

function startRename(row, title, meta) {
  const input = document.createElement('input');
  input.value = meta.title;
  input.dir = 'auto';
  input.className = 'session-rename';
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    if (save && input.value.trim() && input.value.trim() !== meta.title) await request('session-rename', { id: meta.id, title: input.value });
    await refreshSessions();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  title.replaceWith(input);
  input.focus();
  input.select();
}

async function deleteSessionAsked(meta) {
  if (!window.confirm(t('session.confirmDelete', { title: sessionLabel(meta) }))) return;
  await request('session-delete', { id: meta.id });
  if (meta.id === sessionId) await showTabSession();
  else await refreshSessions();
}

function toggleSessionMenu() {
  if ($('sessionMenu').hidden) {
    $('sessionMenu').hidden = false;
    $('sessionBtn').setAttribute('aria-expanded', 'true');
    $('sessionSearch').value = '';
    renderSessionList();
    refreshSessions();
    $('sessionSearch').focus();
  } else {
    closeSessionMenu();
  }
}

function closeSessionMenu() {
  $('sessionMenu').hidden = true;
  $('sessionBtn').setAttribute('aria-expanded', 'false');
}

$('sessionBtn').addEventListener('click', toggleSessionMenu);
$('sessionSearch').addEventListener('input', renderSessionList);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('sessionMenu').hidden) closeSessionMenu();
});
document.addEventListener('click', (e) => {
  if (!$('sessionMenu').hidden && !$('sessionMenu').contains(e.target) && !$('sessionBtn').contains(e.target)) closeSessionMenu();
});

// ---------- Google account ----------

let account = null;

function renderAccount() {
  $('accountAvatar').hidden = !account?.picture;
  $('accountIcon').style.display = account?.picture ? 'none' : ''; // SVG elements have no hidden property
  $('accountSignedOut').hidden = Boolean(account);
  $('accountSignedIn').hidden = !account;
  if (!account) return;
  $('accountMenuAvatar').src = account.picture;
  $('accountAvatar').src = account.picture;
  $('accountName').textContent = account.name;
  $('accountEmail').textContent = account.email;
  $('accountBtn').title = `${account.name} — ${account.email}`;
}

function toggleAccountMenu() {
  const opening = $('accountMenu').hidden;
  closeSessionMenu();
  $('feedbackMenu').hidden = true;
  $('accountMenu').hidden = !opening;
  $('accountStatus').textContent = '';
}

$('accountBtn').addEventListener('click', toggleAccountMenu);
$('googleSignInBtn').addEventListener('click', async () => {
  $('accountStatus').textContent = t('account.signingIn');
  try {
    account = await signInWithGoogle();
    renderAccount();
    $('accountStatus').textContent = t('drive.working');
    const { restored, available } = await request('drive-after-sign-in');
    if (restored) await showRestoredSettings(restored);
    if (restored) $('accountStatus').textContent = t('drive.restored');
    else if (available) $('accountStatus').textContent = t('drive.available', { time: `⁨${new Date(available).toLocaleString(currentLanguage())}⁩` });
    else $('accountStatus').textContent = '';
  } catch (err) {
    $('accountStatus').textContent = `✗ ${err.message}`;
  }
});
$('driveBackupBtn').addEventListener('click', () => driveAction(() => request('drive-backup-now')));
$('driveRestoreBtn').addEventListener('click', () => {
  if (!window.confirm(t('drive.confirmRestore'))) return;
  driveAction(async () => {
    await showRestoredSettings(await request('drive-restore'));
    $('accountStatus').textContent = t('drive.restored');
  });
});

async function driveAction(run) {
  $('accountStatus').textContent = t('drive.working');
  try {
    await run();
    if ($('accountStatus').textContent === t('drive.working')) $('accountStatus').textContent = '';
  } catch (err) {
    $('accountStatus').textContent = `✗ ${err.message}`;
  }
}

let driveState = {};

function renderDriveState(state = driveState) {
  driveState = state ?? {};
  if (driveState.error) $('driveStatus').textContent = t('drive.failed', { reason: driveState.error });
  else if (driveState.at) $('driveStatus').textContent = t('drive.saved', { time: `⁨${new Date(driveState.at).toLocaleString(currentLanguage())}⁩` }) // isolated, or bidi scrambles the date inside Arabic text;
  else $('driveStatus').textContent = t('drive.none');
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.driveBackup) renderDriveState(changes.driveBackup.newValue);
});
chrome.storage.local.get('driveBackup').then(({ driveBackup }) => renderDriveState(driveBackup));
$('googleSignOutBtn').addEventListener('click', async () => {
  await signOutOfGoogle();
  account = null;
  renderAccount();
});
document.addEventListener('click', (e) => {
  if (!$('accountMenu').hidden && !$('accountMenu').contains(e.target) && !$('accountBtn').contains(e.target)) $('accountMenu').hidden = true;
});
googleAccount().then((saved) => {
  account = saved;
  renderAccount();
});

// ---------- feedback and ratings ----------

const STORE_REVIEWS_URL = `https://chromewebstore.google.com/detail/${chrome.runtime.id}/reviews`;
// Store installs carry update_url; an unpacked copy has no store page to review.
const fromStore = Boolean(chrome.runtime.getManifest().update_url);
let feedbackRating = 0;

async function ratingState() {
  try {
    return (await chrome.storage.local.get('reviewPrompt')).reviewPrompt ?? {};
  } catch {
    return {};
  }
}

async function saveRatingState(change) {
  await chrome.storage.local.set({ reviewPrompt: change(await ratingState()) });
}

/** Five star buttons; picking one calls onPick(n) and lights the stars up to n. */
function starRow(onPick) {
  const row = document.createElement('div');
  row.className = 'stars';
  for (let n = 1; n <= 5; n += 1) {
    const star = document.createElement('button');
    star.type = 'button';
    star.className = 'star';
    star.textContent = '★';
    star.setAttribute('aria-label', t('rate.star', { n }));
    star.addEventListener('click', () => {
      row.querySelectorAll('.star').forEach((s, i) => s.classList.toggle('on', i < n));
      onPick(n);
    });
    row.append(star);
  }
  return row;
}

/** A signed-in user's feedback carries their Google email unless they typed another. */
function feedbackFields(message, rating, email = '') {
  return { message, rating, email: email || account?.email || '', version: chrome.runtime.getManifest().version, language: currentLanguage() };
}

async function askForRating() {
  if (!shouldAskForRating(await ratingState())) return;
  const card = add('msg rate-card', '');
  const question = document.createElement('span');
  question.textContent = t('rate.question');
  const close = iconButton(ICONS.close, t('rate.dismiss'), async () => {
    card.remove();
    await saveRatingState(afterDismissal);
  });
  const head = document.createElement('div');
  head.className = 'row between';
  head.append(question, close);
  const body = document.createElement('div');
  body.className = 'fields';
  card.append(head, starRow((n) => rated(n, body, close)), body);
}

async function rated(stars, body, close) {
  close.remove();
  await saveRatingState(afterRating);
  if (stars === 5) {
    body.replaceChildren(textLine(t('rate.thanks')));
    if (fromStore) {
      const link = Object.assign(document.createElement('a'), { href: STORE_REVIEWS_URL, target: '_blank', rel: 'noopener', textContent: t('rate.store') });
      body.append(link);
    }
    if (FEEDBACK_FORM_ID) sendFeedback(feedbackFields('', 5)).catch(() => {}); // a bare 5★ is a nice-to-know, not worth an error
    return;
  }
  const text = Object.assign(document.createElement('textarea'), { rows: 3, dir: 'auto', placeholder: t('rate.better') });
  const status = Object.assign(document.createElement('small'), { className: 'muted' });
  const send = Object.assign(document.createElement('button'), { type: 'button', className: 'primary', textContent: t('feedback.send') });
  send.addEventListener('click', () => submitFeedback({ message: text.value.trim(), rating: stars }, status, () => body.replaceChildren(textLine(t('feedback.sent')))));
  const actions = document.createElement('div');
  actions.className = 'row between';
  actions.append(status, send);
  body.replaceChildren(text, actions);
  text.focus();
}

function textLine(text) {
  return Object.assign(document.createElement('span'), { textContent: text });
}

async function submitFeedback({ message, rating, email = '' }, status, onSent) {
  if (!message && !rating) {
    status.textContent = t('feedback.empty');
    return;
  }
  if (!FEEDBACK_FORM_ID) {
    status.textContent = t('feedback.notConfigured');
    return;
  }
  status.textContent = t('feedback.sending');
  try {
    await sendFeedback(feedbackFields(message, rating, email));
    onSent();
  } catch (err) {
    status.textContent = `✗ ${err.message}`;
  }
}

function toggleFeedbackMenu() {
  const opening = $('feedbackMenu').hidden;
  closeSessionMenu();
  $('accountMenu').hidden = true;
  $('feedbackMenu').hidden = !opening;
  if (!opening) return;
  feedbackRating = 0;
  $('feedbackStars').replaceWith(Object.assign(starRow((n) => { feedbackRating = n; }), { id: 'feedbackStars' }));
  $('feedbackStatus').textContent = '';
  if (account && !$('feedbackEmail').value) $('feedbackEmail').value = account.email;
  $('feedbackText').focus();
}

$('feedbackBtn').addEventListener('click', toggleFeedbackMenu);
$('feedbackSend').addEventListener('click', () => submitFeedback(
  { message: $('feedbackText').value.trim(), rating: feedbackRating, email: $('feedbackEmail').value.trim() },
  $('feedbackStatus'),
  () => {
    $('feedbackText').value = '';
    $('feedbackStatus').textContent = t('feedback.sent');
  },
));
document.addEventListener('click', (e) => {
  if (!$('feedbackMenu').hidden && !$('feedbackMenu').contains(e.target) && !$('feedbackBtn').contains(e.target)) $('feedbackMenu').hidden = true;
});

// ---------- language ----------

$('langBtn').addEventListener('click', async () => {
  const next = currentLanguage() === 'ar' ? 'en' : 'ar';
  applyLanguage(next);
  settings = await request('save-settings', { settings: { ...settings, uiLanguage: next } });
});

/** Static text is retranslated by setLanguage; text this file renders is redrawn here. */
function applyLanguage(language) {
  setLanguage(language);
  renderFiles();
  if (!settings) return;
  for (const provider of ACCOUNT_PROVIDERS) if (authState[provider]) showAuth(provider, authState[provider]);
  syncAuthFrames();
  updateChip();
  mainForm.rerender();
  fallbackForm.rerender();
  renderNotices();
  renderSessionTitle();
  syncFastProvider();
  syncFastFallback();
  renderDriveState();
  updateVoiceLabels();
}

// ---------- settings ----------

const keyStore = createKeyStore();
const mainForm = createProviderForm($('mainProvider'), { request, getPresets: () => presets, keyStore, onChange: () => syncAuthFrames() });
const fallbackForm = createProviderForm($('fallbackProvider'), { request, getPresets: () => presets, keyStore, onChange: () => syncAuthFrames() });
keyStore.register($('fastApiKey'), () => $('fastProvider').value);
keyStore.register($('fastFallbackApiKey'), () => $('fastFallbackProvider').value);
// A provider's section shows that provider's sign-in, so the status of the one
// the user picks is asked for.
$('provider').addEventListener('change', () => {
  const provider = mainForm.provider();
  if (ACCOUNT_PROVIDERS.includes(provider)) refreshAuthState(provider).catch(() => {});
});

$('settingsBtn').addEventListener('click', () => toggleSettings(true));

// Settings tabs (WAI-ARIA tabs pattern): click or arrow keys switch, the last choice is remembered.
const SETTINGS_TABS = [$('tabModels'), $('tabFast')];

function selectSettingsTab(tab, focus = false) {
  for (const t of SETTINGS_TABS) {
    const selected = t === tab;
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !selected;
  }
  if (focus) tab.focus();
  $('settingsView').scrollTop = 0;
  try { localStorage.setItem('settingsTab', tab.id); } catch { /* storage blocked */ }
}

SETTINGS_TABS.forEach((tab, i) => {
  tab.addEventListener('click', () => selectSettingsTab(tab));
  tab.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const dir = document.documentElement.dir === 'rtl' ? -step : step;
    selectSettingsTab(SETTINGS_TABS[(i + dir + SETTINGS_TABS.length) % SETTINGS_TABS.length], true);
  });
});

try {
  const saved = $(localStorage.getItem('settingsTab') ?? '');
  if (SETTINGS_TABS.includes(saved)) selectSettingsTab(saved);
} catch { /* storage blocked */ }
$('closeSettingsBtn').addEventListener('click', () => toggleSettings(false));

// Numbers each permission check; a newer check or a click on the switch makes an
// older answer stale, so it can never undo what the user just chose.
let notifyCheck = 0;

/** The switch as it works: saved on and still granted by Chrome (it can be revoked there). */
function syncNotifySwitch() {
  const check = ++notifyCheck;
  $('notify').checked = false;
  $('notifyNote').hidden = true;
  if (!settings?.notify) return;
  chrome.permissions.contains({ permissions: ['notifications'] }).then((granted) => {
    if (check === notifyCheck) $('notify').checked = granted;
  }, () => {});
}

function toggleSettings(open) {
  // Closing, saved or not: the notifications permission follows the saved switch. One
  // granted for an edit that was not saved, or for a switch saved off, is given back.
  if (!open && settings) {
    if (!settings.notify) chrome.permissions.remove({ permissions: ['notifications'] }).catch(() => {});
    // The switch shows the saved choice again, so a later Save cannot store an
    // unsaved "on" whose permission was just given back.
    syncNotifySwitch();
  }
  if (open && settings) syncNotifySwitch(); // the permission may have been revoked in Chrome since
  // The voice screen is left for the settings: the microphone stops there.
  if (open) closeVoice();
  $('settingsView').hidden = !open;
  $('chatView').hidden = open;
  $('settingsError').hidden = true;
  if (open) {
    // The sign-in state may have changed while the panel was closed.
    refreshAuthStates().catch(() => {});
    mainForm.loadModels();
    if ($('fallbackEnabled').checked) fallbackForm.loadModels();
    loadFastModels();
    loadFastFallbackModels();
  }
}

async function init() {
  const data = await request('get-settings');
  settings = data.settings;
  presets = data.presets;
  fastPresets = data.fastPresets;
  setLanguage(resolveLanguage(settings.uiLanguage, chrome.i18n.getUILanguage()));
  renderDriveState();
  // The fast layer and its backup offer the same decision providers.
  const fastOptions = Object.entries(fastPresets).map(([id, p]) => `<option value="${id}">${escapeAttr(p.label)}</option>`).join('');
  $('fastProvider').innerHTML = fastOptions;
  $('fastFallbackProvider').innerHTML = fastOptions;
  fillForm();
  await refreshAuthStates();
  updateChip();
  if (!activeModel()) toggleSettings(true);
  mainForm.loadModels();
  loadFastModels();
}

// Tokens land in storage even when the worker that polled for them was restarted
// and its port to this panel is gone, so storage is the reliable sign-in signal.
// Every provider's credential has its own accountAuth.* key, and the keys that
// changed name the providers they belong to.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  const providers = changedProviders(changes);
  if (!providers.length) return;
  for (const provider of providers) {
    const status = await request('auth-status', { provider }).catch(() => null);
    if (status) showAuth(provider, status);
  }
  // Only the slots that use these providers need their models again.
  for (const provider of providers) {
    if (mainForm.provider() === provider) mainForm.loadModels();
    if ($('fallbackEnabled').checked && fallbackForm.provider() === provider) fallbackForm.loadModels();
  }
});

function fillForm() {
  keyStore.load(settings.keys);
  mainForm.fill(settings);
  fallbackForm.fill(settings.fallback);
  $('fallbackEnabled').checked = settings.fallback.enabled;
  syncFallback();
  syncAuthFrames();
  $('maxSteps').value = settings.maxSteps;
  $('vision').checked = settings.vision;
  $('allowJavascript').checked = settings.allowJavascript;
  $('showCursor').checked = settings.showCursor;
  $('steerMode').value = settings.steerMode ?? 'next-step';
  syncNotifySwitch();
  $('replyLangEnabled').checked = settings.replyLanguage.enabled;
  $('replyLang').value = settings.replyLanguage.language;
  syncReplyLanguage();
  fillFastForm(settings.fast);
  if ($('voiceEngine')) $('voiceEngine').value = settings.voiceEngine ?? 'postora';
  syncRecommended();
}

// The tested free setup: offered up front until a provider is set up, then behind a link.
function syncRecommended(open = false) {
  const signedIn = Object.values(authState).some((state) => state?.connected);
  const configured = signedIn || Object.values(settings.keys ?? {}).some(Boolean) || Boolean(settings.compatible.apiKey);
  $('recommended').hidden = configured && !open;
  $('showRecommended').hidden = !$('recommended').hidden;
  $('recommendedNote').hidden = true;
}

// The store build has no run-JavaScript tool, so it has no switch for it either.
$('allowJavascript').closest('label').hidden = STORE_BUILD;

$('keyLinkMain').href = RECOMMENDED_SETUP.main.keyUrl;
$('keyLinkBackup').href = RECOMMENDED_SETUP.backup.keyUrl;
$('showRecommended').addEventListener('click', () => syncRecommended(true));

// Fills both provider forms through their own fill; keys go in the existing key
// fields, so the shared key store sees them. Nothing is saved until Save.
$('useRecommended').addEventListener('click', () => {
  const { main, fallback } = recommendedSlots(readForm(), presets);
  mainForm.fill(main);
  fallbackForm.fill(fallback);
  $('fallbackEnabled').checked = true;
  syncFallback();
  mainForm.loadModels();
  fallbackForm.loadModels();
  $('recommendedNote').hidden = false;
  const empty = [$('mainProvider'), $('fallbackProvider')].map((root) => root.querySelector('[data-field="apiKey"]')).find((input) => !input.value);
  empty?.focus();
});

function readForm() {
  const next = structuredClone(settings);
  Object.assign(next, mainForm.read());
  next.fallback = { ...fallbackForm.read(), enabled: $('fallbackEnabled').checked };
  next.fast = readFastForm();
  next.maxSteps = Number($('maxSteps').value) || 40;
  next.vision = $('vision').checked;
  next.allowJavascript = $('allowJavascript').checked;
  next.showCursor = $('showCursor').checked;
  next.steerMode = $('steerMode').value;
  next.notify = $('notify').checked;
  next.replyLanguage = { enabled: $('replyLangEnabled').checked, language: $('replyLang').value };
  next.voiceEngine = $('voiceEngine')?.value || 'postora';
  next.keys = keyStore.snapshot();
  return next;
}

// Off: the agent follows the language of the task, so the choice is hidden.
function syncReplyLanguage() {
  $('replyLangField').hidden = !$('replyLangEnabled').checked;
}

$('replyLangEnabled').addEventListener('change', syncReplyLanguage);

// The permission is asked for from the click itself (Chrome needs the gesture), and
// given back when the switch goes off. Notifications need both the switch and it.
$('notify').addEventListener('change', async () => {
  notifyCheck += 1; // the user's choice wins over any check still waiting
  const box = $('notify');
  $('notifyNote').hidden = true;
  if (box.checked) {
    const granted = await chrome.permissions.request({ permissions: ['notifications'] }).catch(() => false);
    if (!granted) {
      box.checked = false;
      $('notifyNote').hidden = false;
    }
  } else {
    // Given back only once the switch is saved off (see toggleSettings), like the rest of this form.
  }
});

function syncFallback() {
  $('fallbackProvider').hidden = !$('fallbackEnabled').checked;
}

$('fallbackEnabled').addEventListener('change', () => {
  syncFallback();
  if ($('fallbackEnabled').checked) fallbackForm.loadModels();
});

/** A provider saved before the list was limited to decision providers falls back to TypeSafe. */
function knownFastProvider(slot) {
  if (fastPresets[slot.provider]) return slot;
  const { baseUrl, model, minProb } = fastPresets.typesafe;
  return { ...slot, provider: 'typesafe', baseUrl, model, ...(slot.minProb !== undefined ? { minProb } : {}) };
}

function fillFastForm(saved) {
  const fast = { ...knownFastProvider(saved), fallback: knownFastProvider(saved.fallback) };
  $('fastEnabled').checked = fast.enabled;
  $('fastProvider').value = fast.provider;
  $('fastMode').value = fast.mode;
  $('fastApiKey').value = fast.apiKey;
  keyStore.refresh($('fastApiKey'));
  $('fastModel').value = fast.model;
  $('fastBaseUrl').value = fast.baseUrl;
  $('fastMinProb').value = fast.minProb;
  $('fastRiskyMax').value = fast.riskyMax;
  $('fastFallbackEnabled').checked = fast.fallback.enabled;
  $('fastFallbackProvider').value = fast.fallback.provider;
  $('fastFallbackApiKey').value = fast.fallback.apiKey;
  keyStore.refresh($('fastFallbackApiKey'));
  $('fastFallbackModel').value = fast.fallback.model;
  syncFast();
  syncFastProvider();
  syncFastFallback();
}

function readFastForm() {
  const provider = $('fastProvider').value;
  const preset = fastPresets[provider] ?? {};
  const model = $('fastModel').value.trim() || preset.model;
  return {
    enabled: $('fastEnabled').checked,
    mode: $('fastMode').value,
    provider,
    decision: isDecisionModel(provider, model),
    apiKey: $('fastApiKey').value.trim(),
    model,
    baseUrl: $('fastBaseUrl').value.trim() || preset.baseUrl,
    minProb: Number($('fastMinProb').value) || preset.minProb,
    riskyMax: Number($('fastRiskyMax').value) || 0.3,
    fallback: readFastFallback(),
  };
}

// Backups are decision providers only, so the base URL is the preset's.
function readFastFallback() {
  const provider = $('fastFallbackProvider').value;
  const preset = fastPresets[provider] ?? {};
  return {
    enabled: $('fastFallbackEnabled').checked,
    provider,
    baseUrl: preset.baseUrl,
    apiKey: $('fastFallbackApiKey').value.trim(),
    model: $('fastFallbackModel').value.trim() || preset.model,
    decision: true,
  };
}

// The fast list only holds decision models; a typed id counts as one when it is
// the preset's default (list not loaded yet) or was saved as one before.
function isDecisionModel(provider, model) {
  if (fastModels.some((m) => m.id === model)) return true;
  const preset = fastPresets[provider] ?? {};
  if (model === preset.model) return Boolean(preset.decision);
  return settings.fast.provider === provider && settings.fast.model === model && Boolean(settings.fast.decision);
}

function syncFast() {
  $('fastFields').hidden = !$('fastEnabled').checked;
  $('fastFallbackFrame').hidden = !$('fastEnabled').checked; // a backup for a layer that is off means nothing
}

// TypeSafe has no model list; the other decision providers list theirs.
function syncFastProvider() {
  syncListedPicker($('fastProvider').value, fastPickerEls(), fastModels);
}

function syncFastFallback() {
  $('fastFallbackFields').hidden = !$('fastFallbackEnabled').checked;
  syncListedPicker($('fastFallbackProvider').value, fastFallbackPickerEls(), fastFallbackModels);
}

const fastPickerEls = () => ({ select: $('fastModelSelect'), input: $('fastModel'), search: $('fastModelSearch'), refresh: $('fastModelsBtn') });
const fastFallbackPickerEls = () => ({ select: $('fastFallbackModelSelect'), input: $('fastFallbackModel'), search: $('fastFallbackModelSearch'), refresh: $('fastFallbackModelsBtn') });

function syncListedPicker(provider, els, list) {
  const listed = provider !== 'typesafe';
  els.refresh.hidden = !listed;
  els.select.hidden = !listed;
  if (listed) renderPicker(els.select, els.input, list, els.search);
  else {
    els.input.hidden = false;
    els.search.hidden = true;
  }
}

$('fastEnabled').addEventListener('change', syncFast);
$('fastProvider').addEventListener('change', () => {
  const preset = fastPresets[$('fastProvider').value];
  $('fastBaseUrl').value = preset.baseUrl;
  $('fastModel').value = preset.model;
  $('fastMinProb').value = preset.minProb;
  keyStore.show($('fastApiKey'), $('fastProvider').value);
  fastModels = [];
  syncFastProvider();
  loadFastModels();
});
$('fastModelsBtn').addEventListener('click', () => loadFastModels(true));
bindSearch($('fastModelSearch'), $('fastModelSelect'), () => fastModels, syncFastProvider);
$('fastModelSelect').addEventListener('change', () => pickModel($('fastModelSelect'), $('fastModel')));

$('fastFallbackEnabled').addEventListener('change', () => {
  syncFastFallback();
  loadFastFallbackModels();
});
$('fastFallbackProvider').addEventListener('change', () => {
  $('fastFallbackModel').value = fastPresets[$('fastFallbackProvider').value].model;
  keyStore.show($('fastFallbackApiKey'), $('fastFallbackProvider').value);
  fastFallbackModels = [];
  syncFastFallback();
  loadFastFallbackModels();
});
$('fastFallbackModelsBtn').addEventListener('click', () => loadFastFallbackModels(true));
bindSearch($('fastFallbackModelSearch'), $('fastFallbackModelSelect'), () => fastFallbackModels, syncFastFallback);
$('fastFallbackModelSelect').addEventListener('change', () => pickModel($('fastFallbackModelSelect'), $('fastFallbackModel')));

async function loadFastModels(showErrors = false) {
  const config = readFastForm();
  if (!config.enabled || config.provider === 'typesafe') return;
  const load = ++loads.fast;
  try {
    const list = await request('list-fast-models', { config });
    if (load !== loads.fast) return;
    fastModels = list;
    syncFastProvider();
    showFastStatus('', '');
  } catch (err) {
    if (load === loads.fast && showErrors) showFastStatus('fail', `✗ ${err.message}`);
  }
}

async function loadFastFallbackModels(showErrors = false) {
  const config = readFastFallback();
  if (!$('fastEnabled').checked || !config.enabled || config.provider === 'typesafe') return;
  const load = ++loads.fastFallback;
  try {
    const list = await request('list-fast-models', { config });
    if (load !== loads.fastFallback) return;
    fastFallbackModels = list;
    syncFastFallback();
  } catch (err) {
    if (load === loads.fastFallback && showErrors) showFastStatus('fail', `✗ ${err.message}`);
  }
}

async function testFast(config) {
  const started = performance.now();
  const { model } = await request('fast-test', { config });
  return t('fast.testOk', { model, ms: Math.round(performance.now() - started) });
}

/** state: 'ok' (green), 'fail' (red) or '' (neutral); model-list errors use it too. */
const showFastStatus = bindTestButton({ button: $('fastTestBtn'), result: $('fastTestResult'), scope: $('fastFields'), run: () => testFast(readFastForm()) });
bindTestButton({ button: $('fastFallbackTestBtn'), result: $('fastFallbackTestResult'), scope: $('fastFallbackFields'), run: () => testFast(readFastFallback()) });

$('exportBtn').addEventListener('click', async () => {
  try {
    const data = await request('backup-export');
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: `browser-agent-backup-${data.exportedAt.slice(0, 10)}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000); // revoking at once can cancel the download
    showBackupStatus('ok', t('backup.exported'));
  } catch (err) {
    showBackupStatus('fail', `✗ ${err.message}`);
  }
});
$('restoreBtn').addEventListener('click', () => $('restoreFile').click());
$('restoreFile').addEventListener('change', async () => {
  const [file] = $('restoreFile').files;
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    await showRestoredSettings(await request('backup-import', { data }));
    showBackupStatus('ok', t('backup.restored'));
  } catch (err) {
    showBackupStatus('fail', `✗ ${err instanceof SyntaxError ? t('backup.notJson') : err.message}`);
  } finally {
    $('restoreFile').value = '';
  }
});

/** After a restore from a file or from Drive, the settings view shows what was restored. */
async function showRestoredSettings(restored) {
  settings = restored;
  fillForm();
  updateChip();
  await refreshAuthStates();
  mainForm.loadModels();
}

function showBackupStatus(state, text) {
  $('backupResult').dataset.state = state;
  $('backupResult').textContent = text;
}

function currentProviderSettings(s = settings) {
  return slotSettings(s);
}

function activeModel() {
  return currentProviderSettings().model;
}

// ---------- account sign-in ----------

/**
 * The element that holds a provider's sign-in controls, or null when no frame
 * shows it: the main frame shows the provider of the main slot, the backup
 * frame shows its own provider when the main one does not.
 */
function authRoot(provider) {
  const main = $('mainProvider').querySelector(`[data-provider="${provider}"]`);
  if (main && mainForm.provider() === provider) return main;
  const backup = $('fallbackProvider').querySelector('[data-field="fallbackAuth"]');
  if (backup && backup.dataset.provider === provider) return backup;
  return null;
}

/** An element of a provider's sign-in controls. */
function authEl(provider, name) {
  const root = authRoot(provider);
  return root ? root.querySelector(`[data-auth="${name}"]`) : null;
}

/** The provider whose sign-in controls an element belongs to. */
function providerOfBlock(element) {
  return element.closest('[data-provider]')?.dataset.provider ?? '';
}

/** What the panel shows about one provider's sign-in. */
function showAuth(provider, status) {
  const state = status ?? { connected: false, provider };
  authState[provider] = state;
  const view = authView(provider, state, authAttempt[provider], authNote[provider]);
  authAttempt[provider] = view.attempt;
  authNote[provider] = view.message;
  drawAuth(provider, view);
  if (settings) syncRecommended();
}

/** Draws a provider's sign-in controls from what the view says. */
function drawAuth(provider, view) {
  const root = authRoot(provider);
  if (!root) return;
  const el = (name) => root.querySelector(`[data-auth="${name}"]`);
  const status = el('status');
  if (status) status.textContent = view.status;
  const login = el('login');
  if (login) login.hidden = view.connected;
  const logout = el('logout');
  if (logout) logout.hidden = !view.connected;
  const device = el('device');
  if (device) {
    if (view.deviceCode) {
      const code = el('deviceCode');
      if (code) code.textContent = view.deviceCode;
      const link = el('deviceLink');
      if (link && view.verificationUrl) link.href = view.verificationUrl;
      device.hidden = false;
    } else {
      device.hidden = true;
    }
  }
  const codeBox = el('code');
  if (codeBox) codeBox.hidden = !view.needsCode;
  const message = el('message');
  if (message) {
    message.textContent = view.message;
    message.hidden = !view.message;
  }
}

/** The message a provider's section shows under its sign-in buttons. */
function setAuthMessage(provider, text) {
  // A signed-in provider has nothing to complain about.
  const connected = Boolean(authState[provider]?.connected);
  authNote[provider] = connected ? '' : (text ?? '');
  const box = authEl(provider, 'message');
  if (!box) return;
  box.textContent = authNote[provider];
  box.hidden = !authNote[provider];
}

/** The device code of a sign-in, when the provider gave one. */
function showDeviceCode(provider, code, url) {
  const box = authEl(provider, 'device');
  if (!box) return;
  if (!code) {
    box.hidden = true;
    return;
  }
  const shown = authEl(provider, 'deviceCode');
  if (shown) shown.textContent = code;
  const link = authEl(provider, 'deviceLink');
  if (link && url) link.href = url;
  box.hidden = false;
}

/** The field the code the provider's page shows is pasted into. */
function showCodePrompt(provider, visible) {
  const box = authEl(provider, 'code');
  if (!box) return;
  box.hidden = !visible;
  // Keep the field on screen. The settings page is long, and scrolling to the
  // error at its bottom hides the field the code was just pasted into.
  if (visible) box.scrollIntoView({ block: 'nearest' });
}

/** A sign-in that failed: the section says why, in the panel's language. */
function showAuthError(provider, message, code) {
  authAttempt[provider] = null;
  showDeviceCode(provider, null);
  showCodePrompt(provider, false);
  setAuthMessage(provider, authMessage(code, message));
  const box = authEl(provider, 'message');
  if (box) box.scrollIntoView({ block: 'nearest' });
}

/** Draws every provider whose state the panel knows, after the frames changed. */
function redrawAuth() {
  for (const provider of ACCOUNT_PROVIDERS) {
    if (!authState[provider]) continue;
    const view = authView(provider, authState[provider], authAttempt[provider], authNote[provider]);
    authAttempt[provider] = view.attempt;
    authNote[provider] = view.message;
    drawAuth(provider, view);
  }
}

/**
 * Shows the sign-in each frame needs: the main one for the main slot, and the
 * backup's own when the main frame does not show that provider.
 */
function syncAuthFrames() {
  const view = backupAuthView({
    main: mainForm.provider(),
    backup: fallbackForm.provider(),
    claudeAuth: fallbackForm.claude().auth,
  });
  const note = $('fallbackProvider').querySelector('[data-field="accountNote"]');
  if (note) note.hidden = !view.note;
  const block = $('fallbackProvider').querySelector('[data-field="fallbackAuth"]');
  if (!block) return;
  block.hidden = !view.signIn;
  block.dataset.provider = view.signIn ?? '';
  const login = block.querySelector('[data-auth="login"]');
  if (login && view.signIn) login.textContent = t(`auth.login.${view.signIn}`);
  // The blocks moved: what each provider shows is drawn again.
  redrawAuth();
}

/** The status of one provider, from the worker. */
async function refreshAuthState(provider) {
  const status = await request('auth-status', { provider });
  showAuth(provider, status);
  return status;
}

/** The status of every account provider, from the worker. */
async function refreshAuthStates() {
  const statuses = await Promise.all(ACCOUNT_PROVIDERS.map((provider) => request('auth-status', { provider }).catch(() => null)));
  ACCOUNT_PROVIDERS.forEach((provider, i) => { if (statuses[i]) showAuth(provider, statuses[i]); });
}

/**
 * Opens the port a sign-in's events come on. The port closed with a worker
 * that stopped while the panel stayed open, and the worker the request wakes
 * would post a failure, the code prompt and the device code to no panel.
 * A session still being picked has no id to connect with yet, as in send().
 */
async function listenForSignIn() {
  while (picking) await picking.catch(() => {});
  if (!port && sessionId) connect();
}

async function startLogin(provider) {
  $('settingsError').hidden = true;
  setAuthMessage(provider, '');
  await listenForSignIn();
  try {
    const { userCode, verificationUrl } = await request('auth-start', { provider });
    if (userCode) showDeviceCode(provider, userCode, verificationUrl);
  } catch (err) {
    // The worker names the failure with a stable code; the panel shows its own
    // wording for it, the same one the auth-error message carries.
    setAuthMessage(provider, authMessage(err.code, err.message));
    showSettingsError(authNote[provider]);
  }
}

async function signOutProvider(provider) {
  try {
    showAuth(provider, await request('auth-logout', { provider }));
  } catch (err) {
    showSettingsError(err.message);
  }
}

async function cancelLogin(provider) {
  await request('auth-cancel', { provider }).catch(() => {});
  authAttempt[provider] = null;
  showDeviceCode(provider, null);
  showCodePrompt(provider, false);
  setAuthMessage(provider, '');
}

async function submitCode(provider) {
  const input = authEl(provider, 'codeInput');
  const value = input?.value.trim() ?? '';
  if (!value) return;
  try {
    await request('auth-input', { provider, attemptId: authAttempt[provider], value });
    if (input) input.value = '';
  } catch (err) {
    setAuthMessage(provider, authMessage(err.code, err.message));
    // The attempt may be gone: the status says whether it is still running.
    refreshAuthState(provider).catch(() => {});
  }
}

for (const name of ['login', 'logout', 'cancel', 'codeSubmit']) {
  for (const button of document.querySelectorAll(`[data-auth="${name}"]`)) {
    button.addEventListener('click', () => {
      const provider = providerOfBlock(button);
      if (!provider) return;
      if (name === 'login') startLogin(provider);
      else if (name === 'logout') signOutProvider(provider);
      else if (name === 'cancel') cancelLogin(provider);
      else submitCode(provider);
    });
  }
}

$('importBtn').addEventListener('click', async () => {
  try {
    showAuth('chatgpt', await request('auth-import', { text: $('authJson').value }));
    $('authJson').value = '';
    mainForm.loadModels(true);
  } catch (err) {
    showSettingsError(err.message);
  }
});
$('saveBtn').addEventListener('click', async () => {
  const next = readForm();
  const problem = settingsProblem(next);
  if (problem) {
    selectSettingsTab(problem.startsWith('err.fast') ? $('tabFast') : $('tabModels')); // show the field at fault
    showSettingsError(t(problem));
    return;
  }
  settings = await request('save-settings', { settings: next });
  updateChip();
  toggleSettings(false);
});

function updateChip() {
  const p = currentProviderSettings();
  const label = PROVIDER_LABELS[settings.provider] ?? presets[settings.compatible.preset]?.label ?? 'API';
  const fastTag = settings.fast.enabled && settings.fast.apiKey ? ' · ⚡' : '';
  $('modelChip').textContent = p.model ? `${label} · ${p.model}${p.effort ? ` · ${p.effort}` : ''}${fastTag}` : t('model.none');
}

function showSettingsError(message) {
  $('settingsError').textContent = message;
  $('settingsError').hidden = false;
  $('settingsError').scrollIntoView({ block: 'nearest' });
}

pick(startSessions).catch((err) => showSettingsError(err.message));
init().catch((err) => showSettingsError(err.message));
