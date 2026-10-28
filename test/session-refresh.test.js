import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const panel = fs.readFileSync(new URL('../src/sidepanel/panel.js', import.meta.url), 'utf8');
const source = panel.slice(panel.indexOf('async function refreshSessions()'), panel.indexOf('\nfunction sessionLabel('));
function fixture(request) {
  const elements = { sessionListStatus: { hidden: true, textContent: '' }, sessionMenu: { hidden: false } };
  const state = { sessionList: [{ id: 'cached' }], sessionListRefresh: 0, request, $: (id) => elements[id], t: (key) => key, titleRenders: 0, listRenders: 0 };
  state.renderSessionTitle = () => { state.titleRenders++; };
  state.renderSessionList = () => { state.listRenders++; };
  vm.createContext(state);
  vm.runInContext(source, state);
  return { state, elements };
}

test('a failed list read is handled, preserves cached sessions, and offers recovery', async () => {
  const { state, elements } = fixture(async () => { throw new Error('message channel closed'); });
  assert.equal(await state.refreshSessions(), false);
  assert.equal(state.sessionList[0].id, 'cached');
  assert.equal(elements.sessionListStatus.hidden, false);
  assert.equal(elements.sessionListStatus.textContent, 'session.refreshFailed');
  state.request = async () => [{ id: 'recovered' }];
  assert.equal(await state.refreshSessions(), true);
  assert.equal(state.sessionList[0].id, 'recovered');
  assert.equal(elements.sessionListStatus.hidden, true);
  assert.equal(state.titleRenders, 1);
  assert.equal(state.listRenders, 1);
});

test('a late failed list read cannot overwrite a newer successful refresh', async () => {
  let rejectOld;
  const { state, elements } = fixture(() => new Promise((_resolve, reject) => { rejectOld = reject; }));
  const older = state.refreshSessions();
  state.request = async () => [{ id: 'latest' }];
  await state.refreshSessions();
  rejectOld(new Error('old worker gone'));
  assert.equal(await older, false);
  assert.equal(state.sessionList[0].id, 'latest');
  assert.equal(elements.sessionListStatus.hidden, true);
});
