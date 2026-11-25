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
