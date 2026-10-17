// VideoGrabitel background service worker (MV3).
// Observes network responses, classifies media, keeps a per-tab catalogue,
// drives the toolbar badge, and owns the download queue (see queue.js).
// Page-scan hits (content script) are probed with a HEAD request first.

import { classify, isNoisyDirectUrl, isSiteNoise, dispositionName, probeDetails } from './detector.js';
import { uid, basename, hostOf } from '../lib/util.js';
import { handleQueueMessage } from './queue.js';
import { cleanUgoira, ugoiraDuration } from '../lib/ugoira-core.js';

const MAX_PER_TAB = 60;
const MAX_PROBES_PER_SCAN = 20;
const PROBE_CONCURRENCY = 4;
const PROBE_TIMEOUT = 8000;
const BADGE_COLOR = '#4F46E5';

// tabId -> Map<dedupeKey, item>
/** @type {Map<number, Map<string, any>>} */
const store = new Map();
// tabId -> Set<url> already probed for this page
/** @type {Map<number, Set<string>>} */
const probed = new Map();

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
          if (it.kind === 'direct' && !it.scanned && isNoisyDirectUrl(it.url)) continue;
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
  probed.delete(tabId);
  if (store.has(tabId)) {
    store.delete(tabId);
    schedulePersist();
  }
  setBadge(tabId);
}

// Shared by the network and page-scan paths.
function addItem(tabId, url, hit, headers, nameHint, scanned, extra) {
  const m = tabItems(tabId);
  const key = dedupeKey(url);
  const existing = m.get(key);
  if (existing) {
    if (hit.size && !existing.size) existing.size = hit.size;
    if (headers && !scanned) existing.headers = headers;
    if (nameHint && existing.name === (basename(existing.url) || existing.host)) existing.name = nameHint;
    return;
  }
  if (m.size >= MAX_PER_TAB) return;

  m.set(key, {
    id: uid(),
    tabId,
    url,
    kind: hit.kind, // 'hls' | 'dash' | 'direct'
    container: hit.container,
    contentType: hit.contentType,
    size: hit.size,
    name: nameHint || basename(url) || hostOf(url),
    host: hostOf(url),
    headers: headers || null,
    scanned: !!scanned,
    ts: Date.now(),
    ...extra,
  });

  schedulePersist();
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
  if (!hit || isSiteNoise(details.url, details.documentUrl || details.initiator || '')) return;

  await ensureLoaded();
  addItem(details.tabId, details.url, hit, headers, dispositionName(details.responseHeaders), false);
}

chrome.webRequest.onResponseStarted.addListener(
  onResponse,
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

// --- page scan (content script) --------------------------------------------
function scanHeaders(pageUrl) {
  let origin = '';
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    /* keep empty */
  }
  return { referer: pageUrl, origin, userAgent: navigator.userAgent };
}

// HEAD first; servers that refuse HEAD get a one-byte ranged GET.
// Returns details, {status} for an HTTP error, or null when unreachable.
async function probe(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
  const opts = { credentials: 'include', redirect: 'follow', signal: ctrl.signal };
  try {
    let res = await fetch(url, { ...opts, method: 'HEAD' });
    if (!res.ok || !res.headers.get('content-type')) {
      res = await fetch(url, { ...opts, method: 'GET', headers: { Range: 'bytes=0-0' } });
      try {
        await res.body?.cancel();
      } catch {
        /* already drained */
      }
    }
    if (!res.ok) return { status: res.status };
    return probeDetails(url, (name) => res.headers.get(name));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Tiny clips (emoji GIFs) or pages and images.
function isJunkProbe(details) {
  const get = (n) => details.responseHeaders.find((h) => h.name === n)?.value || '';
  const size = Number(get('content-length')) || 0;
  return (size > 0 && size < 50 * 1024) || /^(text|image)\//i.test(get('content-type'));
}

async function runLimited(list, limit, fn) {
  let i = 0;
  const worker = async () => {
    while (i < list.length) await fn(list[i++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
}

async function ingestScan(tabId, pageUrl, items) {
  await ensureLoaded();
  const headers = scanHeaders(pageUrl);
  let set = probed.get(tabId);
  if (!set) {
    set = new Set();
    probed.set(tabId, set);
  }
  const todo = [];
  for (const raw of items) {
    const url = String(raw?.url || '');
    if (!/^https?:/i.test(url) || tabItems(tabId).has(dedupeKey(url)) || set.has(url)) continue;
    set.add(url);
    if (isSiteNoise(url, pageUrl)) continue;
    const kind = raw.kind === 'hls' || raw.kind === 'dash' ? raw.kind : '';
    if (kind) {
      addItem(tabId, url, { kind, container: kind === 'hls' ? 'm3u8' : 'mpd', contentType: '', size: 0 }, headers, '', true);
      continue;
    }
    todo.push({ url, direct: raw.kind === 'direct' });
    if (todo.length >= MAX_PROBES_PER_SCAN) break;
  }
  await runLimited(todo, PROBE_CONCURRENCY, async ({ url, direct }) => {
    const details = await probe(url);
    if (!details?.responseHeaders) {
      // Hotlink-protected files refuse the probe; yt-dlp still gets the Referer.
      const gone = details && (details.status === 404 || details.status === 410);
      if (direct && !gone) addItem(tabId, url, { kind: 'direct', container: '', contentType: '', size: 0 }, headers, '', true);
      return;
    }
    const hit = classify(details, { trustName: true });
    if (hit) addItem(tabId, url, hit, headers, dispositionName(details.responseHeaders), true);
    else if (direct && !isJunkProbe(details)) addItem(tabId, url, { kind: 'direct', container: '', contentType: '', size: 0 }, headers, '', true);
  });
}

function ingestUgoira(tabId, raw) {
  const ugo = cleanUgoira(raw);
  if (!ugo) return;
  const id = String(raw.id || '').replace(/\D/g, '');
  const headers = { referer: 'https://www.pixiv.net/', userAgent: navigator.userAgent };
  const hit = { kind: 'ugoira', container: 'gif', contentType: '', size: 0 };
  addItem(tabId, ugo.zip, hit, headers, String(raw.title || '').slice(0, 150) || `pixiv ${id}`, true, {
    ugoira: ugo,
    uploader: String(raw.user || '').slice(0, 100),
    duration: ugoiraDuration(ugo.frames),
    frames: ugo.frames.length,
  });
}

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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (handleQueueMessage(msg, sendResponse)) return true; // queue owns it (may reply async)
  (async () => {
    await ensureLoaded();
    if (msg.type === 'PAGE_SCAN') {
      const tabId = sender?.tab?.id;
      if (tabId == null || tabId < 0) {
        sendResponse({ ok: false });
        return;
      }
      sendResponse({ ok: true });
      ingestScan(tabId, String(msg.pageUrl || sender.url || ''), Array.isArray(msg.items) ? msg.items : []);
      return;
    }
    if (msg.type === 'PAGE_UGOIRA') {
      const tabId = sender?.tab?.id;
      if (tabId != null && tabId >= 0) ingestUgoira(tabId, msg.item);
      sendResponse({ ok: tabId != null });
      return;
    }
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
