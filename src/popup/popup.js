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
  return mkCandidate({ key: 'page:' + t.url, kind: 'page', url: t.url, host: safeHost(t.url), name: t.title || t.url, main: true });
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
  });
}
function mkCandidate(base) {
  return { thumbnail: '', duration: 0, heights: [], uploader: '', size: 0, jobId: null, renamed: false, main: false, ...base };
}

async function init() {
  await loadSettings();
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  candidates = [];
  if (tab?.url && /^https?:/i.test(tab.url)) candidates.push(pageCandidate(tab));
  const media = await send('GET_MEDIA', { tabId: tab?.id });
  for (const it of media?.items || []) {
    if (!candidates.some((c) => c.url === it.url)) candidates.push(streamCandidate(it));
  }

  await syncJobs();
  render();
  checkEngine();
  previewMain();
}

// Reflect any downloads already running/finished for these URLs (popup reopened).
async function syncJobs() {
  const res = await send('queue:list');
  const byUrl = new Map();
  for (const j of res?.jobs || []) {
    jobsById.set(j.id, j);
    const prev = byUrl.get(j.url);
    if (!prev || (j.createdAt || 0) > (prev.createdAt || 0)) byUrl.set(j.url, j);
  }
  for (const c of candidates) {
    const j = byUrl.get(c.url);
    if (j) c.jobId = j.id;
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
function renderCard(c) {
  const card = tpl.content.firstElementChild.cloneNode(true);
  cards.set(c.key, card);

  card.querySelector('.dl').addEventListener('click', () => startDownload(c));
  card.querySelector('.cancel').addEventListener('click', () => c.jobId && send('queue:cancel', { id: c.jobId }));
  card.querySelector('.retry').addEventListener('click', () => c.jobId && send('queue:retry', { id: c.jobId }));
  card.querySelector('.open').addEventListener('click', () => c.jobId && send('host:open', { id: c.jobId }));
  card.querySelector('.folder').addEventListener('click', () => c.jobId && send('host:reveal', { id: c.jobId }));
  card.querySelector('.rename').addEventListener('click', () => startRename(c, card));
  card.querySelector('.remove').addEventListener('click', () => removeCard(c));

  listEl.appendChild(card);
  refreshCard(c);
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

  const titleEl = card.querySelector('.title');
  if (!titleEl.querySelector('input')) {
    titleEl.textContent = c.name || c.host || c.url;
    titleEl.title = c.name || '';
  }
  card.querySelector('.sub').textContent = subLine(c);

  setState(card, c.jobId ? jobsById.get(c.jobId) : null);
}

function subLine(c) {
  const bits = [];
  if (c.host) bits.push(c.host);
  if (c.uploader) bits.push(c.uploader);
  if (c.heights?.length) bits.push(`up to ${c.heights[0]}p`);
  if (c.size) bits.push(formatBytes(c.size));
  if (c.kind === 'hls' || c.kind === 'dash') bits.push(c.kind.toUpperCase());
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

function removeCard(c) {
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
  const c = candidates.find((x) => x.main);
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
    const c = candidates.find((x) => x.jobId === msg.job.id);
    if (c) refreshCard(c);
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
