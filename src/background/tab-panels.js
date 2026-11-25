// No global panel: a toolbar click opts only that tab into its own instance.
// Chrome retains each tab-specific panel while the user visits other tabs.
export function openTabPanel(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) return Promise.resolve();
  // Keep both API calls in the gesture's synchronous stack. Awaiting options
  // (or worker initialization) can lose Chrome's toolbar user activation.
  const configured = configureTab(tabId);
  const opened = chrome.sidePanel.open({ tabId });
  return Promise.all([configured, opened]);
}

function configureTab(tabId) {
  return chrome.sidePanel.setOptions({ tabId, path: `src/sidepanel/index.html?tabId=${tabId}`, enabled: true });
}

export function installTabPanels() {
  const ready = Promise.all([
    chrome.sidePanel.setOptions({ enabled: false }),
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }),
  ]);
  // Enabling a tab-specific entry does not open it. Prepare existing/new tabs
  // ahead of clicks so older Chrome versions already know the requested path.
  const prepare = (tab) => {
    if (Number.isInteger(tab.id)) configureTab(tab.id).catch(() => {});
  };
  chrome.tabs.onCreated.addListener(prepare);
  chrome.tabs.query({}).then((tabs) => tabs.forEach(prepare)).catch(() => {});
  chrome.action.onClicked.addListener((tab) => {
    openTabPanel(tab.id).catch(() => console.warn('Could not open the tab panel.'));
  });
  return ready;
}
