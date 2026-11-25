import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecutor } from '../src/agent/tools.js';
import { runAgent } from '../src/agent/agent.js';
import { BrowserController } from '../src/browser/controller.js';
import { AccessAuthority, ASK_FIRST, FULL_ACCESS, DIALOG, OBSERVE } from '../src/permissions/policy.js';
import { nativeRequest, runNativeCommand } from '../src/native/client.js';

globalThis.chrome = {
  tabs: {
    get: async (id) => ({ id, url: 'https://shop.test/checkout', title: 'Checkout', active: true, status: 'complete' }),
    query: async () => [{ id: 7, url: 'https://shop.test/checkout', title: 'Checkout', active: true, status: 'complete' }],
  },
};

function makeFakeBrowser() {
  const calls = [];
  let openDialog = null;
  let beforeUnloadNote = '';
  const dismissed = [];
  const handled = [];
  let locateGate = null;
  let clickGate = null;
  let url = 'https://shop.test/checkout';
  let docId = 'doc-1';

  const browser = {
    calls,
    dismissed,
    handled,
    overlay: {
      pointTo: async () => {},
      say: async () => {},
    },
    setOpenDialog(dialog) {
      openDialog = dialog;
    },
    setBeforeUnloadNote(note) {
      beforeUnloadNote = note;
    },
    setLocateGate(promise) {
      locateGate = promise;
    },
    setClickGate(promise) {
      clickGate = promise;
    },
    setPage(nextUrl, nextDoc = docId) {
      url = nextUrl;
      docId = nextDoc;
    },
    currentTab: async () => ({ id: 7, url }),
    documentId: async () => docId,
    pendingDialog: () => openDialog,
    takeBeforeUnloadNote: () => {
      const note = beforeUnloadNote;
      beforeUnloadNote = '';
      return note ? ` Dismissed beforeunload dialog ("${note}").` : '';
    },
    dismissPendingDialog: async (tabId, reason) => {
      if (!openDialog) return false;
      dismissed.push({ id: openDialog.id, tabId, reason });
      openDialog = null;
      return true;
    },
    dismissAllDialogs: async (reason) => {
      if (!openDialog) return;
      dismissed.push({ id: openDialog.id, tabId: openDialog.tabId, reason });
      openDialog = null;
    },
    handleDialog: async ({ accept, promptText, dialogId }, { guard, tabId } = {}) => {
      await guard?.();
      if (!openDialog) throw new Error('No JavaScript dialog is open on this tab.');
      if (dialogId && openDialog.id !== dialogId) throw new Error('The open dialog changed before it could be answered.');
      const current = openDialog;
      openDialog = null;
      handled.push({ accept, promptText, dialogId, tabId, type: current.type });
      return current;
    },
    snapshot: async () => ({
      url,
      title: 'Checkout',
      scroll: { y: 0, viewport: 100, height: 100 },
      elements: ['[0] button "Confirm order"'],
      offscreen: 0,
      text: 'Checkout ready.',
    }),
    captureTarget: async ({ kind = 'element', index = 0, tabId = 7 } = {}) => ({
      scope: kind === 'tab' ? 'tab' : 'element',
      kind,
      tabId,
      url,
      documentId: docId,
      element: kind === 'tab' ? null : {
        kind: 'element',
        token: `tok-${index}`,
        index,
        x: 50,
        y: 50,
        tag: 'button',
        editable: false,
        secret: false,
        focused: false,
        body: false,
        label: 'Confirm order',
      },
    }),
    validateTarget: async (target) => ({ ok: true, element: target?.element ?? null }),
    elementFrame: () => null,
    element: async (index, action, _value, { guard } = {}) => {
      await guard?.();
      if (action === 'locate' && locateGate) await locateGate;
      calls.push({ name: 'element', index, action });
      return { x: 50, y: 50, tag: 'button', label: 'Confirm order', secret: false };
    },
    clickAt: async (x, y, { guard, tabId } = {}) => {
      await guard?.();
      calls.push({ name: 'clickAt-dispatched', x, y, tabId });
      if (clickGate) await clickGate;
      calls.push({ name: 'clickAt-finished', x, y, tabId });
      return true;
    },
  };
  return browser;
}

