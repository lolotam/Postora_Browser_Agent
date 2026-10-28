import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { extensionWorker } from './e2e/extension-worker.mjs';

function fixture({ exception = null, sendError = null } = {}) {
  const cdp = new EventEmitter();
  const calls = [];
  cdp.send = async (method, params) => {
    calls.push({ method, params });
    if (method === 'Target.getTargets') return { targetInfos: [
      { type: 'page', url: 'chrome-extension://ext/panel.html', targetId: 'panel' },
      { type: 'service_worker', url: 'chrome-extension://other/worker.js', targetId: 'other' },
      { type: 'service_worker', url: 'chrome-extension://ext/worker.js', targetId: 'current' },
    ] };
    if (method === 'Target.attachToTarget') return { sessionId: 'session' };
    if (method === 'Target.sendMessageToTarget') {
      if (sendError) throw sendError;
      queueMicrotask(() => cdp.emit('Target.receivedMessageFromTarget', {
        sessionId: 'session', message: JSON.stringify({ id: 1, result: exception
          ? { exceptionDetails: { exception: { description: exception } } } : { result: { value: 'evaluated' } } }),
      }));
    }
    return {};
  };
  cdp.detach = async () => { calls.push({ method: 'detach' }); };
  return { cdp, calls, worker: extensionWorker({ newCDPSession: async () => cdp }, {}, 'ext') };
}

test('test instrumentation resolves the current extension target for every evaluation', async () => {
  const { worker, calls, cdp } = fixture();
  assert.equal(await worker.evaluate((value) => value, 'argument'), 'evaluated');
  assert.equal(await worker.evaluate(() => true), 'evaluated');
  assert.equal(calls.filter((call) => call.method === 'Target.getTargets').length, 2);
  assert.ok(calls.filter((call) => call.method === 'Target.attachToTarget').every((call) => call.params.targetId === 'current'));
  const request = JSON.parse(calls.find((call) => call.method === 'Target.sendMessageToTarget').params.message);
  assert.ok(request.params.expression.includes('"argument"'));
  assert.equal(request.params.awaitPromise, true);
  assert.equal(calls.filter((call) => call.method === 'detach').length, 2);
  assert.equal(cdp.listenerCount('Target.receivedMessageFromTarget'), 0);
});

test('instrumentation errors propagate once without replaying an evaluation', async () => {
  for (const options of [{ exception: 'Synthetic runtime rejection' }, { sendError: new Error('Synthetic send rejection') }]) {
    const { worker, calls, cdp } = fixture(options);
    await assert.rejects(worker.evaluate(() => true), /Synthetic/);
    assert.equal(calls.filter((call) => call.method === 'Target.sendMessageToTarget').length, 1);
    assert.equal(calls.filter((call) => call.method === 'Target.detachFromTarget').length, 1);
    assert.equal(cdp.listenerCount('Target.receivedMessageFromTarget'), 0);
    assert.equal(calls.at(-1).method, 'detach');
  }
});
