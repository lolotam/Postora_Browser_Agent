// The observe → decide → act loop. Provider-agnostic: a session exposes
// addUserMessage / addToolResult / next, and returns { text, toolCalls }.
// An optional fast layer (Jev) runs before each LLM turn and either executes a
// confident step itself or hands the step to the LLM with ranked options.

import { escalationMessage } from '../fast/fast-layer.js';
import { kindOf } from './tool-kinds.js';
import { projectToolArgs, redactSecretReadOutput } from './redaction.js';
import { normalizeUsage } from '../lib/usage.js';
import { isWorkingTabClosed } from '../browser/working-tab.js';

const SKIPPED_PAGE_CHANGED = 'Not executed: the page changed after an earlier action in this turn. Decide again from the new page state.';
const SKIPPED_AFTER_ERROR = 'Not executed: an earlier action in this turn failed. Decide again.';
const SKIPPED_AFTER_ASK = 'Not executed: you asked the user a question in this turn. Read the answer, then decide again.';
const SKIPPED_AFTER_BOUNDARY = 'Not executed: an earlier action in this turn needs you to look at its result first. Decide again.';
const SKIPPED_FOR_MESSAGE = 'Not executed: the user sent you a message. Read it, then decide again.';
const SKIPPED_FOR_DIALOG = 'Not executed: a dialog is open.';
const STEER_PREFIX = 'Message from the user while you work (it may change or add to the task):';
const SUMMARY_PROMPT = 'You have reached the step limit. Stop using tools and write the final report now: what was done, all information collected with sources, and what remains.';
// A reply that was cut off is not an answer: the model is told and asked again,
// briefly. The retries of one step are capped, so a model whose replies keep
// being cut off ends the task instead of looping.
const TRUNCATED_MESSAGE = 'Your last reply was cut off before it was finished, so none of it was run. Answer again, briefly: one tool call at a time, and keep the reply short.';
const TRUNCATED_RETRIES = 2;
const STALL_NUDGE_REPEATS = 2;
const STALL_STOP_REPEATS = 4;
const STALL_NUDGE_NOTE = '[Stall warning: you have repeated the exact same action on the same page state. Choose a different tool, target, or approach.]';

/**
 * `steering` (optional) delivers what the user sends while the task runs:
 * `take()` returns the messages to read now, `waiting()` says one is due, and
 * `turnSignal(signal)` is the model request's signal, aborted to deliver a message
 * at once (the interrupted turn does not count as a step).
 */
