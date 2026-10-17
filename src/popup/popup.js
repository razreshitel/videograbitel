// VideoGrabitel popup: the whole UI lives here. It lists the page's main video
// (first) plus any detected streams, previews them, lets you rename + pick quality,
// and shows live progress inline. The actual download runs in the service worker
// (queue.js), so it keeps going after this popup closes; reopening re-syncs state.

import { formatDuration, formatBytes } from '../lib/util.js';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const statusEl = document.getElementById('status');
const gearBtn = document.getElementById('gear');
const settingsEl = document.getElementById('settings');
const proxyOn = document.getElementById('proxyOn');
const proxyUrl = document.getElementById('proxyUrl');
const qualityEl = document.getElementById('quality');
const tpl = document.getElementById('cardTpl');
const engineAlert = document.getElementById('engineAlert');
const engineAlertTitle = document.getElementById('engineAlertTitle');
const engineAlertMessage = document.getElementById('engineAlertMessage');
const engineCommand = document.getElementById('engineCommand');
const copyEngineCommand = document.getElementById('copyEngineCommand');
const recheckEngine = document.getElementById('recheckEngine');

let tab = null;
let settings = { proxyEnabled: false, proxyUrl: '' };
/** @type {any[]} */
let candidates = [];
/** @type {Map<string, HTMLElement>} candidate key -> card element */
const cards = new Map();
/** @type {Map<string, any>} job id -> job */
const jobsById = new Map();

const send = (type, extra) => chrome.runtime.sendMessage({ type, ...extra }).catch(() => null);
const proxyArg = () => (settings.proxyEnabled && settings.proxyUrl ? settings.proxyUrl : '');
const safeHost = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return '';
  }
};
const fileBase = (p) => String(p || '').split(/[\\/]/).pop() || String(p || '');
const isActiveJob = (j) => j?.status === 'queued' || j?.status === 'running' || j?.status === 'postprocess';
// Drop " / X", " - YouTube" style suffixes.
const cleanTitle = (t) =>
  String(t || '').replace(/\s+[/|\-–]\s+(X|Twitter|YouTube|Twitch|VK Видео|VK|Vimeo|Reddit)$/i, '').trim();

// --- settings ---------------------------------------------------------------
async function loadSettings() {
  const { settings: s } = await chrome.storage.local.get('settings');
  settings = { proxyEnabled: !!s?.proxyEnabled, proxyUrl: s?.proxyUrl || '' };
  proxyOn.checked = settings.proxyEnabled;
  proxyUrl.value = settings.proxyUrl;
  proxyUrl.disabled = !settings.proxyEnabled;
}
function saveSettings() {
  settings.proxyEnabled = proxyOn.checked;
  settings.proxyUrl = proxyUrl.value.trim();
  proxyUrl.disabled = !settings.proxyEnabled;
  chrome.storage.local.set({ settings });
}
gearBtn.addEventListener('click', () => (settingsEl.hidden = !settingsEl.hidden));
proxyOn.addEventListener('change', saveSettings);
proxyUrl.addEventListener('change', saveSettings);
proxyUrl.addEventListener('blur', saveSettings);

// --- candidates -------------------------------------------------------------
function pageCandidate(t) {
  return mkCandidate({ key: 'page:' + t.url, kind: 'page', url: t.url, host: safeHost(t.url), name: cleanTitle(t.title) || t.url, main: true });
}
// A download started from another page.
function jobCandidate(j) {
  return mkCandidate({
    key: 'job:' + j.id,
    kind: j.kind,
    url: j.url,
    host: j.host || safeHost(j.url),
    name: j.filename || j.title || j.host || j.url,
    thumbnail: j.thumbnail || '',
    duration: j.duration || 0,
    uploader: j.uploader || '',
    jobId: j.id,
    foreign: true,
  });
}
function streamCandidate(it) {
  return mkCandidate({
    key: 'stream:' + it.url,
    kind: it.kind,
    url: it.url,
    host: it.host || safeHost(it.url),
    name: it.name || it.host || it.url,
    size: it.size || 0,
    headers: it.headers || null,
    ugoira: it.ugoira || null,
    uploader: it.uploader || '',
    duration: it.duration || 0,
    frames: it.frames || 0,
    main: it.kind === 'ugoira',
  });
}
function mkCandidate(base) {
  return { thumbnail: '', duration: 0, heights: [], uploader: '', size: 0, jobId: null, renamed: false, main: false, foreign: false, ...base };
}

