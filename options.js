const $ = id => document.getElementById(id);
const backendEl = $('backend');
const providerEl = $('provider');
const statusEl = $('status');

function syncVisibility() {
  const backend = backendEl.value;
  $('nativeBox').style.display = backend === 'native' ? '' : 'none';
  $('anthropicBox').style.display = backend === 'anthropic' ? '' : 'none';
  $('openaiBox').style.display = backend === 'openai' ? '' : 'none';
}
backendEl.onchange = syncVisibility;

chrome.storage.sync.get(['backend', 'provider', 'model', 'anthropicModel', 'openaiModel'], (settings) => {
  chrome.storage.local.get(['apiKey', 'anthropicApiKey', 'openaiApiKey'], (local) => {
    const savedBackend = settings.backend === 'api' ? 'anthropic' : settings.backend;
    backendEl.value = savedBackend || '';
    providerEl.value = settings.provider || 'codex';
    $('anthropicKey').value = local.anthropicApiKey || local.apiKey || '';
    $('openaiKey').value = local.openaiApiKey || '';
    $('anthropicModel').value = settings.anthropicModel || settings.model || 'claude-sonnet-5';
    $('openaiModel').value = settings.openaiModel || 'gpt-5';
    syncVisibility();
  });
});

$('save').onclick = () => {
  chrome.storage.sync.set({
    backend: backendEl.value,
    provider: providerEl.value,
    anthropicModel: $('anthropicModel').value,
    openaiModel: $('openaiModel').value.trim() || 'gpt-5',
  }, () => {
    chrome.storage.local.set({
      anthropicApiKey: $('anthropicKey').value.trim(),
      openaiApiKey: $('openaiKey').value.trim(),
    }, () => {
      statusEl.textContent = backendEl.value ? 'Saved ✓' : 'Saved — AI is off';
      setTimeout(() => (statusEl.textContent = ''), 1800);
    });
  });
};

$('testNative').onclick = () => {
  const status = $('testNativeStatus');
  status.textContent = 'Testing…'; status.style.color = '#666';
  chrome.runtime.sendMessage({ type: 'AI_STATUS', probeNative: true }, (result) => {
    if (chrome.runtime.lastError) {
      status.textContent = '✗ ' + chrome.runtime.lastError.message; status.style.color = '#d00'; return;
    }
    if (!result || !result.ready) {
      status.textContent = '✗ ' + ((result && result.reason) || 'Companion not found. Install it, then reload Chrome.');
      status.style.color = '#d00'; return;
    }
    status.textContent = 'Connected ✓'; status.style.color = '#0a0';
  });
};
