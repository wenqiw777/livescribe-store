const $ = id => document.getElementById(id);
const backendEl = $('backend'), keyEl = $('key'), modelEl = $('model');
const providerEl = $('provider');
const statusEl = $('status');

function syncVisibility() {
  const b = backendEl.value;
  $('nativeBox').style.display = b === 'native' ? '' : 'none';
  $('apiBox').style.display = b === 'api' ? '' : 'none';
}
backendEl.onchange = syncVisibility;

chrome.storage.sync.get(['model', 'backend', 'provider'], (c) => {
  chrome.storage.local.get(['apiKey'], (local) => {
    providerEl.value = c.provider || 'codex';
    backendEl.value = c.backend || (local.apiKey ? 'api' : 'native');
    if (local.apiKey) keyEl.value = local.apiKey;
    if (c.model) modelEl.value = c.model;
    syncVisibility();
  });
});

$('save').onclick = () => {
  chrome.storage.sync.set({
    backend: backendEl.value,
    provider: providerEl.value,
    model: modelEl.value,
  }, () => {
    chrome.storage.local.set({ apiKey: keyEl.value.trim() }, () => {
      statusEl.textContent = 'Saved ✓';
      setTimeout(() => (statusEl.textContent = ''), 1500);
    });
  });
};

$('testNative').onclick = () => {
  const s = $('testNativeStatus');
  s.textContent = 'Testing… (launches host, ~6s)'; s.style.color = '#666';
  try {
    chrome.runtime.sendNativeMessage('com.livescribe.summarizer',
      { prompt: 'Reply with exactly: OK', provider: providerEl.value }, (resp) => {
      if (chrome.runtime.lastError) {
        s.textContent = '✗ ' + chrome.runtime.lastError.message + ' — did you run install.sh with this extension id?';
        s.style.color = '#d00'; return;
      }
      if (resp && resp.error) { s.textContent = '✗ host error: ' + resp.error; s.style.color = '#d00'; return; }
      s.textContent = 'Connected ✓ host replied: ' + JSON.stringify(resp && resp.summary || resp).slice(0, 60);
      s.style.color = '#0a0';
    });
  } catch (e) { s.textContent = '✗ ' + e.message; s.style.color = '#d00'; }
};