async function init() {
  await loadSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  candidates = [];
  const media = await send('GET_MEDIA', { tabId: tab?.id });
  const items = media?.items || [];
  // Ugoira replaces page card.
  const ugoira = items.filter((it) => it.kind === 'ugoira');
  if (tab?.url && /^https?:/i.test(tab.url) && !ugoira.length) candidates.push(pageCandidate(tab));
  for (const it of [...ugoira, ...items.filter((it) => it.kind !== 'ugoira')]) {
    if (!candidates.some((c) => c.url === it.url)) candidates.push(streamCandidate(it));
  }

  await syncJobs();
  render();
  checkEngine();
  previewMain();
}

// Reflect downloads already running/finished (popup reopened). Jobs from other
// pages get their own cards: active ones on top, finished ones at the bottom.
async function syncJobs() {
  const res = await send('queue:list');
  const all = res?.jobs || [];
  const byUrl = new Map();
  for (const j of all) {
    jobsById.set(j.id, j);
    const prev = byUrl.get(j.url);
    if (!prev || (j.createdAt || 0) > (prev.createdAt || 0)) byUrl.set(j.url, j);
  }
  const mine = new Set();
  for (const c of candidates) {
    const j = byUrl.get(c.url);
    if (j) {
      c.jobId = j.id;
      mine.add(j.id);
    }
  }
  const other = all.filter((j) => !mine.has(j.id) && j.status !== 'cancelled');
  const active = other.filter(isActiveJob).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  const finished = other.filter((j) => !isActiveJob(j)).sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  candidates = [...active.map(jobCandidate), ...candidates, ...finished.map(jobCandidate)];
}

// Live job from another page: add or move its card.
function placeForeign(job) {
  let c = candidates.find((x) => x.jobId === job.id);
  if (!c) {
    // own card (queue:add reply may lag)
    if (!isActiveJob(job) || candidates.some((x) => !x.foreign && x.url === job.url)) return;
    c = jobCandidate(job);
    candidates.unshift(c);
    document.body.classList.remove('is-empty');
    renderCard(c, true);
    return;
  }
  if (!c.foreign) return;
  const card = cards.get(c.key);
  if (job.status === 'cancelled') {
    send('queue:dismiss', { id: job.id });
    dropCard(c);
  } else if (!isActiveJob(job) && card && card !== listEl.lastElementChild) {
    listEl.appendChild(card);
    candidates = [...candidates.filter((x) => x !== c), c];
  }
}

function render() {
  listEl.textContent = '';
  cards.clear();
  const empty = candidates.length === 0;
  document.body.classList.toggle('is-empty', empty);
  if (empty) emptyEl.textContent = 'No video here. Open a normal web page (http/https).';
  for (const c of candidates) renderCard(c);
}

// --- a card -----------------------------------------------------------------
function renderCard(c, onTop = false) {
  const card = tpl.content.firstElementChild.cloneNode(true);
  cards.set(c.key, card);

  card.querySelector('.dl').addEventListener('click', () => startDownload(c));
  card.querySelector('.cancel').addEventListener('click', () => c.jobId && send('queue:cancel', { id: c.jobId }));
  card.querySelector('.retry').addEventListener('click', () => c.jobId && send('queue:retry', { id: c.jobId }));
  card.querySelector('.open').addEventListener('click', () => c.jobId && send('host:open', { id: c.jobId }));
  card.querySelector('.folder').addEventListener('click', () => c.jobId && send('host:reveal', { id: c.jobId }));
  card.querySelector('.rename').addEventListener('click', () => startRename(c, card));
  card.querySelector('.remove').addEventListener('click', () => removeCard(c));
  const thumbWrap = card.querySelector('.thumbWrap');
  if (c.kind !== 'page') {
    thumbWrap.classList.add('playable');
    thumbWrap.title = 'Double-click: play in a new tab';
    thumbWrap.addEventListener('dblclick', () => openStream(c));
  }

  if (c.foreign) card.querySelector('.rename').hidden = true;
  if (onTop) listEl.prepend(card);
  else listEl.appendChild(card);
  refreshCard(c);
}

// Direct files play in Chrome's own player; manifests need a download.
function openStream(c) {
  if (c.kind === 'ugoira') {
    flashStatus('Pixiv animation: Download saves it as a GIF.');
    return;
  }
  if (c.kind === 'hls' || c.kind === 'dash') {
    flashStatus(`${c.kind.toUpperCase()} streams can't play natively in the browser. Use Download.`);
    return;
  }
  chrome.tabs.create({ url: c.url });
}

