import { test } from 'node:test';
import assert from 'node:assert/strict';

const { REDACTED_SECRET, projectToolArgs, redactSecretReadOutput, sanitizeSessionBody } = await import('../src/agent/redaction.js');
const { runAgent } = await import('../src/agent/agent.js');
const { createToolExecutor } = await import('../src/agent/tools.js');
const { FallbackSession } = await import('../src/agent/fallback-session.js');
const { createFastLayer, buildJevRequest } = await import('../src/fast/fast-layer.js');
const { AccessAuthority, FULL_ACCESS } = await import('../src/permissions/policy.js');

const SYNTHETIC_SECRET = 'SYNTHETIC_SECRET_TOKEN_987654321';

test('typed secrets and secret read_field outputs are redacted in transcript, handoff log, fast layer and backup while the active model turn still receives the read_field result', async () => {
  const access = new AccessAuthority({ sessionId: 'b7-redact' });
  access.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: access.revision });

  const fakeBrowser = {
    overlay: { pointTo: async () => {}, say: async () => {} },
    currentTab: async () => ({ id: 1, url: 'https://login.example.com' }),
    documentId: async () => 'doc-1',
    snapshot: async () => ({
      url: 'https://login.example.com',
      title: 'Login',
      generation: 1,
      scroll: { y: 0, viewport: 800, height: 800 },
      elements: ['[1] input[type=password] "Password"', '[2] input[type=text] "Username"'],
      offscreen: 0,
      text: 'Sign in',
    }),
    captureTarget: async ({ kind, index }) => ({
      scope: 'element',
      kind,
      tabId: 1,
      url: 'https://login.example.com',
      documentId: 'doc-1',
      generation: 1,
      element: {
        token: `tok-${index ?? 'focus'}`,
        tag: 'input',
        label: index === 1 ? 'Password' : 'Username',
        secret: index === 1 || kind === 'focus',
      },
    }),
    validateTarget: async () => ({ ok: true }),
    elementFrame: () => null,
    element: async () => ({ x: 10, y: 20, tag: 'input', label: 'Password' }),
    clickAt: async () => {},
    assertTypingTarget: async () => true,
    insertText: async () => {},
    pressKey: async () => {},
    readField: async (target) => ({
      ok: true,
      value: SYNTHETIC_SECRET,
      tag: 'input',
      secret: Boolean(target?.element?.secret),
    }),
  };

  const execute = createToolExecutor(fakeBrowser, { access });

  let jevRequests = [];
  const fastLayer = createFastLayer({
    config: { mode: 'hints' },
    browser: fakeBrowser,
    execute,
    task: 'Log in to the account',
    ask: async (req) => {
      jevRequests.push(req);
      return { answers: {} };
    },
  });

  const activeToolResults = [];
  let turnCount = 0;
  const primary = {
    addUserMessage() {},
    addToolResult(id, output) {
      activeToolResults.push({ id, output });
    },
    next: async () => {
      turnCount += 1;
      if (turnCount === 1) {
        return {
          text: '',
          toolCalls: [
            { id: 'c1', name: 'type_text', args: { index: 1, text: SYNTHETIC_SECRET } },
            { id: 'c2', name: 'read_field', args: { index: 1 } },
            { id: 'c3', name: 'type_text', args: { index: 2, text: 'alice_public' } },
          ],
        };
      }
      return {
        text: '',
        toolCalls: [{ id: 'c4', name: 'done', args: { report: 'Finished', success: true } }],
      };
    },
  };

  const session = new FallbackSession({ primary });
  const transcript = [];
  const emit = (event) => {
    if (event.type === 'tool-end' && event.secret && event.callId) {
      for (let i = transcript.length - 1; i >= 0; i -= 1) {
        const prev = transcript[i];
        if (prev?.type === 'tool-start' && prev.callId === event.callId) {
          transcript[i] = { ...prev, args: projectToolArgs(prev.name, prev.args, { secret: true }) };
          break;
        }
      }
    }
    if (event.type === 'tool-end' && typeof event.summary === 'string') {
      event.summary = redactSecretReadOutput(event.summary);
    }
    transcript.push(event);
  };

  await runAgent({
    session,
    execute,
    fastLayer,
    task: 'Log in to the account',
    maxSteps: 4,
    emit,
  });

  // 1. The active model turn received the real read_field output so it could use it.
  const c2Result = activeToolResults.find((r) => r.id === 'c2');
  assert.ok(c2Result?.output.includes(SYNTHETIC_SECRET), 'active model turn still receives the read_field value');

  // 2. The transcript has the secret redacted in both tool-start args and tool-end summary.
  const serializedTranscript = JSON.stringify(transcript);
  assert.equal(serializedTranscript.includes(SYNTHETIC_SECRET), false, 'transcript must not contain the synthetic secret');
  assert.equal(serializedTranscript.includes('alice_public'), true, 'non-secret typed text remains in transcript');

  // 3. The FallbackSession handoff log has the secret redacted in steps and last observation.
  const serializedLog = JSON.stringify(session.log);
  assert.equal(serializedLog.includes(SYNTHETIC_SECRET), false, 'handoff log must not contain the synthetic secret');
  assert.equal(serializedLog.includes(REDACTED_SECRET), true);
  assert.equal(serializedLog.includes('alice_public'), true);

  // 4. The fast layer's recent actions and reusable textCandidates never contain the secret.
  const serializedJev = JSON.stringify(jevRequests);
  assert.equal(serializedJev.includes(SYNTHETIC_SECRET), false, 'fast layer requests must not contain the synthetic secret');
  assert.equal(serializedJev.includes('alice_public'), true, 'non-secret text candidate is offered to the fast layer');

  // 5. sanitizeSessionBody redacts any legacy/stored session body for backup export.
  const sanitizedBody = sanitizeSessionBody({
    transcript: [
      { type: 'tool-start', step: 1, callId: 'legacy-1', name: 'type_text', args: { index: 1, text: SYNTHETIC_SECRET }, secret: true },
      { type: 'tool-end', step: 1, callId: 'legacy-2', name: 'read_field', ok: true, summary: `The value of element [1] (a field that holds a secret): ${SYNTHETIC_SECRET}` },
    ],
    log: {
      task: 'login',
      notes: [],
      steps: [{ name: 'type_text', args: { index: 1, text: SYNTHETIC_SECRET }, secret: true, result: 'Typed' }],
      last: { text: `The value of element [1] (a field that holds a secret): ${SYNTHETIC_SECRET}`, images: [] },
    },
  });
  assert.equal(JSON.stringify(sanitizedBody).includes(SYNTHETIC_SECRET), false);
});
