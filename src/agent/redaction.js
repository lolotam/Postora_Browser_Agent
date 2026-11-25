// Sensitivity-aware redaction for tool arguments, read_field outputs, saved
// transcripts, handoff logs, and exported backups.
//
// A secret value read from a page (`read_field` on a secret field) or typed
// into a secret field (`type_text`, `insert_text`, `choose_suggestion` when
// `target.element.secret === true`) may travel to the active model turn that
// needs it, but must never be persisted in the transcript, the handoff log,
// the fast-layer action history / text candidates, or an exported backup.

export const REDACTED_SECRET = '[redacted secret]';

const SECRET_TEXT_TOOLS = new Set(['type_text', 'insert_text', 'choose_suggestion']);
const READ_FIELD_SECRET_LINE = /^(The value of element \[\d+\] \(a field that holds a secret\): )[\s\S]*$/;

/**
 * Projects tool arguments into a sensitivity-safe copy before they are emitted
 * into the transcript, recorded in the handoff log, or handed to the fast
 * layer.
 */
export function projectToolArgs(name, args, { secret = false } = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  if (!secret || !SECRET_TEXT_TOOLS.has(name)) return { ...args };
  const copy = { ...args };
  if (typeof copy.text === 'string') copy.text = REDACTED_SECRET;
  if (typeof copy.option === 'string') copy.option = REDACTED_SECRET;
  return copy;
}

/**
 * Redacts the value portion of a `read_field` output when the field is marked
 * as holding a secret.
 */
export function redactSecretReadOutput(text) {
  if (typeof text !== 'string' || !text) return text;
  const match = text.match(READ_FIELD_SECRET_LINE);
  if (!match) return text;
  return `${match[1]}${REDACTED_SECRET}`;
}

/**
 * Redacts a single transcript event before saving or exporting.
 */
export function sanitizeTranscriptEvent(event) {
  if (!event || typeof event !== 'object') return event;
  if (event.type === 'tool-start' && event.secret && event.args && typeof event.args === 'object') {
    const { secret: _secret, ...rest } = event;
    return { ...rest, args: projectToolArgs(event.name, event.args, { secret: true }) };
  }
  if (event.type === 'tool-end' && typeof event.summary === 'string') {
    const summary = redactSecretReadOutput(event.summary);
    if (summary !== event.summary) return { ...event, summary };
  }
  return event;
}

/**
 * Redacts a handoff log (`{ task, notes, steps, last }`) before saving or
 * exporting.
 */
export function sanitizeHandoffLog(log) {
  if (!log || typeof log !== 'object' || Array.isArray(log)) return log;
  const steps = Array.isArray(log.steps)
    ? log.steps.map((step) => {
      if (!step || typeof step !== 'object') return step;
      const args = step.secret ? projectToolArgs(step.name, step.args, { secret: true }) : step.args;
      const result = typeof step.result === 'string' ? redactSecretReadOutput(step.result) : step.result;
      const { secret: _secret, ...rest } = step;
      return { ...rest, args, result };
    })
    : log.steps;
  const last = log.last && typeof log.last === 'object'
    ? {
      ...log.last,
      ...(typeof log.last.text === 'string' ? { text: redactSecretReadOutput(log.last.text) } : {}),
    }
    : log.last;
  return { ...log, steps, last };
}

/**
 * Sanitizes a stored session body (`{ transcript, log, ... }`) so any secret
 * field read or typed secret is redacted in storage and backups.
 */
export function sanitizeSessionBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return {
    ...body,
    ...(Array.isArray(body.transcript) ? { transcript: body.transcript.map(sanitizeTranscriptEvent) } : {}),
    ...(body.log && typeof body.log === 'object' ? { log: sanitizeHandoffLog(body.log) } : {}),
  };
}
