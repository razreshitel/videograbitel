// Download queue, owned by the service worker.
//
// The SW (not the popup) owns the native connections so a download survives the
// popup closing: each running job has its own connectNative Port (= one host
// process running one yt-dlp), and the steady progress stream keeps the MV3
// worker alive for the duration. State is in-memory only — there is no history to
// persist; when the popup reopens it re-syncs via queue:list and matches jobs to
// the page's candidates by URL. Preview (metadata for a candidate) is a simple
// request/response; the popup drives it before the user commits to a download.

import { uid } from '../lib/util.js';
import { isTerminal, pickQueued } from './queue-core.js';

const HOST = 'com.videograbitel.host';
const MAX_CONCURRENT = 2;
const MAX_JOBS = 60; // soft cap on retained (mostly terminal) jobs in memory

/** @type {Map<string, any>} id -> job */
const jobs = new Map();
/** @type {Map<string, chrome.runtime.Port>} id -> live download port */
const ports = new Map();
/** @type {Map<string, string[]>} id -> in-memory log buffer (active jobs) */
const logs = new Map();

// --- broadcasting to the popup (when open) ----------------------------------
function broadcast(type, payload) {
  chrome.runtime.sendMessage({ type, ...payload }).catch(() => {});
}
function update(job, patch) {
  Object.assign(job, patch);
  broadcast('job:update', { job });
}

// Keep memory bounded: drop the oldest terminal jobs once we exceed the cap.
function prune() {
  if (jobs.size <= MAX_JOBS) return;
  const terminal = [...jobs.values()].filter(isTerminal).sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  for (const j of terminal) {
    if (jobs.size <= MAX_JOBS) break;
    jobs.delete(j.id);
    logs.delete(j.id);
  }
}

// --- adding -----------------------------------------------------------------
function addJob(spec = {}) {
  const id = uid();
  const job = {
    id,
    url: String(spec.url || ''),
    kind: spec.kind || 'stream',
    quality: spec.quality || 'best',
    subs: !!spec.subs,
    title: spec.title || '',
    filename: spec.filename || '',
    proxy: spec.proxy || '',
    headers: spec.headers && typeof spec.headers === 'object' ? spec.headers : null,
    host: spec.host || '',
    status: 'queued',
    percent: 0,
    total: '',
    speed: '',
    eta: '',
    phase: '',
    file: null,
    outDir: null,
    error: '',
    createdAt: Date.now(),
    startedAt: 0,
    endedAt: 0,
  };
  jobs.set(id, job);
  prune();
  broadcast('job:update', { job });
  pump();
  return id;
}

// --- preview (metadata only, request/response) ------------------------------
function preview(msg, sendResponse) {
  const url = String(msg.url || '');
  if (!/^https?:\/\//i.test(url)) {
    sendResponse({ ok: false, error: 'bad-url' });
    return;
  }
  let port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    sendResponse({ ok: false, error: 'not-installed' });
    return;
  }
  let done = false;
  const reply = (r) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      port.disconnect();
    } catch {
      /* already closed */
    }
    sendResponse(r);
  };
  const timer = setTimeout(() => reply({ ok: false, error: 'timeout' }), 25000);
  port.onMessage.addListener((m) => {
    if (m.type === 'preview') {
      reply({
        ok: true,
        title: m.title || '',
        thumbnail: /^https?:\/\//i.test(m.thumbnail || '') ? m.thumbnail : '',
        duration: m.duration || 0,
        uploader: m.uploader || '',
        heights: Array.isArray(m.heights) ? m.heights : [],
      });
    } else if (m.type === 'previewError') {
      reply({ ok: false, error: 'unavailable', detail: m.detail || m.message || '' });
    } else if (m.type === 'ready') {
      try {
        port.postMessage({ action: 'preview', url, proxy: msg.proxy || '' });
      } catch {
        reply({ ok: false, error: 'host-gone' });
      }
    }
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || '';
    reply({ ok: false, error: /not found|forbidden/i.test(err) ? 'not-installed' : err || 'no-response' });
  });
}

