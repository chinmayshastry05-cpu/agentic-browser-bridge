/* popup.js — minimal status + relay URL config for the bridge extension. */
'use strict';

const dot = document.getElementById('dot');
const status = document.getElementById('status');
const wsUrl = document.getElementById('wsUrl');
const errBox = document.getElementById('err');

async function refresh() {
  errBox.textContent = '';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'getStatus' });
    if (!resp.ok) throw new Error(resp.error);
    const s = resp.result;
    dot.classList.toggle('on', s.connected);
    status.textContent = s.connected
      ? `connected since ${s.connectedAt || 'just now'}`
      : `disconnected${s.lastError ? ` (${s.lastError})` : ''} — is the bridge relay running?`;
    if (!wsUrl.value) wsUrl.value = s.wsUrl;
  } catch (err) {
    errBox.textContent = err instanceof Error ? err.message : String(err);
  }
}

document.getElementById('save').addEventListener('click', async () => {
  errBox.textContent = '';
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'setWsUrl', wsUrl: wsUrl.value.trim() });
    if (!resp.ok) throw new Error(resp.error);
    await refresh();
  } catch (err) {
    errBox.textContent = err instanceof Error ? err.message : String(err);
  }
});

void refresh();
setInterval(refresh, 3000);
