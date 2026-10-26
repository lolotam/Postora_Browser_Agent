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