// --- running ----------------------------------------------------------------
function pump() {
  for (const job of pickQueued([...jobs.values()], MAX_CONCURRENT)) startJob(job);
}

function startJob(job) {
  let port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    return finishJob(job, { status: 'error', error: 'Native helper not reachable — run npm run install-host.' });
  }
  ports.set(job.id, port);
  logs.set(job.id, []);
  update(job, { status: 'running', startedAt: Date.now(), error: '', percent: 0, total: '', speed: '', eta: '', phase: '' });

  port.onMessage.addListener((msg) => onHostMessage(job.id, msg));
  port.onDisconnect.addListener(() => {
    ports.delete(job.id);
    const j = jobs.get(job.id);
    if (!j || isTerminal(j)) return; // finished cleanly
    const err = chrome.runtime.lastError?.message || '';
    finishJob(j, {
      status: 'error',
      error: /not found|forbidden/i.test(err)
        ? 'Native helper not installed — run npm run install-host.'
        : `Helper disconnected${err ? `: ${err}` : ''}.`,
    });
  });

  try {
    port.postMessage({
      action: 'download',
      url: job.url,
      quality: job.quality,
      subs: job.subs,
      filename: job.filename,
      proxy: job.proxy,
      headers: job.headers,
    });
  } catch (e) {
    finishJob(job, { status: 'error', error: e.message });
  }
}

function onHostMessage(id, msg) {
  const job = jobs.get(id);
  if (!job) return;
  switch (msg.type) {
    case 'ready':
    case 'started':
      break;
    case 'progress':
      update(job, {
        status: 'running',
        percent: msg.percent || 0,
        total: msg.total || '',
        speed: msg.speed || '',
        eta: msg.eta || '',
        phase: '',
      });
      break;
    case 'phase':
      update(job, { status: 'postprocess', phase: msg.name || '' });
      break;
    case 'log':
      appendLog(id, msg.line);
      break;
    case 'done':
      finishJob(job, { status: 'done', percent: 100, file: msg.file || null, outDir: msg.outDir || null });
      break;
    case 'cancelled':
      finishJob(job, { status: 'cancelled' });
      break;
    case 'error':
      finishJob(job, { status: 'error', error: friendlyError(msg.detail || msg.message, job) || msg.message || 'Download failed.' });
      break;
  }
}

function appendLog(id, line) {
  let arr = logs.get(id);
  if (!arr) {
    arr = [];
    logs.set(id, arr);
  }
  arr.push(line);
  if (arr.length > 200) arr.splice(0, arr.length - 200);
  broadcast('job:log', { id, line });
}

function finishJob(job, patch) {
  const port = ports.get(job.id);
  if (port) {
    try {
      port.disconnect();
    } catch {
      /* already closed */
    }
    ports.delete(job.id);
  }
  const tail = (logs.get(job.id) || []).slice(-40);
  logs.delete(job.id);
  update(job, { ...patch, endedAt: Date.now(), logTail: tail });
  prune();
  pump();
}

// --- user actions -----------------------------------------------------------
function cancel(id) {
  const job = jobs.get(id);
  if (!job) return;
  const port = ports.get(id);
  if (port) {
    try {
      port.postMessage({ action: 'cancel' }); // host replies 'cancelled' -> finishJob
    } catch {
      finishJob(job, { status: 'cancelled' });
    }
    return;
  }
  if (job.status === 'queued') finishJob(job, { status: 'cancelled' });
}

function retry(id) {
  const job = jobs.get(id);
  if (!job || !isTerminal(job)) return;
  update(job, {
    status: 'queued',
    error: '',
    percent: 0,
    total: '',
    speed: '',
    eta: '',
    phase: '',
    file: null,
    outDir: null,
    startedAt: 0,
    endedAt: 0,
    logTail: [],
  });
  pump();
}

// Ask the host to open / reveal a finished file (short-lived port).
function hostFileAction(action, id) {
  const job = jobs.get(id);
  const file = job?.file || job?.outDir;
  if (!file) return;
  let port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    return;
  }
  port.onDisconnect.addListener(() => void chrome.runtime.lastError);
  try {
    port.postMessage({ action, file });
  } catch {
    /* host gone */
  }
  setTimeout(() => {
    try {
      port.disconnect();
    } catch {
      /* already closed */
    }
  }, 1500);
}

