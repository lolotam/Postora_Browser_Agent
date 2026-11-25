import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.chrome = {
  debugger: { onDetach: { addListener() {} }, detach: async () => {} },
  tabs: { onRemoved: { addListener() {} } },
  storage: {
    local: {
      get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in store).map((k) => [k, structuredClone(store[k])])),
      set: async (obj) => Object.assign(store, structuredClone(obj)),
      remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]),
    },
  },
};

const { SessionRunner } = await import('../src/background/session-runner.js');
const sessions = await import('../src/sessions/store.js');

test('a deleted session is not written back by its last events', async () => {
  const meta = await sessions.createStoredSession('Doomed');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });

  runner.dispose();
  await sessions.deleteSession(meta.id);
  runner.emit({ type: 'status', running: false }); // what a stopping task emits in its finally block
  await new Promise((r) => setTimeout(r, 700)); // past the save debounce

  assert.equal(`session:${meta.id}` in store, false);
  assert.deepEqual(await sessions.listSessions(), []);
});

test('what the panel sent while the session was loading is handled once it attaches', async () => {
  const meta = await sessions.createStoredSession('Woken');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  const received = [];
  const port = { postMessage: (event) => received.push(event), onDisconnect: { addListener() {} }, onMessage: { addListener() {} } };

  runner.attach(port, [{ type: 'dismiss-notice', id: 'n1' }]);

  assert.deepEqual(received.map((e) => e.type), ['replay', 'notice-dismissed']);
  runner.dispose();
});

test('a panel that left while the session loaded does not swallow the next panel\'s events', async () => {
  const meta = await sessions.createStoredSession('Revisited');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  const closed = {
    postMessage: () => { throw new Error('Attempting to use a disconnected port object'); },
    onDisconnect: { addListener() {} },
    onMessage: { addListener() {} },
  };
  const received = [];
  const open = { postMessage: (event) => received.push(event), onDisconnect: { addListener() {} }, onMessage: { addListener() {} } };

  runner.attach(closed, [{ type: 'dismiss-notice', id: 'n1' }]);
  runner.attach(open);
  runner.emit({ type: 'user', text: 'first task' });

  assert.deepEqual(received.map((e) => e.type), ['replay', 'user']);
  assert.equal(runner.ports.size, 1);
  runner.dispose();
});

