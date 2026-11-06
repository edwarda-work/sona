// Keep status per tab and frame so embedded call pages are represented accurately.
const prefix = 'sona.status.';
const phases = new Set(['off', 'ready', 'starting', 'filtering', 'fallback']);

async function clearTab(tabId) {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter(key => key.startsWith(`${prefix}${tabId}.`));
  if (keys.length) await chrome.storage.session.remove(keys);
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== 'sona.status' || !Number.isInteger(sender.tab?.id)) return;
  const key = `${prefix}${sender.tab.id}.${sender.frameId ?? 0}`;
  if (message.phase === 'closed') {
    void chrome.storage.session.remove(key);
  } else if (phases.has(message.phase)) {
    void chrome.storage.session.set({ [key]: message.phase });
  }
});

chrome.tabs.onRemoved.addListener(tabId => { void clearTab(tabId); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading') void clearTab(tabId);
});