test('a losing handler after timeout has its permit revoked immediately and cannot act later', async () => {
  const browser = makeFakeBrowser();
  let releaseLocate;
  browser.setLocateGate(new Promise((resolve) => { releaseLocate = resolve; }));

  const access = new AccessAuthority({ sessionId: 'timeout-revokes-permit' });
  access.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: access.revision });

  let issuedPermit = null;
  let capturedOp = null;
  const origAuthorize = access.authorize.bind(access);
  access.authorize = async (op, opts) => {
    const res = await origAuthorize(op, opts);
    issuedPermit = res.permit;
    capturedOp = op;
    return res;
  };

  const execute = createToolExecutor(browser, {
    access,
    toolTimeoutMs: 30,
  });

  const result = await execute('click', { index: 0 });
  assert.equal(result.isError, true);
  assert.equal(result.outcome, 'cancelled', 'timed out during locate before mutating clickAt was dispatched');
  assert.match(result.output, /timed out[\s\S]*outcome: cancelled/i);
  assert.ok(issuedPermit, 'a permit was issued before the timeout');
  assert.equal(access.grantValid(issuedPermit, capturedOp), false, 'the permit was revoked as soon as the tool timed out');

  // Now let the slow locate finish; the losing handler must not be able to run clickAt afterwards.
  releaseLocate();
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(browser.calls.filter((c) => c.name.startsWith('clickAt')).length, 0, 'the losing handler never clicked');
});

test('execution timeout starts only after user approval is granted, and an expired approval card is withdrawn', async () => {
  const browser = makeFakeBrowser();
  let pendingRequest = null;
  const settled = [];
  const access = new AccessAuthority({
    sessionId: 'timeout-after-approval',
    onRequest: (req) => { pendingRequest = req; },
    onRequestSettled: (ev) => { settled.push(ev); },
  });

  const execute = createToolExecutor(browser, {
    access,
    toolTimeoutMs: 60,
    approvalTimeoutMs: 500,
  });

  const running = execute('click', { index: 0 });
  // Wait longer than toolTimeoutMs (60ms) while the approval card is still waiting for the user.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(pendingRequest, 'approval was requested');
  assert.equal(access.pendingCount, 1, 'the approval card is still open past toolTimeoutMs');

  // Now the user approves; the click runs within its own 60ms post-approval execution budget.
  access.respondApproval({
    id: pendingRequest.id,
    sessionId: pendingRequest.sessionId,
    revision: pendingRequest.revision,
    decision: 'allow',
  });
  const result = await running;
  assert.equal(result.isError, undefined, result.output);
  assert.equal(browser.calls.filter((c) => c.name === 'clickAt-finished').length, 1);

  // Now verify that an unanswered approval card expires after approvalTimeoutMs and is withdrawn.
  pendingRequest = null;
  const fastExpireExecute = createToolExecutor(browser, {
    access,
    toolTimeoutMs: 200,
    approvalTimeoutMs: 35,
  });
  const expired = await fastExpireExecute('click', { index: 0 });
  assert.equal(expired.isError, true);
  assert.equal(expired.outcome, 'cancelled');
  assert.equal(access.pendingCount, 0, 'the expired approval card was withdrawn');
  assert.equal(settled.at(-1)?.approved, false);
});

test('a timeout after a mutating command reached Chrome or the native host reports outcome: unknown with verification instructions', async () => {
  const browser = makeFakeBrowser();
  let releaseClick;
  browser.setClickGate(new Promise((resolve) => { releaseClick = resolve; }));

  const access = new AccessAuthority({ sessionId: 'unknown-outcome' });
  access.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: access.revision });

  const execute = createToolExecutor(browser, {
    access,
    toolTimeoutMs: 35,
  });

  const result = await execute('click', { index: 0 });
  assert.equal(result.isError, true);
  assert.equal(result.outcome, 'unknown');
  assert.match(result.output, /outcome: unknown/i);
  assert.match(result.output, /Check the page state.*do not repeat it automatically/i);
  releaseClick();
});

