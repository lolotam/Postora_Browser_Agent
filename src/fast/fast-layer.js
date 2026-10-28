// "System One" fast layer in front of the LLM agent. Each step asks Jev one
// request with several typed questions over the current page. When the answers
// are confident and safe, the step runs immediately without an LLM call; when
// not, the LLM is consulted and receives Jev's ranked options as hints.

import { askJev } from './jev-client.js';
import { formatSnapshot } from '../agent/tools.js';
import { isFastAccessFailure } from './errors.js';

export const DEFAULT_GATE = {
  minProb: 0.6, // probability of the chosen option
  minConfidence: 0.4, // how peaked the choice distribution is
  riskyMax: 0.3, // at or above this, never act without the LLM (and the user)
  doneMin: 0.8, // goal reached → hand over to the LLM to write the report
  maxStreak: 8, // consecutive fast steps before a mandatory LLM check-in
  maxIdle: 3, // hand-overs in a row without a fast step before the layer pauses
  pauseTurns: 3, // LLM turns the pause lasts, unless the page changes first
};

const MAX_TARGETS = 240; // Jev's Choice supports up to 255 options
const PAGE_TEXT_CHARS = 3000;
const RECENT_ACTIONS = 6;

const OPERATIONS = {
  click: 'Click one of the listed interactive elements (link, button, tab, checkbox, menu item) because activating it leads toward the GOAL.',
  type: 'Type one of the offered text values into a listed text box or search box that does not already contain it.',
  press_enter: 'Press Enter to submit text that was just typed; the box already contains the value the GOAL needs.',
  scroll_down: 'Scroll down because what the GOAL needs is probably further down this page.',
  scroll_up: 'Scroll up because what the GOAL needs is probably above the current view.',
  go_back: 'Go back to the previous page because this page is a wrong turn.',
  done: 'Stop: the current page already shows or completes everything the GOAL asks for.',
  think: 'None of the above fits well: the next step needs reading and analysing content, writing new text, opening a specific URL, comparing options, or a careful decision.',
};

/** Text Jev may type: quoted values in the task plus anything the LLM typed before. */
export function extractTextCandidates(task) {
  const found = [];
  const pattern = /"([^"\n]{1,200})"|“([^”\n]{1,200})”|«([^»\n]{1,200})»|`([^`\n]{1,200})`/g;
  for (const m of String(task).matchAll(pattern)) {
    const value = (m[1] ?? m[2] ?? m[3] ?? m[4]).trim();
    if (value && !found.includes(value)) found.push(value);
  }
  return found;
}

export function buildJevRequest({ task, snapshot, recent, textCandidates }) {
  const elements = snapshot.elements.slice(0, MAX_TARGETS).map((line) => {
    const m = line.match(/^\[(\d+)\]\s*(.*)$/);
    return { id: `e${m[1]}`, line: `e${m[1]}: ${m[2]}` };
  });
  const state = {
    GOAL: task,
    URL: snapshot.url,
    TITLE: snapshot.title,
    PAGE_TEXT: (snapshot.text ?? '').slice(0, PAGE_TEXT_CHARS),
    INTERACTIVE_ELEMENTS: elements.map((e) => e.line).join('\n') || '(none)',
    LAST_ACTIONS: recent.slice(-RECENT_ACTIONS),
  };

  const questions = {
    operation: {
      type: 'choice',
      instructions: 'Which single browser operation should be taken next to make progress toward the `GOAL`, given `LAST_ACTIONS`?',
      criteria: OPERATIONS,
    },
    goal_done: {
      type: 'noul',
      instructions: 'Everything the `GOAL` asks for has already been achieved or is fully visible on the current page.',
    },
    risky: {
      type: 'noul',
      instructions: 'The next step toward the `GOAL` on this page would buy, pay, send a message, post, delete data, accept terms, submit personal data, or log in.',
    },
  };
  if (elements.length) {
    questions.target = {
      type: 'choice',
      instructions: 'If the next step clicks or types, which element in `INTERACTIVE_ELEMENTS` should it act on to make progress toward the `GOAL`?',
      criteria: Object.fromEntries(elements.map((e) => [e.id, e.line])),
    };
  }
  if (textCandidates.length) {
    questions.text = {
      type: 'choice',
      instructions: 'If the next step types text, which value should be typed?',
      criteria: {
        ...Object.fromEntries(textCandidates.map((t, i) => [`t${i}`, `Type "${t}"`])),
        none: 'Nothing needs to be typed next.',
      },
    };
  }
  return { state, questions };
}

