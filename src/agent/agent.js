// The observe → decide → act loop. Provider-agnostic: a session exposes
// addUserMessage / addToolResult / next, and returns { text, toolCalls }.
// An optional fast layer (Jev) runs before each LLM turn and either executes a
// confident step itself or hands the step to the LLM with ranked options.

import { escalationMessage } from '../fast/fast-layer.js';
import { kindOf } from './tool-kinds.js';
import { normalizeUsage } from '../lib/usage.js';

const SKIPPED_PAGE_CHANGED = 'Not executed: the page changed after an earlier action in this turn. Decide again from the new page state.';
const SKIPPED_AFTER_ERROR = 'Not executed: an earlier action in this turn failed. Decide again.';
const SKIPPED_AFTER_ASK = 'Not executed: you asked the user a question in this turn. Read the answer, then decide again.';
const SKIPPED_AFTER_BOUNDARY = 'Not executed: an earlier action in this turn needs you to look at its result first. Decide again.';
const SKIPPED_FOR_MESSAGE = 'Not executed: the user sent you a message. Read it, then decide again.';
const STEER_PREFIX = 'Message from the user while you work (it may change or add to the task):';
const SUMMARY_PROMPT = 'You have reached the step limit. Stop using tools and write the final report now: what was done, all information collected with sources, and what remains.';

/**
 * `steering` (optional) delivers what the user sends while the task runs:
 * `take()` returns the messages to read now, `waiting()` says one is due, and
 * `turnSignal(signal)` is the model request's signal, aborted to deliver a message
 * at once (the interrupted turn does not count as a step).
 */