test('native client distinguishes cancelled, confirmed stopped, and unknown outcomes on project_write and run_terminal', async () => {
  // 1. Cancelled before dispatch (already aborted signal).
  const preAborted = new AbortController();
  preAborted.abort('timeout');
  await assert.rejects(
    nativeRequest({ type: 'project-write', root: 'C:\\proj', path: 'a.txt', text: 'x', expected_hash: 'new' }, { signal: preAborted.signal }),
    (err) => err.outcome === 'cancelled' && /outcome: cancelled/.test(err.message),
  );

  // 2. Confirmed stopped: host replies { cancelled: true, outcome: 'stopped' } when { type: 'cancel' } is sent.
  const posted = [];
  let replyListener = null;
  const runtimeStopped = {
    connectNative: () => ({
      postMessage: (msg) => {
        posted.push(msg);
        if (msg.type === 'cancel') {
          queueMicrotask(() => replyListener?.({ cancelled: true, outcome: 'stopped' }));
        }
      },
      disconnect: () => {},
      onMessage: { addListener: (fn) => { replyListener = fn; } },
      onDisconnect: { addListener: () => {} },
    }),
  };
  const stopAbort = new AbortController();
  const pendingStopped = nativeRequest(
    { type: 'project-write', root: 'C:\\proj', path: 'a.txt', text: 'x', expected_hash: 'new' },
    { signal: stopAbort.signal, runtime: runtimeStopped, confirmWaitMs: 200 },
  );
  stopAbort.abort('timeout');
  await assert.rejects(
    pendingStopped,
    (err) => err.outcome === 'stopped' && /confirmed the operation was stopped before committing \(outcome: stopped\)/.test(err.message),
  );
  assert.deepEqual(posted.map((m) => m.type), ['project-write', 'cancel']);

  // 3. Unknown outcome: host does not confirm before confirmWaitMs expires on project_write.
  const runtimeUnconfirmed = {
    connectNative: () => ({
      postMessage: () => {},
      disconnect: () => {},
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} },
    }),
  };
  const unknownAbort = new AbortController();
  const pendingUnknown = nativeRequest(
    { type: 'project-write', root: 'C:\\proj', path: 'a.txt', text: 'x', expected_hash: 'new' },
    { signal: unknownAbort.signal, runtime: runtimeUnconfirmed, confirmWaitMs: 25 },
  );
  unknownAbort.abort('timeout');
  await assert.rejects(
    pendingUnknown,
    (err) => err.outcome === 'unknown'
      && /outcome: unknown/.test(err.message)
      && /project_read.*compare its hash/i.test(err.message),
  );

  // 4. Unknown outcome on run_terminal when host kills a running child process and replies outcome: 'unknown'.
  let runListener = null;
  const runtimeKilled = {
    connectNative: () => ({
      postMessage: (msg) => {
        if (msg.type === 'cancel') {
          queueMicrotask(() => runListener?.({ cancelled: true, outcome: 'unknown', exitCode: -1, output: 'partial' }));
        }
      },
      disconnect: () => {},
      onMessage: { addListener: (fn) => { runListener = fn; } },
      onDisconnect: { addListener: () => {} },
    }),
  };
  const cmdAbort = new AbortController();
  const pendingCmd = runNativeCommand(
    { command: 'Start-Sleep 10' },
    { signal: cmdAbort.signal, runtime: runtimeKilled, confirmWaitMs: 200 },
  );
  cmdAbort.abort('timeout');
  await assert.rejects(
    pendingCmd,
    (err) => err.outcome === 'unknown' && /outcome: unknown/.test(err.message),
  );
});

