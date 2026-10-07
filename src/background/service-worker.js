// VideoGrabitel background service worker (MV3).
// Observes network responses, classifies media, keeps a per-tab catalogue,
// drives the toolbar badge, and owns the download queue (see queue.js).

import { classify, isNoisyDirectUrl } from './detector.js';
import { uid, basename, hostOf } from '../lib/util.js';
import { handleQueueMessage } from './queue.js';

const MAX_PER_TAB = 60;
const BADGE_COLOR = '#4F46E5';

// tabId -> Map<dedupeKey, item>
/** @type {Map<number, Map<string, any>>} */
const store = new Map();

// Query params that vary per request for the *same* logical media (byte ranges,
// CDN tokens, cache-busters). Stripping them collapses dozens of near-identical
// URLs (e.g. a single video requested as many range chunks) into one list entry.
const VOLATILE_PARAMS = new Set([
  'range', 'rn', 'rbuf', 'bytestart', 'byteend', 'sq', 'dur', 'keepalive', 'rm',
  'cms_redirect', 'cmsv', 'ei', 'rqh', 'mime', 'ms', 'mt', 'mv', 'mn', '_', 't',
  'start', 'end', 'offset', 'pos', 'ts', 'cache',
]);

function dedupeKey(url) {
  try {
    const u = new URL(url);
    const kept = [...u.searchParams.entries()]
      .filter(([k]) => !VOLATILE_PARAMS.has(k.toLowerCase()))
      .sort();
    const q = kept.length ? '?' + kept.map(([k, v]) => `${k}=${v}`).join('&') : '';
    return u.origin + u.pathname + q;
  } catch {
    return url;
  }
}

// --- session persistence (survives SW suspend/resume) -----------------------
let loaded = false;
async function ensureLoaded() {
  if (loaded) return;
  try {
    const { media } = await chrome.storage.session.get('media');
    if (media) {
      for (const [tabId, items] of Object.entries(media)) {
        const m = new Map();
        for (const it of items) {
          if (it.kind === 'direct' && isNoisyDirectUrl(it.url)) continue;
          m.set(dedupeKey(it.url), it);
        }
        store.set(Number(tabId), m);
      }
    }
  } catch {
    /* first run */
  }
  loaded = true;
}

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    const media = {};
    for (const [tabId, m] of store) media[tabId] = [...m.values()];
    try {
      await chrome.storage.session.set({ media });
    } catch {
      /* ignore quota / suspended */
    }
  }, 400);
}

function tabItems(tabId) {
  let m = store.get(tabId);
  if (!m) {
    m = new Map();
    store.set(tabId, m);
  }
  return m;
}

async function setBadge(tabId) {
  const n = store.get(tabId)?.size || 0;
  try {
    await chrome.action.setBadgeText({ tabId, text: n ? String(n) : '' });
  } catch {
    /* tab gone */
  }
}

function clearTab(tabId) {
  if (store.has(tabId)) {
    store.delete(tabId);
    schedulePersist();
  }
  setBadge(tabId);
}

// --- detection --------------------------------------------------------------
// requestId -> browser headers
const reqHeaders = new Map();
const KEEP_HEADERS = { referer: 'referer', origin: 'origin', 'user-agent': 'userAgent', cookie: 'cookie' };

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    if (d.tabId < 0) return;
    const h = {};
    for (const { name, value } of d.requestHeaders || []) {
      const k = KEEP_HEADERS[name.toLowerCase()];
      if (k && value) h[k] = value;
    }
    reqHeaders.set(d.requestId, h);
    if (reqHeaders.size > 500) reqHeaders.delete(reqHeaders.keys().next().value);
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['requestHeaders', 'extraHeaders'],
);

async function onResponse(details) {
  const headers = reqHeaders.get(details.requestId);
  reqHeaders.delete(details.requestId);
  if (details.tabId < 0) return; // not attached to a tab (e.g. SW fetch)
  const hit = classify(details);
  if (!hit) return;

  await ensureLoaded();
  const m = tabItems(details.tabId);

  const key = dedupeKey(details.url);
  const existing = m.get(key);
  if (existing) {
    if (hit.size && !existing.size) existing.size = hit.size;
    if (headers) existing.headers = headers;
    return;
  }
  if (m.size >= MAX_PER_TAB) return;

  m.set(key, {
    id: uid(),
    tabId: details.tabId,
    url: details.url,
    kind: hit.kind, // 'hls' | 'dash' | 'direct'
    container: hit.container,
    contentType: hit.contentType,
    size: hit.size,
    name: basename(details.url) || hostOf(details.url),
    host: hostOf(details.url),
    headers: headers || null,
    ts: Date.now(),
  });

  schedulePersist();
  setBadge(details.tabId);
}

chrome.webRequest.onResponseStarted.addListener(
  onResponse,
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

// Reset a tab's catalogue when it navigates to a new top-level page.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.type === 'main_frame' && d.tabId >= 0) clearTab(d.tabId);
  },
  { urls: ['<all_urls>'] },
);

// SPA navigations (history API) change the tab URL without a main_frame request,
// so also clear when the path changes. Ignore pure query/hash changes (some
// players rewrite ?t=… during playback) to avoid wiping the list mid-watch.
const lastPath = new Map(); // tabId -> origin+pathname
function pathKey(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const pk = pathKey(changeInfo.url);
  if (lastPath.get(tabId) !== pk) {
    lastPath.set(tabId, pk);
    clearTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  lastPath.delete(tabId);
  clearTab(tabId);
});

// --- messaging --------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (handleQueueMessage(msg, sendResponse)) return true; // queue owns it (may reply async)
  (async () => {
    await ensureLoaded();
    if (msg.type === 'GET_MEDIA') {
      const m = store.get(msg.tabId);
      const items = m ? [...m.values()].sort((a, b) => b.ts - a.ts) : [];
      sendResponse({ items });
      return;
    }
    if (msg.type === 'CLEAR_TAB') {
      clearTab(msg.tabId);
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ error: 'unknown message' });
  })();
  return true; // async response
});

// --- lifecycle --------------------------------------------------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
});
chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR });
