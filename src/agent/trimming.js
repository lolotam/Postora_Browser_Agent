// Shared conversation trimming and size accounting across all three providers
// (OpenAI Chat Completions, Anthropic Messages, and OpenAI Responses).
//
// Keeps the last two page observations (tool results or fast-layer snapshots)
// and the latest notebook read in full; older observations are trimmed.
// File reads (project_read, project_context, project_list) and ask_user answers
// are exempt from observation trimming so code and user answers stay intact.

import { kindOf } from './tool-kinds.js';
import {
  NOTEBOOK_HEADER,
  NOTE_SAVED_ARGS,
  trimKeepingNotebook,
  withoutNotebook,
} from './notebook.js';

export const KEEP_FULL_OBSERVATIONS = 2;
export const TRIMMED_OBSERVATION_CHARS = 400;
export const SCREENSHOT_MESSAGE_PREFIX = 'Screenshot returned by the last tool call:';
export const FAST_SNAPSHOT_MARKER = 'Current page state:\n';

const EXEMPT_TOOLS = new Set([
  'project_read',
  'project_context',
  'project_list',
  'ask_user',
]);

/** True when a tool result is a page observation that should be trimmed once older. */
export function isTrimmableToolResult(name) {
  if (EXEMPT_TOOLS.has(name)) return false;
  return !['bookkeeping', 'notes'].includes(kindOf(name));
}

/** True when text is a fast-layer escalation message carrying a page snapshot. */
export function hasFastPageSnapshot(text) {
  return typeof text === 'string' && text.includes(FAST_SNAPSHOT_MARKER);
}

/** Trims the `Current page state:` section inside an older fast-layer escalation message. */
export function trimFastSnapshotText(text, chars = TRIMMED_OBSERVATION_CHARS) {
  const s = String(text ?? '');
  const idx = s.indexOf(FAST_SNAPSHOT_MARKER);
  if (idx < 0) return s;
  const bodyStart = idx + FAST_SNAPSHOT_MARKER.length;
  // Find if a FAST LAYER HINTS untrusted block follows the page snapshot block.
  const endMarker = '<<<END UNTRUSTED DATA';
  const endIdx = s.indexOf(endMarker, bodyStart);
  let snapshotEnd = s.length;
  if (endIdx >= 0) {
    const lineEnd = s.indexOf('\n', endIdx);
    snapshotEnd = lineEnd >= 0 ? lineEnd : s.length;
  }
  const snapshotPart = s.slice(bodyStart, snapshotEnd);
  if (snapshotPart.length <= chars + 50) return s;
  const trimmedPart = `${snapshotPart.slice(0, chars)}\n…[older page state trimmed]`;
  const tail = s.slice(snapshotEnd);
  return `${s.slice(0, bodyStart)}${trimmedPart}${tail}`;
}

/**
 * Shared compaction for OpenAI-compatible Chat Completions `messages`.
 */
export function compactChatMessages(messages) {
  const names = new Map();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) names.set(tc.id, tc.function?.name);
  }

  const entries = [];
  messages.forEach((m, index) => {
    if (m.role === 'tool') {
      const name = names.get(m.tool_call_id);
      entries.push({
        kind: 'tool',
        index,
        name,
        callId: m.tool_call_id,
        getText: () => (typeof m.content === 'string' ? m.content : ''),
        setText: (text) => { if (typeof m.content === 'string') m.content = text; },
      });
    } else if (m.role === 'user') {
      const text = readChatUserText(m);
      if (hasFastPageSnapshot(text)) {
        entries.push({
          kind: 'fast',
          index,
          getText: () => readChatUserText(m),
          setText: (next) => writeChatUserText(m, next),
        });
      }
    }
  });

  applySharedCompaction(entries, {
    foldSavedNotes(lastNotebookIndex) {
      const resultAt = new Map(entries.filter((e) => e.kind === 'tool').map((e) => [e.callId, e.index]));
      for (const m of messages) {
        for (const tc of m.tool_calls ?? []) {
          if (tc.function?.name === 'note' && resultAt.get(tc.id) < lastNotebookIndex) {
            tc.function.arguments = NOTE_SAVED_ARGS;
          }
        }
      }
    },
  });

  const withImages = messages.filter((m) => isChatScreenshotMessage(m));
  for (const m of withImages.slice(0, -1)) {
    m.content = m.content.map((c) => (c.type === 'image_url' ? { type: 'text', text: '[older screenshot removed]' } : c));
  }
}

