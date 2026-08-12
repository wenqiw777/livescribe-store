const $ = id => document.getElementById(id);
const backendEl = $('backend');
const providerEl = $('provider');
const statusEl = $('status');
const DEFAULT_OPENAI_MODEL = 'gpt-5.6-luna';
let debugCompanionActive = false;

function syncVisibility() {
  const backend = debugCompanionActive ? 'native' : backendEl.value;
  $('nativeBox').style.display = backend === 'native' ? '' : 'none';
  $('anthropicBox').style.display = backend === 'anthropic' ? '' : 'none';
  $('openaiBox').style.display = backend === 'openai' ? '' : 'none';
}
backendEl.onchange = () => {
  debugCompanionActive = false;
  syncVisibility();
};

function activateDebugCompanion(persist = true) {
  debugCompanionActive = true;
  backendEl.value = '';
  syncVisibility();
  if (persist) {
    chrome.storage.sync.set({ backend: 'native', provider: providerEl.value || 'codex' }, () => {
      statusEl.textContent = 'AI Companion enabled ✓';
      setTimeout(() => (statusEl.textContent = ''), 1800);
    });
  }
}

function restoreModel(select, savedModel, fallback) {
  if (savedModel && ![...select.options].some(option => option.value === savedModel)) {
    const legacyOption = document.createElement('option');
    legacyOption.value = savedModel;
    legacyOption.textContent = `${savedModel} (saved)`;
    select.add(legacyOption);
  }
  select.value = savedModel || fallback;
}

$('debugCompanionToggle').onclick = () => activateDebugCompanion(true);

chrome.storage.sync.get(['backend', 'provider', 'model', 'anthropicModel', 'openaiModel'], (settings) => {
  chrome.storage.local.get(['apiKey', 'anthropicApiKey', 'openaiApiKey'], (local) => {
    const savedBackend = settings.backend === 'api' ? 'anthropic' : settings.backend;
    debugCompanionActive = savedBackend === 'native';
    backendEl.value = debugCompanionActive ? '' : (savedBackend || '');
    providerEl.value = settings.provider || 'codex';
    $('anthropicKey').value = local.anthropicApiKey || local.apiKey || '';
    $('openaiKey').value = local.openaiApiKey || '';
    $('anthropicModel').value = settings.anthropicModel || settings.model || 'claude-sonnet-5';
    restoreModel($('openaiModel'), settings.openaiModel, DEFAULT_OPENAI_MODEL);
    syncVisibility();
  });
});

$('save').onclick = () => {
  chrome.storage.sync.set({
    backend: debugCompanionActive ? 'native' : backendEl.value,
    provider: providerEl.value,
    anthropicModel: $('anthropicModel').value,
    openaiModel: $('openaiModel').value || DEFAULT_OPENAI_MODEL,
  }, () => {
    chrome.storage.local.set({
      anthropicApiKey: $('anthropicKey').value.trim(),
      openaiApiKey: $('openaiKey').value.trim(),
    }, () => {
      statusEl.textContent = debugCompanionActive || backendEl.value ? 'Saved ✓' : 'Saved — AI is off';
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