let statusRestore = null;
function flashStatus(text) {
  if (statusRestore) clearTimeout(statusRestore);
  else statusEl.dataset.prev = statusEl.textContent;
  statusEl.textContent = text;
  statusRestore = setTimeout(() => {
    statusEl.textContent = statusEl.dataset.prev || '';
    statusRestore = null;
  }, 3000);
}

function refreshCard(c) {
  const card = cards.get(c.key);
  if (!card) return;

  const img = card.querySelector('.thumb');
  if (c.thumbnail && img.dataset.src !== c.thumbnail) {
    img.dataset.src = c.thumbnail;
    img.onload = () => (img.hidden = false);
    img.onerror = () => (img.hidden = true);
    img.src = c.thumbnail;
  } else if (!c.thumbnail) {
    img.hidden = true;
  }

  const dur = card.querySelector('.dur');
  if (c.duration) {
    dur.hidden = false;
    dur.textContent = formatDuration(c.duration);
  } else {
    dur.hidden = true;
  }

  card.querySelector('.star').hidden = !c.main;
  const job = c.jobId ? jobsById.get(c.jobId) : null;
  card.querySelector('.remove').hidden = c.foreign && isActiveJob(job);

  const titleEl = card.querySelector('.title');
  if (!titleEl.querySelector('input')) {
    titleEl.textContent = c.name || c.host || c.url;
    titleEl.title = c.name || '';
  }
  card.querySelector('.sub').textContent = subLine(c);

  setState(card, job);
}

function subLine(c) {
  const bits = [];
  if (c.host) bits.push(c.host);
  if (c.uploader) bits.push(c.uploader);
  if (c.heights?.length) bits.push(`up to ${c.heights[0]}p`);
  if (c.size) bits.push(formatBytes(c.size));
  if (c.kind === 'hls' || c.kind === 'dash') bits.push(c.kind.toUpperCase());
  if (c.kind === 'ugoira') bits.push(`GIF, ${c.frames} frames`);
  return bits.join(' | ');
}

function setState(card, job) {
  const show = (sel, on) => (card.querySelector(sel).hidden = !on);
  const st = job?.status;
  const active = st === 'queued' || st === 'running' || st === 'postprocess';
  card.classList.toggle('done', st === 'done');
  card.classList.toggle('error', st === 'error');

  show('.actions', !job || st === 'cancelled');
  show('.progress', active);
  show('.doneRow', st === 'done');
  show('.errRow', st === 'error');

  if (active) {
    const bar = card.querySelector('.bar');
    if (st === 'postprocess') {
      bar.classList.add('indeterminate');
      bar.style.width = '';
    } else {
      bar.classList.remove('indeterminate');
      bar.style.width = `${Math.round(job.percent || 0)}%`;
    }
    card.querySelector('.pstatus').textContent = statusText(job);
  } else if (st === 'done') {
    card.querySelector('.doneMsg').textContent = job.file ? `Saved: ${fileBase(job.file)}` : 'Saved to Downloads';
  } else if (st === 'error') {
    const e = card.querySelector('.errMsg');
    e.textContent = job.error || 'Download failed.';
    e.title = job.error || '';
  }
}

function statusText(job) {
  if (job.status === 'queued') return 'Queued…';
  if (job.status === 'postprocess') return `${phaseLabel(job.phase)}…`;
  return (
    `${(job.percent || 0).toFixed(0)}%` +
    `${job.total ? ` / ${job.total}` : ''}${job.speed ? ` | ${job.speed}` : ''}${job.eta ? ` | ETA ${job.eta}` : ''}`
  );
}

function phaseLabel(name) {
  if (name === 'Merger') return 'Merging';
  if (name === 'ExtractAudio') return 'Extracting audio';
  if (name === 'VideoConvertor' || name === 'VideoRemuxer') return 'Converting';
  if (name === 'EmbedSubtitle') return 'Embedding subs';
  if (name === 'Metadata') return 'Writing metadata';
  if (name && name.startsWith('Fixup')) return 'Finalizing';
  return 'Processing';
}

// --- actions ----------------------------------------------------------------
// Browser headers, page fallback
function streamHeaders(c) {
  return {
    referer: tab?.url || '',
    userAgent: navigator.userAgent,
    ...(c.headers || {}),
  };
}