test('a dialog-pending result ends the rest of the tool batch with "Not executed: a dialog is open."', async () => {
  const browser = makeFakeBrowser();
  const access = new AccessAuthority({ sessionId: 'dialog-batch' });
  access.setMode(FULL_ACCESS, { trusted: true, acknowledged: true, expectedRevision: access.revision });

  // Clicking [0] opens a confirm dialog on the page.
  const origClickAt = browser.clickAt;
  browser.clickAt = async (x, y, opts) => {
    await origClickAt(x, y, opts);
    browser.setOpenDialog({
      id: 'dlg-1',
      tabId: 7,
      type: 'confirm',
      message: 'Delete this record?',
      url: 'https://shop.test/checkout',
      defaultPrompt: '',
    });
  };

  const execute = createToolExecutor(browser, { access });
  const toolResults = [];
  let turnCount = 0;
  const session = {
    model: 'test-model',
    addUserMessage: () => {},
    addToolResult: (id, output) => { toolResults.push({ id, output }); },
    next: async () => {
      turnCount += 1;
      if (turnCount === 1) {
        return {
          text: '',
          toolCalls: [
            { id: 'c1', name: 'click', args: { index: 0 } },
            { id: 'c2', name: 'click', args: { index: 0 } },
            { id: 'c3', name: 'done', args: { report: 'Premature done', success: true } },
          ],
        };
      }
      if (turnCount === 2) {
        return {
          text: '',
          toolCalls: [
            { id: 'c4', name: 'dialog', args: { accept: false } },
          ],
        };
      }
      return {
        text: '',
        toolCalls: [
          { id: 'c5', name: 'done', args: { report: 'Dialog handled cleanly', success: true } },
        ],
      };
    },
  };

  const events = [];
  await runAgent({
    session,
    execute,
    task: 'Click and handle the dialog',
    maxSteps: 5,
    signal: new AbortController().signal,
    emit: (ev) => events.push(ev),
  });

  assert.equal(toolResults.length, 5);
  assert.match(toolResults[0].output, /status: dialog-pending[\s\S]*Delete this record\?/);
  assert.equal(toolResults[1].output, 'Not executed: a dialog is open.');
  assert.equal(toolResults[2].output, 'Not executed: a dialog is open.');
  assert.match(toolResults[3].output, /Dismissed confirm dialog/);
  assert.equal(events.find((e) => e.type === 'final')?.report, 'Dialog handled cleanly');
});

test('in Ask first, dismissing a dialog or closing an alert needs no approval, while accepting confirm or answering prompt needs a fresh approval bound to that dialog', async () => {
  const browser = makeFakeBrowser();
  const requests = [];
  let autoDecision = 'allow';
  const access = new AccessAuthority({
    sessionId: 'dialog-permissions',
    onRequest: (req) => {
      requests.push(req);
      if (autoDecision) {
        access.respondApproval({
          id: req.id,
          sessionId: req.sessionId,
          revision: req.revision,
          decision: autoDecision,
        });
      }
    },
  });
  assert.equal(access.mode, ASK_FIRST);

  const execute = createToolExecutor(browser, { access });

  // 1. Dismissing a confirm dialog in Ask first asks no question at all.
  browser.setOpenDialog({
    id: 'dlg-confirm-dismiss',
    tabId: 7,
    type: 'confirm',
    message: 'Leave without saving?',
    url: 'https://shop.test/checkout',
  });
  const dismissed = await execute('dialog', { accept: false });
  assert.equal(dismissed.isError, undefined, dismissed.output);
  assert.equal(requests.length, 0, 'dismissing a dialog never requires user approval');
  assert.equal(browser.handled.at(-1)?.accept, false);

  // 2. Closing an alert dialog in Ask first asks no question even with accept: true.
  browser.setOpenDialog({
    id: 'dlg-alert-ok',
    tabId: 7,
    type: 'alert',
    message: 'Session saved.',
    url: 'https://shop.test/checkout',
  });
  const alertClosed = await execute('dialog', { accept: true });
  assert.equal(alertClosed.isError, undefined, alertClosed.output);
  assert.equal(requests.length, 0, 'closing an alert requires no approval');

  // 3. Accepting a confirm dialog in Ask first requires a fresh approval bound to that dialog.
  browser.setOpenDialog({
    id: 'dlg-confirm-accept',
    tabId: 7,
    type: 'confirm',
    message: 'Confirm purchase?',
    url: 'https://shop.test/checkout',
  });
  const accepted = await execute('dialog', { accept: true });
  assert.equal(accepted.isError, undefined, accepted.output);
  assert.equal(requests.length, 1, 'accepting a confirm dialog asked for a fresh approval');
  assert.equal(requests[0].action, 'dialog');
  assert.equal(requests[0].kind, DIALOG);
  assert.equal(requests[0].target.dialogId, 'dlg-confirm-accept');
  assert.equal(requests[0].target.dialogType, 'confirm');
  assert.equal(requests[0].target.message, 'Confirm purchase?');

  // 4. Answering a prompt dialog in Ask first requires a fresh approval bound to the prompt and text.
  browser.setOpenDialog({
    id: 'dlg-prompt-answer',
    tabId: 7,
    type: 'prompt',
    message: 'Enter discount code:',
    url: 'https://shop.test/checkout',
  });
  const answered = await execute('dialog', { accept: true, prompt_text: 'SAVE20' });
  assert.equal(answered.isError, undefined, answered.output);
  assert.equal(requests.length, 2, 'answering a prompt dialog asked for a fresh approval');
  assert.equal(requests[1].kind, DIALOG);
  assert.deepEqual(requests[1].args, { accept: true, prompt_text: 'SAVE20' });
  assert.equal(requests[1].target.dialogId, 'dlg-prompt-answer');
  assert.equal(browser.handled.at(-1)?.promptText, 'SAVE20');

  // 5. If the dialog changes while the approval card is open, the approval for the old dialog is refused.
  autoDecision = null;
  browser.setOpenDialog({
    id: 'dlg-first',
    tabId: 7,
    type: 'confirm',
    message: 'First confirm?',
    url: 'https://shop.test/checkout',
  });
  const swappedPromise = execute('dialog', { accept: true });
  await new Promise((resolve) => setTimeout(resolve, 15));
  const pendingReq = requests.at(-1);
  assert.equal(pendingReq.target.dialogId, 'dlg-first');
  // Replace the open dialog with a different one before the user clicks Allow.
  browser.setOpenDialog({
    id: 'dlg-second',
    tabId: 7,
    type: 'confirm',
    message: 'Second confirm?',
    url: 'https://shop.test/checkout',
  });
  access.respondApproval({
    id: pendingReq.id,
    sessionId: pendingReq.sessionId,
    revision: pendingReq.revision,
    decision: 'allow',
  });
  const swappedResult = await swappedPromise;
  assert.equal(swappedResult.isError, true);
  assert.match(swappedResult.output, /no longer open|changed/i);
});

