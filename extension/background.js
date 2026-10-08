/**
 * background.js — MV3 service worker for the Agentic Browser Bridge extension.
 *
 * Opens a WebSocket *client* to the bridge relay at ws://127.0.0.1:<port>/extension
 * (loopback only — the port is configurable via the popup, default 8932).
 * Incoming {id, op, params} frames are executed with the extension APIs and
 * answered with {id, ok, result|error}.
 *
 * Tab-level ops run here (chrome.tabs); page-level ops are forwarded to the
 * content script in the target tab.
 */
'use strict';

const DEFAULT_WS_URL = 'ws://127.0.0.1:8932/extension';
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;
const OP_TIMEOUT_MS = 20000;

let ws = null;
let wsUrl = DEFAULT_WS_URL;
// Guard against concurrent connect() calls racing through the async config
// read: connect() awaits chrome.storage, so two overlapping calls would both
// pass the readyState check and open duplicate sockets (the relay drops the
// older peer, killing in-flight ops). The flag is set synchronously.
let connectPending = false;
let reconnectDelay = RECONNECT_BASE_MS;
let lastError = null;
let connectedAt = null;

/**
 * Navigation-readiness handshake: tab ids whose content script has announced
 * itself via {type: 'abb-ready'}. Readiness is invalidated SYNCHRONOUSLY in
 * the goto/reload/goBack/goForward ops before the chrome.tabs call (the
 * tabs.onUpdated 'loading' event below is async and would leave a race
 * window, notably on same-URL navigations); the onUpdated listener remains
 * as a backstop for page-initiated navigations. The content script
 * re-announces on every new page load.
 */
const readyTabs = new Set();

async function waitReady(tabId, timeoutMs = 15000) {
  const id = Number(tabId);
  const timeout = Math.min(Math.max(Number(timeoutMs) || 15000, 0), 120000);
  const start = Date.now();
  while (!readyTabs.has(id)) {
    if (Date.now() - start >= timeout) {
      throw new Error(
        `content script not ready in tab ${id} after ${timeout}ms — the tab may be a chrome://, about:, or extension page where content scripts cannot run`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ready: true, tabId: id };
}

const PAGE_OPS = new Set([
  'snapshot', 'click', 'dblclick', 'type', 'clear', 'pressKey', 'hover', 'focus',
  'scrollIntoView', 'scrollBy', 'selectOption', 'setChecked', 'waitForSelector',
  'pageText', 'pageInfo', 'viewportSize', 'listFrames', 'describeTarget', 'elementFromPoint',
  'hitTest',
]);

async function getWsUrl() {
  const { wsUrl: saved } = await chrome.storage.local.get('wsUrl');
  return saved || DEFAULT_WS_URL;
}

async function getPairingToken() {
  const { pairingToken: saved } = await chrome.storage.local.get('pairingToken');
  return String(saved || '');
}

/** Base relay URL + pairing token (sent as ?token=; the relay rejects unpaired sockets). */
async function getConnInfo() {
  const base = await getWsUrl();
  const token = await getPairingToken();
  return { base, token, url: token ? `${base}?token=${encodeURIComponent(token)}` : base };
}

function tabInfo(tab) {
  return { id: String(tab.id), url: tab.url || '', title: tab.title || '', active: !!tab.active };
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0] || (await chrome.tabs.query({})).find((t) => t.active) || (await chrome.tabs.query({}))[0];
  if (!tab) throw new Error('no tabs available');
  return tab;
}

async function tabById(id) {
  const tab = await chrome.tabs.get(Number(id)).catch(() => null);
  if (!tab) throw new Error(`unknown tab "${id}"`);
  return tab;
}

function sendToTab(tabId, op, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`content script op "${op}" timed out`)), OP_TIMEOUT_MS);
    chrome.tabs.sendMessage(Number(tabId), { op, params }, (resp) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) {
        reject(new Error(`content script unreachable: ${chrome.runtime.lastError.message}`));
        return;
      }
      if (!resp) { reject(new Error('empty response from content script')); return; }
      if (resp.ok) resolve(resp.result);
      else reject(new Error(resp.error || 'content op failed'));
    });
  });
}

async function pageOp(tabId, op, params) {
  // chrome:// and extension pages reject content scripts — surface clearly.
  try {
    return await sendToTab(tabId, op, params);
  } catch (err) {
    throw new Error(`${err.message} (tab may be a chrome:// page where scripting is blocked)`);
  }
}