async function startDownload(c) {
  const quality = qualityEl.value || 'best';
  const res = await send('queue:add', {
    job: {
      kind: c.kind,
      url: c.url,
      quality,
      title: c.name,
      filename: c.name,
      host: c.host,
      proxy: proxyArg(),
      headers: c.kind === 'page' ? null : streamHeaders(c),
      ugoira: c.ugoira,
      thumbnail: c.thumbnail,
      duration: c.duration,
      uploader: c.uploader,
    },
  });
  if (res?.id) {
    c.jobId = res.id;
    jobsById.set(res.id, { id: res.id, url: c.url, status: 'queued', percent: 0 });
    refreshCard(c);
  }
}

function startRename(c, card) {
  const titleEl = card.querySelector('.title');
  if (titleEl.querySelector('input')) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = c.name || '';
  titleEl.textContent = '';
  titleEl.appendChild(input);
  input.focus();
  input.select();
  let settled = false;
  const commit = (keep) => {
    if (settled) return;
    settled = true;
    if (keep) {
      const v = input.value.trim();
      if (v) {
        c.name = v;
        c.renamed = true;
      }
    }
    refreshCard(c);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit(true);
    } else if (e.key === 'Escape') {
      commit(false);
    }
  });
  input.addEventListener('blur', () => commit(true));
}

// Finished downloads are forgotten in every tab.
function removeCard(c) {
  const job = c.jobId ? jobsById.get(c.jobId) : null;
  if (job && !isActiveJob(job)) send('queue:dismiss', { id: job.id });
  dropCard(c);
}

function dropCard(c) {
  cards.get(c.key)?.remove();
  cards.delete(c.key);
  candidates = candidates.filter((x) => x !== c);
  if (!candidates.length) {
    document.body.classList.add('is-empty');
    emptyEl.textContent = 'Nothing here.';
  }
}

// --- preview + live updates -------------------------------------------------
async function previewMain() {
  const c = candidates.find((x) => x.main && x.kind === 'page');
  if (!c) return;
  const r = await send('media:preview', { url: c.url, proxy: proxyArg() });
  if (!r?.ok) return;
  if (r.title && !c.renamed) c.name = r.title;
  c.thumbnail = r.thumbnail || '';
  c.duration = r.duration || 0;
  c.heights = r.heights || [];
  c.uploader = r.uploader || '';
  refreshCard(c);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'job:update') {
    jobsById.set(msg.job.id, msg.job);
    placeForeign(msg.job);
    const c = candidates.find((x) => x.jobId === msg.job.id);
    if (c) refreshCard(c);
  } else if (msg.type === 'job:removed') {
    jobsById.delete(msg.id);
    const c = candidates.find((x) => x.jobId === msg.id && x.foreign);
    if (c) dropCard(c);
  }
});

async function checkEngine() {
  recheckEngine.disabled = true;
  statusEl.textContent = 'engine: checking…';
  const r = await send('engine:check');
  recheckEngine.disabled = false;
  const healthy = !!(r?.ok && r.ytdlp && r.ffmpeg);
  engineAlert.hidden = healthy;
  statusEl.closest('.foot').classList.toggle('engineError', !healthy);

  if (healthy) {
    statusEl.textContent = `engine: yt-dlp ${r.ytdlp} + ffmpeg${r.deno ? ' + deno' : ''}`;
    return;
  }

  const toolsMissing = !!(r?.ok && (!r.ytdlp || !r.ffmpeg));
  engineAlertTitle.textContent = toolsMissing ? 'Video engine is incomplete' : 'Video engine unavailable';
  engineAlertMessage.textContent = toolsMissing
    ? 'Required download tools are missing. Run this command in the VideoGrabitel folder, then check again.'
    : 'Reinstall the local engine from the VideoGrabitel folder, then reload the extension or check again.';
  engineCommand.textContent = toolsMissing ? 'npm run setup' : 'npm run install-host';
  copyEngineCommand.textContent = 'Copy command';
  statusEl.textContent = toolsMissing ? 'engine: required tools missing' : 'engine: connection failed';
}

copyEngineCommand.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(engineCommand.textContent);
    copyEngineCommand.textContent = 'Copied';
  } catch {
    copyEngineCommand.textContent = 'Copy failed';
  }
});
recheckEngine.addEventListener('click', checkEngine);

init();