test('messages sent while a task runs: next step, queued, sent now, removed', async () => {
  const meta = await sessions.createStoredSession('Steered');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  const events = [];
  runner.emit = (e) => events.push(e);
  runner.abort = new AbortController(); // a task is running
  const steering = runner.steering();
  const signal = steering.turnSignal(runner.abort.signal);

  runner.steer('use the blue one', 'next-step');
  runner.steer('then email me', 'queue');
  assert.deepEqual(events.filter((e) => e.type === 'pending-added').map((e) => e.item.mode), ['next-step', 'queue']);
  assert.equal(steering.waiting(), true);
  const first = steering.take();
  assert.equal(first.length, 1); // the queued one waits for the task to end
  assert.match(first[0].text, /^use the blue one\n\n\[Reply in the language/); // with the reply-language note
  assert.deepEqual(first[0].images, []); // no file came with the message
  assert.equal(steering.waiting(), false);
  assert.deepEqual(events.filter((e) => e.type === 'user' && e.steer).map((e) => e.text), ['use the blue one']);

  // Send now: the waiting message becomes due and the model's turn is cut short.
  const queued = runner.inbox[0];
  runner.sendNow(queued.id);
  assert.equal(signal.aborted, true);
  assert.equal(steering.waiting(), true);
  const second = steering.take();
  assert.match(second[0].text, /^then email me/);
  assert.deepEqual(second[0].images, []);

  runner.steer('never mind', 'queue');
  runner.dropMessage(runner.inbox[0].id);
  assert.equal(runner.inbox.length, 0);
  assert.ok(events.some((e) => e.type === 'pending-removed'));
  runner.abort = null;
  runner.dispose();
});

test('with no task running, a message or a Send now starts the task', async () => {
  const meta = await sessions.createStoredSession('Idle');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  const started = [];
  runner.start = (text) => started.push(text);
  runner.emit = () => {};
  runner.steer('find hotels', 'queue');
  runner.inbox.push({ id: 'kept', text: 'left after a Stop', mode: 'queue', now: false });
  runner.sendNow('kept');
  assert.deepEqual(started, ['find hotels', 'left after a Stop']);
  assert.equal(runner.inbox.length, 0);
  runner.dispose();
});

test('one "trying again" notice per task, however often the provider stalls', async () => {
  const meta = await sessions.createStoredSession('Flaky');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  const shown = [];
  runner.emit = (e) => { if (e.type === 'notice') shown.push(e.kind); };
  assert.ok(runner.notify({ kind: 'retrying', level: 'warning' }));
  assert.equal(runner.notify({ kind: 'retrying', level: 'warning' }), null);
  assert.ok(runner.notify({ kind: 'switched', level: 'error' })); // other notices still show
  assert.deepEqual(shown, ['retrying', 'switched']);
  runner.dispose();
});

test('a provider error keeps the checkpoint so Resume is offered, while a non-provider error clears it', async () => {
  const { isResumableProviderError } = await import('../src/background/session-runner.js');
  assert.equal(isResumableProviderError(Object.assign(new Error('HTTP 503'), { status: 503 })), true);
  assert.equal(isResumableProviderError(new Error('Model request failed: the response stream ended before the answer was complete.')), true);
  assert.equal(isResumableProviderError(new Error('Primary failed: HTTP 429 Backup failed: HTTP 503')), true);
  assert.equal(isResumableProviderError(new Error('No active tab found.')), false);

  const meta = await sessions.createStoredSession('CheckpointKept');
  const runner = new SessionRunner({ meta, body: await sessions.loadSession(meta.id), color: 'cyan', isTakenByOther: () => null, onSessionsChanged: () => {} });
  const statuses = [];
  const origEmit = runner.emit.bind(runner);
  runner.emit = (e) => {
    const out = origEmit(e);
    if (e.type === 'status') statuses.push({ running: e.running, resumable: e.resumable });
    return out;
  };
  runner.prepareModelSession = () => { runner.session = { model: 'test-model' }; };
  runner.browser.overlay = { begin() {}, end: async () => {}, frame: async () => {} };
  runner.browser.closeDisposableTabs = async () => {};
  runner.browser.detachAll = async () => {};
  runner.browser.startOn = async () => {
    const err = new Error('Model request failed (HTTP 503): service overloaded');
    err.status = 503;
    throw err;
  };
  await runner.start('collect prices');
  assert.ok(runner.continuation, 'checkpoint is kept after a provider error');
  assert.equal(runner.continuation.task, 'collect prices');
  assert.equal(statuses.at(-1)?.running, false);
  assert.equal(statuses.at(-1)?.resumable, true, 'final status offers Resume');

  runner.browser.startOn = async () => {
    throw new Error('No active tab found.');
  };
  await runner.start('collect prices');
  assert.equal(runner.continuation, null, 'non-provider error clears checkpoint');
  assert.equal(statuses.at(-1)?.resumable, false);
  runner.dispose();
});

test('debugger onDetach with canceled_by_user stops the running task, ask_user times out, and emit is guarded against disposed runners and broken ports', async () => {
  let detachListener = null;
  const prevAddListener = globalThis.chrome.debugger.onDetach.addListener;
  globalThis.chrome.debugger.onDetach.addListener = (fn) => { detachListener = fn; };
  try {
    const meta = await sessions.createStoredSession('DebuggerCancel');
    const runner = new SessionRunner({
      meta,
      body: await sessions.loadSession(meta.id),
      color: 'cyan',
      isTakenByOther: () => null,
      onSessionsChanged: () => {},
      askUserTimeoutMs: 25,
    });
    assert.ok(detachListener, 'BrowserController registered debugger.onDetach listener');

    // Guarded emit: broken port or disposed runner never throws
    runner.ports.add({ postMessage() { throw new Error('port closed'); } });
    assert.doesNotThrow(() => runner.emit({ type: 'notice', id: 'n1', kind: 'info', level: 'info' }));

    // ask_user timeout
    const askController = new AbortController();
    await assert.rejects(
      runner.askUser('What is the OTP?', askController.signal),
      /Timed out waiting for the user’s answer/,
    );
    assert.equal(runner.pendingQuestion, null);

    // canceled_by_user stops the task
    runner.abort = new AbortController();
    runner.browser.tabId = 42;
    runner.browser.attached.add(42);
    detachListener({ tabId: 42 }, 'canceled_by_user');
    assert.equal(runner.abort.signal.aborted, true, 'debugger cancel stops the running task');

    runner.dispose();
    const lenBefore = runner.transcript.length;
    assert.doesNotThrow(() => runner.emit({ type: 'user', text: 'after dispose' }));
    assert.equal(runner.transcript.length, lenBefore, 'disposed runner ignores emitted events');
  } finally {
    globalThis.chrome.debugger.onDetach.addListener = prevAddListener;
  }
});