const tabOps = {
  async ping() { return { version: chrome.runtime.getManifest().version }; },
  async waitReady({ tabId, timeoutMs }) { return waitReady(tabId, timeoutMs); },
  async listTabs() {
    return (await chrome.tabs.query({})).filter((t) => t.id !== undefined).map(tabInfo);
  },
  async activeTab() { return tabInfo(await activeTab()); },
  async openTab({ url }) {
    const tab = await chrome.tabs.create({ url: url || 'about:blank', active: true });
    if (url) await waitReady(tab.id);
    return tabInfo(tab);
  },
  async switchTab({ tabId }) {
    const tab = await tabById(tabId);
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
    return tabInfo(await chrome.tabs.get(tab.id));
  },
  async closeTab({ tabId }) {
    const tabs = await chrome.tabs.query({});
    if (tabs.length <= 1) throw new Error('refusing to close the last tab');
    await chrome.tabs.remove(Number(tabId));
    return { closed: String(tabId) };
  },
  async goto({ url, tabId }) {
    const tab = tabId ? await tabById(tabId) : await activeTab();
    // Invalidate SYNCHRONOUSLY before tabs.update: the tabs.onUpdated
    // 'loading' event below is delivered asynchronously, so relying on it
    // alone leaves a window where the stale readyTabs entry lets waitReady
    // resolve before the new content script loads — reproduced on
    // navigate-to-the-same-URL, where update() resolves almost immediately.
    readyTabs.delete(tab.id);
    await chrome.tabs.update(tab.id, { url });
    // tabs.update resolves before the content script is injected — wait for
    // its readiness announcement so the next page op (pageInfo/snapshot)
    // cannot race into "content script unreachable".
    await waitReady(tab.id);
    return { navigated: url, tabId: tab.id };
  },
  async goBack({ tabId }) {
    const tab = tabId ? await tabById(tabId) : await activeTab();
    readyTabs.delete(tab.id);
    await chrome.tabs.goBack(tab.id).catch(() => { throw new Error('no back history'); });
    return {};
  },
  async goForward({ tabId }) {
    const tab = tabId ? await tabById(tabId) : await activeTab();
    readyTabs.delete(tab.id);
    await chrome.tabs.goForward(tab.id).catch(() => { throw new Error('no forward history'); });
    return {};
  },
  async reload({ tabId }) {
    const tab = tabId ? await tabById(tabId) : await activeTab();
    // Same synchronous invalidation as goto: reload() resolves before the
    // fresh content script announces, and the onUpdated event lags behind.
    readyTabs.delete(tab.id);
    await chrome.tabs.reload(tab.id);
    await waitReady(tab.id);
    return {};
  },
  async screenshot({ tabId } = {}) {
    const tab = tabId ? await tabById(tabId) : await activeTab();
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { dataUrl };
  },
};

async function handleOp(op, params) {
  if (op in tabOps) return tabOps[op](params || {});
  if (PAGE_OPS.has(op)) {
    const p = params || {};
    const tab = p.tabId ? await tabById(p.tabId) : await activeTab();
    return pageOp(tab.id, op, p);
  }
  throw new Error(`unknown extension op "${op}"`);
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (connectPending) return;
  connectPending = true;
  lastError = null;
  let socket;
  try {
    // Read fresh config every attempt: the pairing token may have been saved
    // via the popup after a previous unauthenticated attempt.
    const info = await getConnInfo();
    // Re-check after the await: another connect path may have won the race.
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    wsUrl = info.base;
    try {
      socket = new WebSocket(info.url);
    } catch (err) {
      lastError = String(err && err.message || err);
      scheduleReconnect();
      return;
    }
    ws = socket;
  } finally {
    connectPending = false;
  }
  socket.onopen = () => {
    connectedAt = new Date().toISOString();
    reconnectDelay = RECONNECT_BASE_MS;
    lastError = null;
    socket.send(JSON.stringify({ type: 'hello', version: chrome.runtime.getManifest().version }));
  };
  socket.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (typeof msg.id === 'undefined' || typeof msg.op !== 'string') return;
    try {
      const result = await handleOp(msg.op, msg.params);
      socket.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (err) {
      socket.send(JSON.stringify({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
  };
  socket.onclose = () => {
    if (ws === socket) ws = null;
    connectedAt = null;
    scheduleReconnect();
  };
  socket.onerror = () => { lastError = 'websocket error'; };
}

function scheduleReconnect() {
  setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectDelay);
}

// Popup + options messaging, and the content-script readiness handshake.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'abb-ready') {
      const tabId = sender.tab?.id;
      if (typeof tabId === 'number') readyTabs.add(tabId);
      return { ready: true, tabId: tabId ?? null };
    }
    if (msg.type === 'getStatus') {
      return {
        connected: !!ws && ws.readyState === WebSocket.OPEN,
        wsUrl, connectedAt, lastError,
        pairingSet: !!(await getPairingToken()),
      };
    }
    if (msg.type === 'setWsUrl') {
      const url = String(msg.wsUrl || '').trim();
      if (!/^ws:\/\/127\.0\.0\.1(:\d+)?\/extension$/.test(url) && !/^ws:\/\/localhost(:\d+)?\/extension$/.test(url)) {
        throw new Error('only loopback ws:// URLs to /extension are allowed');
      }
      await chrome.storage.local.set({ wsUrl: url });
      wsUrl = url;
      if (ws) ws.close();
      void connect();
      return { wsUrl };
    }
    if (msg.type === 'setPairingToken') {
      const token = String(msg.pairingToken || '').trim();
      if (token && !/^[0-9a-fA-F]{16,128}$/.test(token)) {
        throw new Error('pairing token looks invalid (expected hex)');
      }
      await chrome.storage.local.set({ pairingToken: token });
      if (ws) ws.close();
      void connect();
      return { saved: true };
    }
    throw new Error(`unknown message "${msg.type}"`);
  })().then(
    (result) => sendResponse({ ok: true, result }),
    (err) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return true;
});

chrome.runtime.onInstalled.addListener(() => { void connect(); });
chrome.runtime.onStartup.addListener(() => { void connect(); });
// A navigation invalidates content-script readiness; the script re-announces
// on the new page.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') readyTabs.delete(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => { readyTabs.delete(tabId); });
// Service workers can start without the events above in some flows; connect eagerly.
void connect();