/**
 * Shared compaction for Anthropic Messages `messages`.
 */
export function compactAnthropicMessages(messages) {
  const names = new Map();
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool_use') names.set(block.id, block.name);
    }
  }

  const entries = [];
  let seq = 0;
  for (const message of messages) {
    for (const block of message.content ?? []) {
      if (block.type === 'tool_result') {
        const index = seq++;
        const name = names.get(block.tool_use_id);
        entries.push({
          kind: 'tool',
          index,
          name,
          callId: block.tool_use_id,
          getText: () => anthropicResultText(block),
          setText: (text) => setAnthropicResultText(block, text),
        });
      } else if (message.role === 'user' && block.type === 'text' && hasFastPageSnapshot(block.text)) {
        const index = seq++;
        entries.push({
          kind: 'fast',
          index,
          getText: () => block.text ?? '',
          setText: (text) => { block.text = text; },
        });
      }
    }
  }

  applySharedCompaction(entries, {
    foldSavedNotes(lastNotebookIndex) {
      const resultAt = new Map(entries.filter((e) => e.kind === 'tool').map((e) => [e.callId, e.index]));
      for (const message of messages) {
        for (const block of message.content ?? []) {
          if (block.type === 'tool_use' && block.name === 'note' && resultAt.get(block.id) < lastNotebookIndex) {
            block.input = JSON.parse(NOTE_SAVED_ARGS);
          }
        }
      }
    },
  });

  const images = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const [inner, part] of block.content.entries()) {
          if (part.type === 'image') images.push({ holder: block.content, index: inner });
        }
      }
    }
  }
  for (const image of images.slice(0, -1)) {
    image.holder[image.index] = { type: 'text', text: '[older screenshot removed]' };
  }
}

/**
 * Shared compaction for OpenAI Responses `input`.
 */
export function compactResponsesInput(input) {
  const names = new Map(input.filter((i) => i.type === 'function_call').map((i) => [i.call_id, i.name]));
  const entries = [];

  input.forEach((item, index) => {
    if (item.type === 'function_call_output') {
      const name = names.get(item.call_id);
      entries.push({
        kind: 'tool',
        index,
        name,
        callId: item.call_id,
        getText: () => (typeof item.output === 'string' ? item.output : ''),
        setText: (text) => { if (typeof item.output === 'string') item.output = text; },
      });
    } else if (item.type === 'message' && item.role === 'user') {
      const text = readResponsesUserText(item);
      if (hasFastPageSnapshot(text)) {
        entries.push({
          kind: 'fast',
          index,
          getText: () => readResponsesUserText(item),
          setText: (next) => writeResponsesUserText(item, next),
        });
      }
    }
  });

  applySharedCompaction(entries, {
    foldSavedNotes(lastNotebookIndex) {
      const resultAt = new Map(entries.filter((e) => e.kind === 'tool').map((e) => [e.callId, e.index]));
      for (const item of input) {
        if (item.type === 'function_call' && item.name === 'note' && resultAt.get(item.call_id) < lastNotebookIndex) {
          item.arguments = NOTE_SAVED_ARGS;
        }
      }
    },
  });

  const withImages = input.filter((i) => isResponsesScreenshotItem(i));
  for (const message of withImages.slice(0, -1)) {
    message.content = message.content.map((c) => (c.type === 'input_image' ? { type: 'input_text', text: '[older screenshot removed]' } : c));
  }
}