export async function runAgent({ session, execute, task, images = [], maxSteps, signal, emit, fastLayer = null, steering = null, getAccessState = null, compaction = null, untrustedContext = null }) {
  // A conversation that was already too long when the task came is compacted
  // before the task is added: the task is never part of what gets summarized.
  if (compaction) await compaction.beforeTurn({ session, inputTokens: 0, signal, task, images, start: true });
  session.addUserMessage(task, images);
  // Untrusted file text is not part of the task: it is a message of its own, so
  // it cannot be read as something the user asked for.
  session.addUntrustedContext?.(untrustedContext);
  let fast = fastLayer;
  let fastActions = [];
  let llmHasSeenPage = false;
  let skipFastNextStep = false;
  let accessRevision = getAccessState?.()?.revision;
  let inputTokens = 0; // what the last model turn read: the size of the conversation
  let truncationRetries = 0; // the retries of a cut-off reply, in a row
  let pageFingerprint = 'initial';
  const actionCounts = new Map();
  let lastToolFailed = false;

  for (let step = 1; step <= maxSteps; step += 1) {
    throwIfAborted(signal);
    // Between turns every tool call has its result, so the conversation can be
    // replaced by a summary here. `compaction` decides whether it is due (a
    // /compact request, or the size) and does it; it says whether it did. This
    // comes before the new messages below are added, so they reach the model
    // as they were written, after the summary.
    if (compaction && await compaction.beforeTurn({ session, inputTokens, signal, task, images })) inputTokens = 0;
    const access = getAccessState?.();
    if (access && access.revision !== accessRevision) {
      accessRevision = access.revision;
      session.addUserMessage(`[Worker access update: the user selected ${access.mode}. This supersedes the earlier access snapshot. The tools enforce the current mode. A mode-changed result does not mean access was lowered. Continue the requested task under the current mode without asking for permission again.]`);
    }
    for (const item of steering?.take() ?? []) {
      const text = typeof item === 'string' ? item : item.text;
      const attached = typeof item === 'string' ? [] : (item.images ?? []);
      session.addUserMessage(`${STEER_PREFIX}\n${text}`, attached);
    }

    // A message waiting for the model goes to it now; the fast layer can wait a step.
    const skipFast = skipFastNextStep;
    skipFastNextStep = false;
    if (fast && !steering?.waiting() && !skipFast) {
      const started = Date.now();
      const outcome = await fast.step({ signal });
      throwIfAborted(signal);
      const fastUsage = normalizeUsage(outcome.usage);
      if (fastUsage) emit({ type: 'usage', source: 'fast', usage: fastUsage });
      if (outcome.kind === 'off') {
        fast = null;
        emit({ type: 'fast-handoff', reason: 'Fast layer is unavailable; continuing with the main model only' });
      } else if (outcome.kind === 'acted') {
        // The fast layer decides and acts in one go: its step covers both.
        const callId = `fast-${step}`;
        const secret = Boolean(outcome.result?.secret);
        const safeArgs = projectToolArgs(outcome.tool, outcome.args, { secret });
        const safeSummary = firstLine(redactSecretReadOutput(outcome.result.output));
        emit({ type: 'tool-start', step, callId, name: outcome.tool, args: safeArgs, ...(secret ? { secret: true } : {}), fast: true });
        emit({ type: 'tool-end', step, callId, name: outcome.tool, ok: !outcome.result.isError, summary: safeSummary, ms: Date.now() - started });
        fastActions.push(`${outcome.label} → ${safeSummary}`);
        continue;
      } else {
        if (outcome.reason) emit({ type: 'fast-handoff', reason: outcome.reason });
        const includePage = fastActions.length > 0 || !llmHasSeenPage;
        if (includePage && outcome.snapshot?.generation != null) {
          execute.noteSeenGeneration?.(outcome.snapshot.generation);
        }
        if (includePage && outcome.snapshot) {
          pageFingerprint = fingerprintSnapshot(outcome.snapshot);
        }
        const note = escalationMessage({ fastActions, outcome, includePage });
        if (note) session.addUserMessage(note);
        if (includePage && outcome.snapshot) llmHasSeenPage = true;
        fastActions = [];
      }
    }

    const turnId = `turn-${step}`;
    emit({ type: 'thinking', step, turnId, model: session.model ?? '' });
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
    // A reply that was cut off is not a turn: nothing in it was run. The model
    // is told and asked again, and the retry is part of the same step.
    if (turn.truncated) {
      if (truncationRetries >= TRUNCATED_RETRIES) {
        emit({ type: 'final', report: 'The model\'s replies kept being cut off, so the task was not finished.', success: false });
        return;
      }
      truncationRetries += 1;
      session.addUserMessage(TRUNCATED_MESSAGE);
      step -= 1; // the cut-off reply did not use the step
      continue;
    }
    truncationRetries = 0;
    if (turn.text) emit({ type: 'assistant-text', text: turn.text });
    inputTokens = normalizeUsage(turn.usage)?.input ?? inputTokens;

    // A message arrived while the model wrote its answer: it reads that first.
    if (!turn.toolCalls.length && steering?.waiting()) continue;
    if (!turn.toolCalls.length) {
      const reportText = String(turn.text ?? '').trim();
      emit({
        type: 'final',
        report: reportText ? turn.text : '(The model ended without a report.)',
        success: Boolean(reportText) && !lastToolFailed,
      });
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
        let result;
        try {
          result = await execute(call.name, call.args, { observe: last });
        } catch (err) {
          // The task cannot go on (the tab it works on is gone). The call still
          // gets a result, so the conversation stays valid for the next task.
          if (isWorkingTabClosed(err)) {
            // The history is repaired first: a panel that is gone must not
            // leave a call without a result.
            session.addToolResult(call.id, `Error: ${err.message}`);
            try {
              emit({ type: 'tool-end', step, callId: call.id, name: call.name, ok: false, summary: firstLine(err.message), ms: Date.now() - started });
            } catch {
              // The task ends with the error below either way.
            }
          }
          throw err;
        }
        const secret = Boolean(result.secret);
        lastToolFailed = Boolean(result.isError);
        const safeSummary = firstLine(redactSecretReadOutput(result.output));
        emit({ type: 'tool-end', step, callId: call.id, name: call.name, ok: !result.isError, summary: safeSummary, ...(secret ? { secret: true } : {}), ms: Date.now() - started });
        const observedFp = fingerprintOutput(result.output);
        if (observedFp) pageFingerprint = observedFp;
        let toolOutput = result.output;
        if (kindOf(call.name) !== 'bookkeeping') {
          const imageFp = Array.isArray(result.images) && result.images.length
            ? `img:${hashText(result.images.join('|'))}`
            : '';
          const stateFp = observedFp
            ? pageFingerprint
            : imageFp
              ? `${pageFingerprint}|${imageFp}`
              : (pageFingerprint === 'initial' ? hashText(String(result.output ?? '').trim()) : pageFingerprint);
          const actionHash = hashStallKey(call.name, call.args, stateFp);
          const count = (actionCounts.get(actionHash) ?? 0) + 1;
          actionCounts.set(actionHash, count);
          if (count > STALL_STOP_REPEATS) {
            session.addToolResult(call.id, toolOutput, result.images ?? [], { secret });
            for (const skipped of pending.splice(0)) session.addToolResult(skipped.id, 'Not executed: the run stopped because the agent repeated the same action without progress.');
            emit({
              type: 'final',
              report: `Stopped because the agent repeated the same action (${call.name}) on the same page state without making progress.`,
              success: false,
            });
            return;
          }
          if (count > STALL_NUDGE_REPEATS) {
            toolOutput = `${toolOutput ?? ''}\n\n${STALL_NUDGE_NOTE}`;
          }
        }
        session.addToolResult(call.id, toolOutput, result.images ?? [], { secret });
        if (result.staleGeneration) skipFastNextStep = true;
        fast?.recordLlmAction(call.name, call.args, undefined, { secret });
        llmHasSeenPage = true;
        // The rest of the turn waits for the model to look again when an action
        // failed (a pending done must not report success), when the user was asked
        // something (an approval must be read before anything it governs runs), or
        // when the page changed under an earlier action.
        const reason = result.dialogPending ? SKIPPED_FOR_DIALOG
          : result.isError ? SKIPPED_AFTER_ERROR
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
  emit({ type: 'thinking', step: maxSteps + 1, turnId: 'summary', model: session.model ?? '' });
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

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .filter((k) => k !== 'generation' && value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableJson(value[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function hashStallKey(name, args, pageFingerprint) {
  const raw = `${name}|${stableJson(args ?? {})}|${pageFingerprint ?? ''}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `${name}:${(h >>> 0).toString(16)}`;
}

function fingerprintSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return '';
  const body = [
    `URL: ${snap.url ?? ''}`,
    `Title: ${snap.title ?? ''}`,
    `Scroll: ${snap.scroll?.y ?? 0}/${snap.scroll?.height ?? 0}`,
    ...(snap.elements ?? []),
    (snap.text ?? '').slice(0, 1000),
  ].join('\n');
  return hashText(body);
}

function fingerprintOutput(output) {
  const text = String(output ?? '');
  const idx = text.indexOf('\nURL: ');
  const start = idx >= 0 ? idx + 1 : (text.startsWith('URL: ') ? 0 : -1);
  if (start < 0) return null;
  const noteAt = text.indexOf('Your notes (', start);
  const slice = (noteAt >= 0 ? text.slice(start, noteAt) : text.slice(start))
    .replace(/^Generation:\s*\d+\r?\n/m, '')
    .trim();
  return hashText(slice);
}

function hashText(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
