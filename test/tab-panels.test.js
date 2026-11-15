import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installTabPanels, openTabPanel } from '../src/background/tab-panels.js';

test('toolbar opens only the selected tab, retaining independently enabled tabs', async (t) => {
  const previous = globalThis.chrome;
  const options = new Map();
  const opened = [];
  let click;
  let behavior;
  globalThis.chrome = {
    sidePanel: {
      setOptions: async (value) => options.set(value.tabId ?? 'default', value),
      setPanelBehavior: async (value) => { behavior = value; },
      open: async (value) => opened.push(value),
    },
    action: { onClicked: { addListener: (fn) => { click = fn; } } },
    tabs: { onCreated: { addListener() {} }, query: async () => [] },
  };
  t.after(() => { globalThis.chrome = previous; });
  await installTabPanels();
  assert.deepEqual(options.get('default'), { enabled: false });
  assert.deepEqual(behavior, { openPanelOnActionClick: false });
  click({ id: 10 });
  await new Promise(setImmediate);
  assert.deepEqual(opened, [{ tabId: 10 }]);
  assert.equal(options.has(20), false);
  await openTabPanel(20);
  assert.equal(options.get(10).enabled, true);
  assert.equal(options.get(20).path, 'src/sidepanel/index.html?tabId=20');
  assert.equal(options.get(10).path, 'src/sidepanel/index.html?tabId=10');
  await openTabPanel(undefined);
  assert.equal(opened.length, 2);
});

test('failed tab setup still requests only that tab, never a global panel', async (t) => {
  const previous = globalThis.chrome;
  let opened;
  globalThis.chrome = { sidePanel: { setOptions: async () => { throw new Error('tab closed'); }, open: async (options) => { opened = options; } } };
  t.after(() => { globalThis.chrome = previous; });
  await assert.rejects(openTabPanel(3), /tab closed/);
  assert.deepEqual(opened, { tabId: 3 });
});

test('cold-worker toolbar click calls open before any promise or initialization resolves', async (t) => {
  const previous = globalThis.chrome;
  let click;
  let gesture = false;
  let opened = false;
  globalThis.chrome = {
    sidePanel: {
      setPanelBehavior: () => new Promise(() => {}),
      setOptions: () => new Promise(() => {}),
      open: (options) => { assert.equal(gesture, true); assert.deepEqual(options, { tabId: 42 }); opened = true; return Promise.resolve(); },
    },
    tabs: { query: async () => [], onCreated: { addListener() {} } },
    action: { onClicked: { addListener: (fn) => { click = fn; } } },
  };
  t.after(() => { globalThis.chrome = previous; });
  installTabPanels();
  gesture = true;
  click({ id: 42 });
  gesture = false;
  assert.equal(opened, true);
});
