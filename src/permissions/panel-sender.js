// Accept only our panel page, with the single optional owner parameter emitted
// by tab-panels.js. Never trust a URL merely because it starts with this path.
export function isSidePanelSender(sender, runtime = globalThis.chrome?.runtime) {
  if (!runtime?.id || !sender || sender.id !== runtime.id) return false;
  const base = runtime.getURL('src/sidepanel/index.html');
  if (sender.url === base) return true;
  if (typeof sender.url !== 'string' || !sender.url.startsWith(`${base}?tabId=`)) return false;
  const id = sender.url.slice(`${base}?tabId=`.length);
  return /^(0|[1-9]\d*)$/.test(id) && Number.isSafeInteger(Number(id));
}

// The microphone window this extension opens: our own mic page, never a web
// page or a content script, which could otherwise speak for the user.
export function isMicWindowSender(sender, runtime = globalThis.chrome?.runtime) {
  if (!runtime?.id || !sender || sender.id !== runtime.id) return false;
  const base = runtime.getURL('src/sidepanel/mic.html');
  return typeof sender.url === 'string' && (sender.url === base || sender.url.startsWith(`${base}?`));
}

// The extension's own service worker: a message with no tab, from the worker
// script. A content script always has a tab and a web page's URL.
export function isWorkerSender(sender, runtime = globalThis.chrome?.runtime) {
  if (!runtime?.id || !sender || sender.id !== runtime.id || sender.tab) return false;
  return sender.url === runtime.getURL('src/background/service-worker.js');
}