export async function runAgent({ session, execute, task, images = [], maxSteps, signal, emit, fastLayer = null, steering = null }) {
  session.addUserMessage(task, images);
  let fast = fastLayer;
  let fastActions = [];
  let llmHasSeenPage = false;

  for (let step = 1; step <= maxSteps; step += 1) {
    throwIfAborted(signal);
    for (const item of steering?.take() ?? []) {
      const text = typeof item === 'string' ? item : item.text;
      const attached = typeof item === 'string' ? [] : (item.images ?? []);
      session.addUserMessage(`${STEER_PREFIX}\n${text}`, attached);
    }

    // A message waiting for the model goes to it now; the fast layer can wait a step.
    if (fast && !steering?.waiting()) {
      const started = Date.now();
      const outcome = await fast.step({ signal });
      throwIfAborted(signal);
      const fastUsage = normalizeUsage(outcome.usage);
      if (fastUsage) emit({ type: 'usage', source: 'fast', usage: fastUsage });
      if (outcome.kind === 'off') {
        fast = null;
        emit({ type: 'fast-handoff', reason: 'Fast layer failed 3 times; continuing with the main model only' });
      } else if (outcome.kind === 'acted') {
        // The fast layer decides and acts in one go: its step covers both.
        const callId = `fast-${step}`;
        emit({ type: 'tool-start', step, callId, name: outcome.tool, args: outcome.args, fast: true });
        emit({ type: 'tool-end', step, callId, name: outcome.tool, ok: !outcome.result.isError, summary: firstLine(outcome.result.output), ms: Date.now() - started });
        fastActions.push(`${outcome.label} → ${firstLine(outcome.result.output)}`);
        continue;
      } else {
        if (outcome.reason) emit({ type: 'fast-handoff', reason: outcome.reason });
        const note = escalationMessage({ fastActions, outcome, includePage: fastActions.length > 0 || !llmHasSeenPage });
        if (note) session.addUserMessage(note);
        fastActions = [];
      }
    }

    const turnId = `turn-${step}`;
    emit({ type: 'thinking', step, turnId });
    let turn;
    try {
      turn = await timedTurn(session, { signal: steering ? steering.turnSignal(signal) : signal, onEvent: emit }, turnId, emit);
    } catch (err) {
      // Interrupted to read a message: ask again with it, as the same step.
      if (err?.name !== 'AbortError' || signal?.aborted || !steering) throw err;
      emit({ type: 'text-reset' });
      emit({ type: 'turn-interrupted', turnId });
      step -= 1;
      continue;
    }
    if (turn.text) emit({ type: 'assistant-text', text: turn.text });

    // A message arrived while the model wrote its answer: it reads that first.
    if (!turn.toolCalls.length && steering?.waiting()) continue;
    if (!turn.toolCalls.length) {
      emit({ type: 'final', report: turn.text || '(The model ended without a report.)', success: true });
      return;
    }

    // Every tool call must get a result, even when the run stops early, or the
    // provider rejects the conversation on the next follow-up message.
    const pending = [...turn.toolCalls];
    try {
      while (pending.length) {
        throwIfAborted(signal);
        // A message from the user waits for no more of this batch, a report included.
        if (steering?.waiting()) {
          for (const skipped of pending.splice(0)) session.addToolResult(skipped.id, SKIPPED_FOR_MESSAGE);
          break;
        }
        const call = pending.shift();
        if (call.name === 'done') {
          session.addToolResult(call.id, 'Report delivered to the user.');
          emit({ type: 'final', report: call.args.report ?? '', success: call.args.success !== false });
          return;
        }
        // Several actions in one turn: only the last returns the page state, which
        // saves a full page snapshot per action; an earlier one reports it only if
        // the page changed, and then the rest of the batch is not run.
        // The turn's last page-changing call reports the page; notes after it do not count.
        // A boundary tool (ask_user, choose_suggestion) always reports in full and ends the batch.
        const boundary = kindOf(call.name) === 'boundary';
        const last = boundary || !pending.some((c) => ['observe', 'boundary'].includes(kindOf(c.name)));
        emit({ type: 'tool-start', step, callId: call.id, name: call.name, args: call.args });
        const started = Date.now();
        const result = await execute(call.name, call.args, { observe: last });
        emit({ type: 'tool-end', step, callId: call.id, name: call.name, ok: !result.isError, summary: firstLine(result.output), ms: Date.now() - started });
        session.addToolResult(call.id, result.output, result.images ?? []);
        fast?.recordLlmAction(call.name, call.args);
        llmHasSeenPage = true;
        // The rest of the turn waits for the model to look again when an action
        // failed (a pending done must not report success), when the user was asked
        // something (an approval must be read before anything it governs runs), or
        // when the page changed under an earlier action.
        const reason = result.isError ? SKIPPED_AFTER_ERROR
          : call.name === 'ask_user' ? SKIPPED_AFTER_ASK
            : boundary ? SKIPPED_AFTER_BOUNDARY
            : result.pageChanged ? SKIPPED_PAGE_CHANGED : null;
        if (reason) for (const skipped of pending.splice(0)) session.addToolResult(skipped.id, reason);
      }
    } finally {
      for (const call of pending) session.addToolResult(call.id, 'Not executed: the run ended before this call.');
    }
  }

  const unseen = fastActions.length ? `\n\nSteps executed by the fast layer you have not seen yet:\n${fastActions.join('\n')}` : '';
  session.addUserMessage(SUMMARY_PROMPT + unseen);
  emit({ type: 'thinking', step: maxSteps + 1, turnId: 'summary' });
  const summary = await timedTurn(session, { signal, onEvent: emit, toolChoice: 'none' }, 'summary', emit);
  emit({ type: 'final', report: summary.text || 'Step limit reached before the task was finished.', success: false });
}

/**
 * One model turn, reported with how long the model took (retry pauses shown apart),
 * its token usage when the provider gave one, and which model answered.
 */
async function timedTurn(session, options, turnId, emit) {
  const started = Date.now();
  const turn = await session.next(options);
  const retryWaitMs = turn.retryWaitMs ?? 0;
  emit({
    type: 'turn-end', turnId, model: session.model ?? '', usage: normalizeUsage(turn.usage),
    ms: Math.max(0, Date.now() - started - retryWaitMs), ...(retryWaitMs ? { retryWaitMs } : {}),
  });
  return turn;
}

function firstLine(text = '') {
  const line = String(text).split('\n')[0];
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException('Stopped by user', 'AbortError');
}
