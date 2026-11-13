const toggle = document.getElementById('noiseSuppression');
const autoCloseToggle = document.getElementById('autoClosePopup');
const incomingToggle = document.getElementById('incomingClarity');
const status = document.getElementById('status');
const prefix = 'sona.status.';
const labels = {
  off: 'Off',
  ready: 'Ready for a call or meeting',
  starting: 'Starting microphone filter…',
  filtering: 'Filtering your microphone',
  fallback: 'Using original microphone — filtering stopped'
};

async function refreshStatus() {
  if (!toggle.checked) {
    status.textContent = labels.off;
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');
    const stored = await chrome.storage.session.get(null);
    const phases = Object.entries(stored)
      .filter(([key]) => key.startsWith(`${prefix}${tab.id}.`))
      .map(([, phase]) => phase);
    const phase = ['fallback', 'filtering', 'starting', 'ready'].find(item => phases.includes(item));
    status.textContent = phase ? labels[phase] : 'Open a supported call or meeting tab';
  } catch (_error) {
    status.textContent = 'Status unavailable — reload the call tab';
  }
}

chrome.storage.sync.get('settings', ({ settings = {} }) => {
  toggle.checked = settings.noiseSuppression !== false;
  if (autoCloseToggle) autoCloseToggle.checked = settings.autoClosePopup !== false;
  if (incomingToggle) incomingToggle.checked = settings.incomingClarity === true;
  void refreshStatus();
});

async function saveSettings() {
  await chrome.storage.sync.set({
    settings: {
      noiseSuppression: toggle.checked,
      autoClosePopup: autoCloseToggle ? autoCloseToggle.checked : true,
      incomingClarity: incomingToggle ? incomingToggle.checked : false
    }
  });
}

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  status.textContent = enabled ? labels.starting : labels.off;
  try {
    await saveSettings();
    await refreshStatus();
  } catch (error) {
    toggle.checked = !enabled;
    status.textContent = `Could not save setting: ${error.message}`;
  }
});

for (const extra of [autoCloseToggle, incomingToggle]) {
  extra?.addEventListener('change', async () => {
    const enabled = extra.checked;
    try {
      await saveSettings();
    } catch (error) {
      extra.checked = !enabled;
      status.textContent = `Could not save setting: ${error.message}`;
    }
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && Object.keys(changes).some(key => key.startsWith(prefix))) {
    void refreshStatus();
  }
  if (area === 'sync' && changes.settings) {
    toggle.checked = changes.settings.newValue?.noiseSuppression !== false;
    if (autoCloseToggle) autoCloseToggle.checked = changes.settings.newValue?.autoClosePopup !== false;
    if (incomingToggle) incomingToggle.checked = changes.settings.newValue?.incomingClarity === true;
    void refreshStatus();
  }
});
