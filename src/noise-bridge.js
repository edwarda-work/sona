// Only settings and packaged asset locations cross into the page world.
(() => {
  async function publish() {
    const { settings = {} } = await chrome.storage.sync.get('settings');
    window.dispatchEvent(new CustomEvent('sona-audio-config', {
      detail: {
        enabled: settings.noiseSuppression !== false,
        autoClosePopup: settings.autoClosePopup !== false,
        incomingEnabled: settings.incomingClarity === true,
        baseUrl: chrome.runtime.getURL('vendor/rnnoise/')
      }
    }));
  }
  window.addEventListener('sona-audio-config-request', () => publish().catch(console.warn));
  window.addEventListener('sona-audio-state', ({ detail }) => {
    if (!['off', 'ready', 'starting', 'filtering', 'fallback', 'closed'].includes(detail?.phase)) return;
    void chrome.runtime.sendMessage({ type: 'sona.status', phase: detail.phase }).catch(() => {});
  });
  window.dispatchEvent(new CustomEvent('sona-audio-state-request'));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) publish().catch(console.warn);
  });
  publish().catch(console.warn);
})();
