// Only settings and packaged asset locations cross into the page world.
(() => {
  async function publish() {
    const { settings = {} } = await chrome.storage.sync.get('settings');
    window.dispatchEvent(new CustomEvent('sona-audio-config', {
      detail: {
        enabled: settings.noiseSuppression !== false,
        baseUrl: chrome.runtime.getURL('vendor/rnnoise/')
      }
    }));
  }
  window.addEventListener('sona-audio-config-request', () => publish().catch(console.warn));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) publish().catch(console.warn);
  });
  publish().catch(console.warn);
})();
