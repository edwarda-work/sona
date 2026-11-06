const toggle = document.getElementById('noiseSuppression');
const status = document.getElementById('status');

chrome.storage.sync.get('settings', ({ settings = {} }) => {
  toggle.checked = settings.noiseSuppression !== false;
});

toggle.addEventListener('change', async () => {
  try {
    await chrome.storage.sync.set({ settings: { noiseSuppression: toggle.checked } });
    status.textContent = 'Saved';
  } catch (error) {
    status.textContent = `Could not save: ${error.message}`;
  }
});