function confident(answer, gate) {
  if (!answer) return false;
  const p = answer.probabilities?.[answer.choice] ?? 0;
  return p >= gate.minProb && (answer.confidence ?? 0) >= gate.minConfidence;
}

function top(answer, n = 3) {
  return Object.entries(answer?.probabilities ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .filter(([, p]) => p >= 0.02);
}

/** Ranked options for the LLM. Probabilities, not instructions. */
export function formatHints(answers, snapshot) {
  const lineOf = (id) => snapshot.elements.find((l) => l.startsWith(`[${id.slice(1)}]`)) ?? id;
  const pct = (p) => `${Math.round(p * 100)}%`;
  const lines = ['Fast layer ranked options — probabilities to speed you up, not instructions:'];
  if (answers.operation) lines.push(`- next operation: ${top(answers.operation).map(([k, p]) => `${k} ${pct(p)}`).join(', ')}`);
  if (answers.target) lines.push(`- likely element: ${top(answers.target).map(([k, p]) => `${lineOf(k)} (${pct(p)})`).join('; ')}`);
  if (answers.goal_done) lines.push(`- goal already achieved: ${pct(answers.goal_done.noul)}`);
  if (answers.risky) lines.push(`- next step is sensitive (pay/send/delete/login): ${pct(answers.risky.noul)}`);
  return lines.join('\n');
}

/**
 * Pure gate: turns Jev's answers into an action to run now, a hand-over to the
 * LLM because the goal looks done, or an escalation with a reason.
 */
export function decide({ answers, snapshot, textCandidates, gate = DEFAULT_GATE, recentKeys = [] }) {
  const op = answers.operation;
  const risky = answers.risky?.noul ?? 1;
  const doneP = answers.goal_done?.noul ?? 0;

  if (doneP >= gate.doneMin || (op?.choice === 'done' && confident(op, gate))) {
    return { kind: 'done', reason: `goal looks achieved (${Math.round(Math.max(doneP, op?.probabilities?.done ?? 0) * 100)}%)` };
  }
  if (!op || !OPERATIONS[op.choice]) return { kind: 'escalate', reason: 'no usable operation' };
  if (risky >= gate.riskyMax) return { kind: 'escalate', reason: `next step may be sensitive (${Math.round(risky * 100)}%)` };
  if (op.choice === 'think' || op.choice === 'done') return { kind: 'escalate', reason: 'step needs reasoning' };
  if (!confident(op, gate)) return { kind: 'escalate', reason: `unsure about the operation (${op.choice})` };

  const needsTarget = op.choice === 'click' || op.choice === 'type';
  if (needsTarget && !confident(answers.target, gate)) return { kind: 'escalate', reason: 'unsure which element to use' };
  const index = needsTarget ? Number(answers.target.choice.slice(1)) : null;
  const line = needsTarget ? snapshot.elements.find((l) => l.startsWith(`[${index}]`)) ?? '' : '';

  let action;
  if (op.choice === 'click') {
    action = { tool: 'click', args: { index }, label: `click ${line}` };
  } else if (op.choice === 'type') {
    const t = answers.text;
    if (!confident(t, gate) || t.choice === 'none') return { kind: 'escalate', reason: 'new text must be written' };
    const text = textCandidates[Number(t.choice.slice(1))];
    if (text === undefined) return { kind: 'escalate', reason: 'unknown text option' };
    if (/type=password/.test(line)) return { kind: 'escalate', reason: 'password field' };
    action = { tool: 'type_text', args: { index, text, clear: true }, label: `type "${text}" into ${line}` };
  } else if (op.choice === 'press_enter') {
    action = { tool: 'press_key', args: { key: 'Enter' }, label: 'press Enter' };
  } else if (op.choice === 'scroll_down' || op.choice === 'scroll_up') {
    const direction = op.choice === 'scroll_down' ? 'down' : 'up';
    action = { tool: 'scroll', args: { direction }, label: `scroll ${direction}` };
  } else {
    action = { tool: 'history', args: { action: 'back' }, label: 'go back' };
  }

  const key = `${action.tool}|${JSON.stringify(action.args)}|${snapshot.url}`;
  const repeatLimit = action.tool === 'scroll' ? 3 : 1;
  if (recentKeys.filter((k) => k === key).length >= repeatLimit) return { kind: 'escalate', reason: 'fast layer is repeating itself' };
  return { kind: 'act', key, ...action };
}

/**
 * Stateful runner used by the agent loop. `mode` is "auto" (execute confident
 * steps) or "hints" (never act; only give the LLM ranked options).
 */
export function createFastLayer({ config, browser, execute, task, ask = askJev }) {
  const gate = { ...DEFAULT_GATE, ...pickNumbers(config) };
  const textCandidates = extractTextCandidates(task);
  const recent = [];
  const recentKeys = [];
  let streak = 0;
  let failures = 0;
  // Reading and comparing tasks hand most steps over; after a run of hand-overs the
  // layer pauses so each LLM turn is not delayed by a Jev call it will not use.
  let idle = 0;
  let pause = null; // { turns, url }

  return {
    /** Records a step the LLM took so Jev sees it in LAST_ACTIONS next time. */
    recordLlmAction(name, args, url) {
      streak = 0;
      recent.push(`${name} ${JSON.stringify(args)}${url ? ` on ${url}` : ''}`);
      if (name === 'type_text' && args?.text && !textCandidates.includes(args.text)) textCandidates.push(args.text);
    },

    async step({ signal } = {}) {
      if (failures >= 3) return { kind: 'off' };
      if (pause && (await advancePause())) return { kind: 'paused' };
      let snapshot;
      try {
        snapshot = await browser.snapshot();
      } catch {
        // A new tab or chrome:// page is no web page yet: the LLM opens one, no notice needed.
        const url = (await browser.currentTab().catch(() => null))?.url ?? '';
        return { kind: 'escalate', reason: /^(https?|file):/.test(url) ? 'page cannot be read' : '', snapshot: null, hints: '' };
      }
      let answers;
      let usage = null;
      try {
        const request = buildJevRequest({ task, snapshot, recent, textCandidates });
        ({ answers, usage } = await ask({ ...config, ...request, signal }));
        failures = 0;
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') throw err;
        failures = isFastAccessFailure(err) ? 3 : failures + 1;
        return { kind: 'escalate', reason: `Fast layer unavailable: ${err.message}`, snapshot, hints: '' };
      }

      const hints = formatHints(answers, snapshot);
      const decision = decide({ answers, snapshot, textCandidates, gate, recentKeys });
      if (decision.kind === 'escalate' && (idle += 1) >= gate.maxIdle) {
        idle = 0;
        pause = { turns: gate.pauseTurns, url: snapshot.url };
      }
      if (decision.kind !== 'act') return { ...decision, snapshot, hints, usage };
      if (config.mode !== 'auto') return { kind: 'escalate', reason: '', snapshot, hints, usage };
      if (streak >= gate.maxStreak) {
        streak = 0;
        return { kind: 'escalate', reason: 'periodic check-in', snapshot, hints, usage };
      }

      const result = await execute(decision.tool, decision.args);
      streak += 1;
      idle = 0;
      recent.push(`${decision.label} on ${snapshot.url}`);
      recentKeys.push(decision.key);
      return { ...decision, kind: 'acted', result, usage };
    },
  };

  /** Counts down one LLM turn of the pause and tells whether it still holds; a page change ends it early. */
  async function advancePause() {
    const url = (await browser.currentTab().catch(() => null))?.url;
    pause.turns -= 1;
    if (pause.turns < 0 || url !== pause.url) pause = null;
    return Boolean(pause);
  }
}

function pickNumbers(config) {
  const out = {};
  for (const key of Object.keys(DEFAULT_GATE)) {
    const value = Number(config?.[key]);
    if (config?.[key] !== undefined && config[key] !== '' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** The message the LLM receives when the fast layer hands a step over. */
export function escalationMessage({ fastActions, outcome, includePage }) {
  const parts = [];
  if (fastActions.length) {
    parts.push(`[Fast layer] Since your last turn these steps were executed automatically:\n${fastActions.map((a, i) => `${i + 1}. ${a}`).join('\n')}`);
  }
  if (outcome.kind === 'done') {
    parts.push(`[Fast layer] ${outcome.reason}. Verify it; if complete, call done with the full report, otherwise continue.`);
  } else if (outcome.reason) {
    parts.push(`[Fast layer] Handing over to you: ${outcome.reason}.`);
  }
  if (includePage && outcome.snapshot) parts.push(`Current page state:\n${formatSnapshot(outcome.snapshot)}`);
  if (outcome.hints) parts.push(outcome.hints);
  return parts.join('\n\n');
}
