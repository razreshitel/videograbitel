// Content-script module: collects media URLs from the DOM and the page text
// and reports new ones to the service worker, which verifies and lists them.

import { scanText, kindByExt, MAX_SCAN_ITEMS } from '../lib/scan-core.js';

const TEXT_CAP = 3 * 1024 * 1024;
const MIN_FULL_GAP = 4000;
const MAX_FULL_SCANS = 30;

const sent = new Set();
let timer = null;
let lastFull = 0;
let fullScans = 0;
let pageKey = '';

function abs(v) {
  try {
    const u = new URL(String(v || ''), location.href);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

function domItems() {
  const out = [];
  const push = (v, source) => {
    const url = abs(v);
    if (url) out.push({ url, kind: kindByExt(url), source });
  };
  for (const el of document.querySelectorAll('video, audio, source')) {
    push(el.currentSrc || el.getAttribute('src') || el.getAttribute('data-src'), 'dom');
  }
  for (const m of document.querySelectorAll(
    'meta[property^="og:video"], meta[property^="og:audio"], meta[name^="twitter:player:stream"]',
  )) {
    push(m.getAttribute('content'), 'meta');
  }
  for (const a of document.querySelectorAll('a[href]')) {
    if (kindByExt(a.href)) push(a.href, 'link');
  }
  return out;
}

// Pixiv ugoira (canvas animation).
let pixivId = '';
async function scanPixiv() {
  if (window !== window.top || !/(^|\.)pixiv\.net$/.test(location.hostname)) return;
  const id = location.pathname.match(/^\/(?:[a-z]{2}\/)?artworks\/(\d+)/)?.[1];
  if (id === pixivId) return;
  pixivId = id || '';
  if (!id) return;
  const get = async (p) => (await fetch(p, { credentials: 'include' })).json();
  try {
    const info = (await get(`/ajax/illust/${id}`))?.body;
    if (info?.illustType !== 2) return;
    const meta = (await get(`/ajax/illust/${id}/ugoira_meta`))?.body;
    if (!meta?.originalSrc) return;
    chrome.runtime
      .sendMessage({
        type: 'PAGE_UGOIRA',
        pageUrl: location.href,
        item: { id, title: info.illustTitle || '', user: info.userName || '', zip: meta.originalSrc, frames: meta.frames },
      })
      .catch(() => {});
  } catch {
    pixivId = '';
  }
}

function scan() {
  scanPixiv();
  const key = location.origin + location.pathname;
  if (key !== pageKey) {
    pageKey = key;
    sent.clear();
    fullScans = 0;
  }
  let items = domItems();
  const now = Date.now();
  if (fullScans < MAX_FULL_SCANS && now - lastFull > MIN_FULL_GAP) {
    lastFull = now;
    fullScans++;
    const html = document.documentElement ? document.documentElement.outerHTML : '';
    items = items.concat(scanText(html.slice(0, TEXT_CAP)));
  }
  const fresh = [];
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.url) || sent.has(it.url)) continue;
    seen.add(it.url);
    fresh.push(it);
    if (fresh.length >= MAX_SCAN_ITEMS) break;
  }
  if (!fresh.length) return;
  for (const it of fresh) sent.add(it.url);
  try {
    chrome.runtime.sendMessage({ type: 'PAGE_SCAN', items: fresh, pageUrl: location.href }).catch(() => {});
  } catch {
    /* extension reloaded */
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    scan();
  }, 1500);
}

scan();
window.addEventListener('load', schedule);
new MutationObserver(schedule).observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['src', 'href', 'data-src'],
});
