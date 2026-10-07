/**
 * content.js — runs in the page (all URLs, top frame only).
 *
 * Receives {op, params} from the background service worker and performs DOM
 * operations with plain Web APIs — no CDP, no debugger. Every op returns
 * {ok: true, result} or {ok: false, error}.
 *
 * The snapshot walker mirrors src/browser/snapshot.ts (RawNode shape) so the
 * bridge can assemble PageSnapshots identically to the Playwright backend.
 */
(() => {
  'use strict';

  // Navigation-readiness handshake: announce to the background service worker
  // as soon as this script evaluates, so it can track which tabs have a live
  // content script (see readyTabs in background.js). chrome.tabs.update
  // resolves before injection, so without this the bridge races pageInfo
  // against script readiness.
  try {
    chrome.runtime.sendMessage({ type: 'abb-ready', tabUrl: location.href });
  } catch {
    // Background not listening (e.g. service worker asleep) — ops still work;
    // the background just won't consider this tab "ready" until re-announce.
  }

  const INTERACTABLE =
    'a[href],button,input,select,textarea,[role="button"],[role="link"],' +
    '[role="textbox"],[role="checkbox"],[role="radio"],[role="switch"],' +
    '[role="tab"],[role="menuitem"],[onclick]';
  const STRUCTURAL = 'h1,h2,h3,img[alt],form,table,main,nav,header,footer';

  const cssEscape = (s) => {
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  };

  function uniqueSelector(el) {
    if (el.id) return `#${cssEscape(el.id)}`;
    const parts = [];
    let cur = el;
    const stop = document.documentElement;
    while (cur && cur !== stop && parts.length < 8) {
      let part = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (parent) {
        const sibs = Array.from(parent.children).filter((c) => c.tagName === cur.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = parent;
    }
    return parts.join(' > ');
  }

  function accessibleName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim().slice(0, 120);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const l = document.getElementById(labelledBy);
      if (l && l.textContent) return l.textContent.trim().slice(0, 120);
    }
    if (el instanceof HTMLImageElement && el.alt) return el.alt.trim().slice(0, 120);
    if (el instanceof HTMLInputElement) {
      if (el.placeholder) return el.placeholder.trim().slice(0, 120);
      const ls = el.labels;
      if (ls && ls.length > 0 && ls[0].textContent) return ls[0].textContent.trim().slice(0, 120);
    }
    if ((el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) && el.labels && el.labels.length > 0) {
      return el.labels[0].textContent.trim().slice(0, 120);
    }
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
    return t.slice(0, 120);
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (t === 'checkbox') return 'checkbox';
      if (t === 'radio') return 'radio';
      if (t === 'submit' || t === 'button') return 'button';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'img') return 'img';
    if (tag === 'form') return 'form';
    return tag;
  }

  function isVisible(el) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  function walkDom() {
    const seen = new Set();
    const nodes = [];
    let counter = 0;
    const push = (el) => {
      if (seen.has(el)) return;
      seen.add(el);
      counter += 1;
      const r = el.getBoundingClientRect();
      const attrs = {};
      for (const a of ['type', 'href', 'placeholder', 'value', 'alt', 'title', 'name']) {
        const v = el.getAttribute(a);
        if (v !== null) attrs[a] = v.slice(0, 200);
      }
      nodes.push({
        ref: `e${counter}`,
        role: roleOf(el),
        name: accessibleName(el),
        tag: el.tagName.toLowerCase(),
        text: (el.innerText || '').trim().slice(0, 200),
        attributes: attrs,
        selector: uniqueSelector(el),
        parentRef: null,
        boundingBox:
          r.width || r.height ? { x: r.x, y: r.y, width: r.width, height: r.height } : null,
        visible: isVisible(el),
      });
    };
    document.querySelectorAll(`${INTERACTABLE},${STRUCTURAL}`).forEach(push);
    return nodes;
  }

  function resolve(selector) {
    const el = document.querySelector(selector);
    if (!el) throw new Error(`no element matches selector "${selector}"`);
    return el;
  }

  function describe(el) {
    const r = el.getBoundingClientRect();
    return {
      role: roleOf(el),
      name: accessibleName(el),
      tag: el.tagName.toLowerCase(),
      visible: isVisible(el),
      value: 'value' in el ? String(el.value ?? '') : undefined,
      checked: 'checked' in el ? Boolean(el.checked) : undefined,
      inputType: el.getAttribute('type') || undefined,
      boundingBox: { x: r.x, y: r.y, width: r.width, height: r.height },
    };
  }

  function fire(el, type, init) {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true, ...init }));
  }

  const ops = {
    ping() {
      return { ok: true, url: location.href };
    },
    snapshot() {
      return { url: location.href, title: document.title, nodes: walkDom() };
    },
    click({ selector }) {
      const el = resolve(selector);
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { clicked: selector };
    },
    dblclick({ selector }) {
      const el = resolve(selector);
      el.scrollIntoView({ block: 'center' });
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return { doubleClicked: selector };
    },
    type({ selector, text, submit }) {
      const el = resolve(selector);
      el.focus();
      // Prefer native value setter so framework listeners fire.
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      const old = el.value;
      if (setter) setter.call(el, text);
      else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (submit) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return { typed: selector, previousLength: String(old).length };
    },
    clear({ selector }) {
      const el = resolve(selector);
      el.focus();
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { cleared: selector };
    },
    pressKey({ key }) {
      // Synthetic (untrusted) keyboard events — not equivalent to real input.
      const target = document.activeElement || document.body;
      for (const type of ['keydown', 'keypress', 'keyup']) {
        target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
      }
      return { pressed: key, synthetic: true };
    },
    hover({ selector }) {
      const el = resolve(selector);
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      return { hovered: selector };
    },
    focus({ selector }) {
      resolve(selector).focus();
      return { focused: selector };
    },
    scrollIntoView({ selector }) {
      resolve(selector).scrollIntoView({ block: 'center' });
      return { scrolledTo: selector };
    },
    scrollBy({ dx, dy }) {
      window.scrollBy(Number(dx) || 0, Number(dy) || 0);
      return { scrolledBy: { dx: Number(dx) || 0, dy: Number(dy) || 0 } };
    },
    selectOption({ selector, values }) {
      const el = resolve(selector);
      if (!(el instanceof HTMLSelectElement)) throw new Error('not a <select> element');
      const wanted = new Set(values);
      for (const opt of el.options) opt.selected = wanted.has(opt.value) || wanted.has(opt.text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return Array.from(el.selectedOptions).map((o) => o.value);
    },
    setChecked({ selector, checked }) {
      const el = resolve(selector);
      if (!(el instanceof HTMLInputElement) || !/^(checkbox|radio)$/.test(el.type)) {
        throw new Error('not a checkbox/radio input');
      }
      el.checked = Boolean(checked);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { checked: el.checked };
    },
    waitForSelector({ selector, state, timeoutMs }) {
      const st = state || 'visible';
      const timeout = Math.min(Number(timeoutMs) || 10000, 60000);
      return new Promise((resolveP, rejectP) => {
        const done = (ok, why) => {
          obs.disconnect();
          clearTimeout(timer);
          if (ok) resolveP({ selector, state: st });
          else rejectP(new Error(`waitForSelector timed out: "${selector}" did not become ${st} (${why})`));
        };
        const check = () => {
          const el = document.querySelector(selector);
          if (st === 'attached') return el ? done(true) : false;
          if (!el) return st === 'hidden' ? done(true) : false;
          const vis = isVisible(el);
          if (st === 'visible' && vis) return done(true);
          if (st === 'hidden' && !vis) return done(true);
          return false;
        };
        const obs = new MutationObserver(() => void check());
        obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
        const timer = setTimeout(() => done(false, 'timeout'), timeout);
        check();
      });
    },
    pageText({ selector }) {
      if (selector) return resolve(selector).innerText || '';
      return document.body ? document.body.innerText || '' : '';
    },
    pageInfo() {
      const meta = document.querySelector('meta[name="description"]');
      return {
        url: location.href,
        title: document.title,
        description: meta ? (meta.getAttribute('content') || '') : '',
      };
    },
    viewportSize() {
      return { width: window.innerWidth, height: window.innerHeight };
    },
    listFrames() {
      return Array.from(document.querySelectorAll('iframe')).map((f) => ({
        url: (() => { try { return f.contentWindow.location.href; } catch { return ''; } })(),
        name: f.getAttribute('name') || f.id || '',
      }));
    },
    describeTarget({ selector }) {
      const el = document.querySelector(selector);
      return el ? describe(el) : null;
    },
    elementFromPoint({ x, y }) {
      const w = window.innerWidth;
      const h = window.innerHeight;
      if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || y < 0 || x > w || y > h) {
        throw new Error(`point (${x}, ${y}) is outside the viewport ${w}x${h} — refused`);
      }
      const el = document.elementFromPoint(x, y);
      if (!el) return null;
      const d = describe(el);
      return { selector: uniqueSelector(el), ...d };
    },
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        const fn = ops[msg.op];
        if (!fn) return { ok: false, error: `unknown content op "${msg.op}"` };
        const result = await fn(msg.params || {});
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    })().then(sendResponse);
    return true; // async response
  });
})();