test('BrowserController tracks CDP dialogs with an independent deadline, dismisses beforeunload, and dismisses open dialogs on deadline or stop', async () => {
  const debuggerListeners = [];
  const sentCommands = [];
  const prevChrome = globalThis.chrome;
  globalThis.chrome = {
    debugger: {
      onDetach: { addListener() {} },
      onEvent: { addListener: (fn) => debuggerListeners.push(fn) },
      attach: async () => {},
      detach: async () => {},
      sendCommand: async ({ tabId }, method, params) => {
        sentCommands.push({ tabId, method, params });
        return {};
      },
    },
    tabs: {
      onRemoved: { addListener() {} },
      get: async (id) => ({ id, url: 'https://shop.test/checkout', active: true, status: 'complete' }),
      query: async () => [{ id: 7, url: 'https://shop.test/checkout', active: true, status: 'complete' }],
      group: async () => 1,
    },
    tabGroups: { update: async () => {} },
    scripting: {
      executeScript: async () => [{ result: { readyState: 'complete' } }],
    },
  };

  try {
    const controller = new BrowserController({ dialogDeadlineMs: 45 });
    await controller.startOn(7);

    // 1. beforeunload is dismissed automatically and its message is recorded for the model after confirmation.
    for (const fn of debuggerListeners) {
      fn({ tabId: 7 }, 'Page.javascriptDialogOpening', {
        type: 'beforeunload',
        message: 'Changes you made may not be saved.',
        url: 'https://shop.test/checkout',
      });
    }
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(controller.pendingDialog(7), null, 'beforeunload does not stay open');
    assert.ok(sentCommands.some((c) => c.method === 'Page.handleJavaScriptDialog' && c.params.accept === true));
    assert.match(controller.takeBeforeUnloadNote(7), /Changes you made may not be saved/);

    // 2. An alert/confirm/prompt dialog has its own deadline and is dismissed when the deadline expires.
    sentCommands.length = 0;
    for (const fn of debuggerListeners) {
      fn({ tabId: 7 }, 'Page.javascriptDialogOpening', {
        type: 'confirm',
        message: 'Are you sure?',
        url: 'https://shop.test/checkout',
      });
    }
    assert.equal(controller.pendingDialog(7)?.type, 'confirm');
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(controller.pendingDialog(7), null, 'expired dialog was cleared');
    assert.ok(
      sentCommands.some((c) => c.method === 'Page.handleJavaScriptDialog' && c.params.accept === false),
      'expired dialog was dismissed with accept: false',
    );
  } finally {
    globalThis.chrome = prevChrome;
  }
});