function applySharedCompaction(entries, { foldSavedNotes }) {
  const toolEntries = entries.filter((e) => e.kind === 'tool');
  const observations = entries.filter((e) => e.kind === 'fast' || (e.kind === 'tool' && isTrimmableToolResult(e.name)));
  const notebookReads = toolEntries.filter((e) => kindOf(e.name) === 'notes');

  let lastNotebookIndex = -1;
  for (const e of toolEntries) {
    if (e.getText().includes(NOTEBOOK_HEADER)) lastNotebookIndex = e.index;
  }

  for (const e of toolEntries) {
    if (e.index < lastNotebookIndex) e.setText(withoutNotebook(e.getText()));
  }

  for (const e of observations.slice(0, -KEEP_FULL_OBSERVATIONS)) {
    if (e.kind === 'fast') {
      e.setText(trimFastSnapshotText(e.getText(), TRIMMED_OBSERVATION_CHARS));
    } else {
      e.setText(trimKeepingNotebook(e.getText(), TRIMMED_OBSERVATION_CHARS));
    }
  }

  for (const e of notebookReads.slice(0, -1)) {
    e.setText(trimKeepingNotebook(e.getText(), TRIMMED_OBSERVATION_CHARS));
  }

  foldSavedNotes(lastNotebookIndex);
}

/** Estimates character size of a conversation for fallback token estimation (`chars / 4`). */
export function estimateConversationChars(items = []) {
  let total = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.content === 'string') total += item.content.length;
    else if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (typeof part?.text === 'string') total += part.text.length;
        else if (typeof part?.thinking === 'string') total += part.thinking.length;
        else if (part?.type === 'tool_use') total += JSON.stringify(part.input ?? {}).length + String(part.name ?? '').length;
        else if (part?.type === 'tool_result') {
          if (typeof part.content === 'string') total += part.content.length;
          else if (Array.isArray(part.content)) {
            for (const sub of part.content) if (typeof sub?.text === 'string') total += sub.text.length;
          }
        }
      }
    }
    if (typeof item.output === 'string') total += item.output.length;
    if (typeof item.arguments === 'string') total += item.arguments.length;
    if (Array.isArray(item.tool_calls)) {
      for (const tc of item.tool_calls) {
        total += String(tc?.function?.name ?? '').length + String(tc?.function?.arguments ?? '').length;
      }
    }
  }
  return total;
}

function readChatUserText(m) {
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.find((c) => c.type === 'text')?.text ?? '';
  return '';
}

function writeChatUserText(m, text) {
  if (typeof m.content === 'string') {
    m.content = text;
    return;
  }
  if (Array.isArray(m.content)) {
    const part = m.content.find((c) => c.type === 'text');
    if (part) part.text = text;
  }
}

function readResponsesUserText(item) {
  if (!Array.isArray(item.content)) return '';
  return item.content.find((c) => c.type === 'input_text')?.text ?? '';
}

function writeResponsesUserText(item, text) {
  if (!Array.isArray(item.content)) return;
  const part = item.content.find((c) => c.type === 'input_text');
  if (part) part.text = text;
}

function anthropicResultText(block) {
  if (typeof block.content === 'string') return block.content;
  return (block.content ?? []).find((b) => b.type === 'text')?.text ?? '';
}

function setAnthropicResultText(block, text) {
  if (typeof block.content === 'string') {
    block.content = text;
    return;
  }
  const index = (block.content ?? []).findIndex((b) => b.type === 'text');
  if (index >= 0) block.content[index] = { ...block.content[index], text };
}

function isChatScreenshotMessage(m) {
  if (!m || m.role !== 'user' || !Array.isArray(m.content)) return false;
  if (!m.content.some((c) => c.type === 'image_url')) return false;
  const textParts = m.content.filter((c) => c.type === 'text');
  return textParts.length === 0 || textParts.some((c) => String(c.text ?? '').startsWith(SCREENSHOT_MESSAGE_PREFIX));
}

function isResponsesScreenshotItem(item) {
  if (!item || item.type !== 'message' || !Array.isArray(item.content)) return false;
  if (!item.content.some((c) => c.type === 'input_image')) return false;
  const textParts = item.content.filter((c) => c.type === 'input_text');
  return textParts.length === 0 || textParts.some((c) => String(c.text ?? '').startsWith(SCREENSHOT_MESSAGE_PREFIX));
}