function engineCheck(sendResponse) {
  let port;
  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    sendResponse({ ok: false, error: 'not-installed' });
    return;
  }
  let done = false;
  const reply = (r) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    try {
      port.disconnect();
    } catch {
      /* already closed */
    }
    sendResponse(r);
  };
  const timer = setTimeout(() => reply({ ok: false, error: 'timeout' }), 4000);
  port.onMessage.addListener((msg) => {
    if (msg.type === 'pong') reply({ ok: true, ytdlp: msg.ytdlp, ffmpeg: msg.ffmpeg, deno: msg.deno });
    else if (msg.type === 'ready') {
      try {
        port.postMessage({ action: 'ping' });
      } catch {
        /* host gone */
      }
    }
  });
  port.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || '';
    reply({ ok: false, error: /not found|forbidden/i.test(err) ? 'not-installed' : err || 'no-response' });
  });
}

// Turn common yt-dlp stderr into a plain-language, actionable message.
function friendlyError(text, job) {
  const d = (text || '').toLowerCase();
  const noProxy = !job?.proxy;
  if (/sign in to confirm|not a bot|confirm you.?re not a bot/.test(d))
    return 'YouTube wants a sign-in / bot check for this video. Try again shortly.';
  if (/requested format is not available/.test(d)) return 'That quality isn’t available — try “Best”.';
  if (/http error 429|too many requests/.test(d)) return 'Rate-limited by the server — wait a moment and retry.';
  if (/http error 403|forbidden/.test(d))
    return noProxy
      ? 'The server blocked the request (403). Chrome uses your VPN but downloads don’t: set the proxy in ⚙ settings.'
      : 'The server blocked the request (403). Try again in a moment.';
  if (/private video|video unavailable|video is unavailable|members-only/.test(d))
    return 'This video is private, members-only, or unavailable.';
  if (/not available in your country|geo|in your location/.test(d))
    return 'Geo-blocked in your region — try enabling a proxy in settings.';
  if (/age.?restricted|confirm your age|inappropriate for some/.test(d))
    return 'Age-restricted video — it may require sign-in.';
  if (/drm|protected stream|protected content/.test(d)) return 'This stream is DRM-protected and can’t be downloaded.';
  if (/unsupported url|unable to extract|no video formats|nothing to download/.test(d))
    return 'No downloadable video found here.';
  if (/ffmpeg|postprocess/.test(d)) return 'Conversion failed — is ffmpeg installed? Run “npm run fetch-tools”.';
  if (/timed out|timeout|connection|network is unreachable|getaddrinfo|resolve|eof occurred|ssl/.test(d))
    return 'Network error reaching the site — if it needs a VPN, enable a proxy in settings.';
  return null;
}

// --- message dispatch (called by the service worker) ------------------------
// Returns true if it owns the message (and will call sendResponse).
export function handleQueueMessage(msg, sendResponse) {
  switch (msg.type) {
    case 'media:preview':
      preview(msg, sendResponse);
      return true;
    case 'queue:add':
      sendResponse({ id: addJob(msg.job || {}) });
      return true;
    case 'queue:list':
      sendResponse({ jobs: [...jobs.values()] });
      return true;
    case 'queue:cancel':
      cancel(msg.id);
      sendResponse({ ok: true });
      return true;
    case 'queue:retry':
      retry(msg.id);
      sendResponse({ ok: true });
      return true;
    case 'queue:log':
      sendResponse({ lines: logs.get(msg.id) || jobs.get(msg.id)?.logTail || [] });
      return true;
    case 'host:open':
      hostFileAction('open', msg.id);
      sendResponse({ ok: true });
      return true;
    case 'host:reveal':
      hostFileAction('reveal', msg.id);
      sendResponse({ ok: true });
      return true;
    case 'engine:check':
      engineCheck(sendResponse);
      return true;
    default:
      return false;
  }
}
