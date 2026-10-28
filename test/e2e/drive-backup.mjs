// Real button -> worker -> Drive transport, with synthetic account/token/HTTP.
import assert from 'node:assert/strict';
import path from 'node:path';
import { extensionWorker } from './extension-worker.mjs';

export async function runDriveBackupScenario(context, extensionId) {
  const panel = await context.newPage();
  const errors = [];
  panel.on('pageerror', (error) => errors.push(error.message));
  let worker;
  let previous;
  try {
    await panel.goto(`chrome-extension://${extensionId}/src/sidepanel/index.html`);
    previous = await panel.evaluate(() => chrome.storage.local.get(['settings', 'googleAccount', 'driveBackup']));
    worker = extensionWorker(context, panel, extensionId);
    await worker.evaluate(() => {
      globalThis.__driveOriginalFetch = globalThis.fetch;
      globalThis.__driveOriginalAuthorize = chrome.identity.launchWebAuthFlow;
      globalThis.__driveTest = { writes: 0, denied: false };
      chrome.identity.launchWebAuthFlow = async () => { throw new Error('Synthetic Google session expired'); };
      globalThis.fetch = async (input, init = {}) => {
        const url = String(input);
        if (!url.startsWith('https://www.googleapis.com/')) return globalThis.__driveOriginalFetch(input, init);
        if (new Headers(init.headers).get('Authorization') !== 'Bearer SYNTHETIC-DRIVE-TOKEN') throw new Error('Wrong Drive credential');
        if (globalThis.__driveTest.denied) return Response.json({ error: { message: 'Synthetic permission denied' } }, { status: 403 });
        if (init.method === 'PATCH') { globalThis.__driveTest.writes++; return Response.json({ id: 'synthetic-drive-file' }); }
        return Response.json({ files: [{ id: 'synthetic-drive-file' }] });
      };
    });
    await panel.evaluate(async () => {
      await chrome.storage.session.set({ googleToken: { accessToken: 'SYNTHETIC-DRIVE-TOKEN', expiresAt: Date.now() + 3600000 } });
      await chrome.storage.local.set({ googleAccount: { name: 'Synthetic Account', email: 'drive@example.test', picture: '' } });
      await chrome.storage.local.remove('driveBackup');
      const response = await chrome.runtime.sendMessage({ type: 'drive-backup-now' });
      if (response.error || response.result.error) throw new Error('Initial synthetic backup failed');
    });
    const first = await worker.evaluate(() => globalThis.__driveTest.writes);
    assert.equal(first, 1);
    for (const language of ['en', 'ar']) {
      await panel.evaluate(async (language) => {
        const { settings } = await chrome.storage.local.get('settings');
        await chrome.storage.local.set({ settings: { ...settings, uiLanguage: language } });
      }, language);
      await panel.reload();
      await panel.bringToFront();
      await panel.waitForFunction(() => document.getElementById('modelQuickLabel').textContent);
      // Language itself is backed up: establish this language's current hash
      // before checking that the next unchanged button click still writes.
      await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'drive-backup-now' }));
      await panel.click('#overflowBtn');
      await panel.click('#accountBtn');
      await panel.waitForSelector('#driveBackupBtn', { state: 'visible' });
      const before = await panel.evaluate(async () => {
        const { driveBackup } = await chrome.storage.local.get('driveBackup');
        await chrome.storage.local.set({ driveBackup: { ...driveBackup, at: 1 } });
        return driveBackup;
      });
      const count = await worker.evaluate(() => globalThis.__driveTest.writes);
      await panel.click('#driveBackupBtn');
      await panel.waitForSelector('#accountStatus[data-tone="success"]');
      assert.match(await panel.textContent('#accountStatus'), /^✓ /);
      assert.equal(await worker.evaluate(() => globalThis.__driveTest.writes), count + 1, 'unchanged manual click must PATCH');
      const saved = await panel.evaluate(async () => (await chrome.storage.local.get('driveBackup')).driveBackup);
      assert.equal(saved.hash, before.hash);
      assert.ok(saved.at > 1);
      for (const theme of ['light', 'dark']) {
        await panel.emulateMedia({ colorScheme: theme });
        await panel.setViewportSize({ width: 320, height: 480 });
        const style = await panel.locator('#accountStatus').evaluate((node) => {
          const probe = document.createElement('span'); probe.style.color = 'var(--success)'; document.body.append(probe);
          const expected = getComputedStyle(probe).color; probe.remove();
          return { color: getComputedStyle(node).color, expected };
        });
        assert.equal(style.color, style.expected);
        if (process.env.E2E_SCREENSHOTS) await panel.screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, `drive-success-${language}-${theme}.png`) });
      }
      await worker.evaluate(() => { globalThis.__driveTest.denied = true; });
      await panel.click('#driveBackupBtn');
      await panel.waitForSelector('#accountStatus[data-tone="error"]');
      assert.equal(await panel.textContent('#accountStatus'), '✗ Google Drive: Synthetic permission denied');
      const failed = await panel.evaluate(async () => (await chrome.storage.local.get('driveBackup')).driveBackup);
      assert.equal(failed.at, saved.at);
      assert.match(failed.error, /permission denied/);
      if (process.env.E2E_SCREENSHOTS) await panel.screenshot({ path: path.join(process.env.E2E_SCREENSHOTS, `drive-error-${language}.png`) });
      await worker.evaluate(() => { globalThis.__driveTest.denied = false; });
      await panel.click('#driveBackupBtn');
      await panel.waitForSelector('#accountStatus[data-tone="success"]');
    }
    await panel.evaluate(() => chrome.storage.session.remove('googleToken'));
    const writes = await worker.evaluate(() => globalThis.__driveTest.writes);
    await panel.click('#driveBackupBtn');
    await panel.waitForSelector('#accountStatus[data-tone="error"]');
    assert.match(await panel.textContent('#accountStatus'), /✗ Google needs you to sign in again.*Synthetic Google session expired/);
    assert.equal(await worker.evaluate(() => globalThis.__driveTest.writes), writes);
    assert.deepEqual(errors, []);
    console.log('\n== scenario: drive-backup ==\nmanual unchanged backups uploaded; timestamped success, permission/session errors and recovery behaved (synthetic Drive)');
    return [];
  } catch (error) {
    return [`Drive backup: ${error.stack ?? error.message}`];
  } finally {
    await panel.evaluate(async (previous) => {
      await chrome.storage.local.remove('googleAccount');
      await chrome.storage.session.remove('googleToken');
      await chrome.storage.local.remove(['driveBackup', 'settings']);
      if (previous) await chrome.storage.local.set(previous);
    }, previous).catch(() => {});
    await worker?.evaluate(() => {
      if (globalThis.__driveOriginalFetch) globalThis.fetch = globalThis.__driveOriginalFetch;
      if (globalThis.__driveOriginalAuthorize) chrome.identity.launchWebAuthFlow = globalThis.__driveOriginalAuthorize;
      delete globalThis.__driveTest;
      delete globalThis.__driveOriginalFetch;
      delete globalThis.__driveOriginalAuthorize;
    }).catch(() => {});
    await panel.close();
  }
}
