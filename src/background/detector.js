// Classifies an observed network response as downloadable media (or not).
// Pure logic so it can be unit-reasoned about independently of chrome.* APIs.

import { extOf } from '../lib/util.js';

// Direct, progressive media we can grab as-is.
const DIRECT_EXTS = new Set([
  'mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'flv', 'ogv',
  'm4a', 'mp3', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'weba',
]);
const SCRIPT_EXTS = new Set(['php', 'phtml', 'asp', 'aspx', 'jsp', 'cgi', 'pl']);

// Streaming manifests.
const HLS_EXTS = new Set(['m3u8', 'm3u']);
const DASH_EXTS = new Set(['mpd']);

// Per-segment stream artifacts.
const SEGMENT_EXTS = new Set(['ts', 'm4s', 'm4f', 'cmf', 'cmfv', 'cmfa', 'init', 'key', 'vtt']);

const HLS_CTYPES = new Set([
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
  'vnd.apple.mpegurl',
]);
const DASH_CTYPES = new Set(['application/dash+xml', 'video/vnd.mpeg.dash.mpd']);

// Content-types that mark a request as a stream *segment* (skip).
const SEGMENT_CTYPES = new Set([
  'video/mp2t',
  'video/iso.segment',
  'application/vnd.yt-ump', // YouTube SABR/UMP chunk container
  'application/x-protobuf', // SABR request/response framing
  'application/octet-stream', // ambiguous; only kept when the ext is clearly a full file
]);

// webRequest resource types worth inspecting.
const INTERESTING_TYPES = new Set(['media', 'xmlhttprequest', 'other', 'object', 'object_subrequest']);

function rawHeader(headers, name) {
  if (!headers) return '';
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h ? h.value || '' : '';
}
function headerValue(headers, name) {
  return rawHeader(headers, name).toLowerCase();
}

// Filename from Content-Disposition, or ''.
export function dispositionName(headers) {
  const cd = rawHeader(headers, 'content-disposition');
  if (!cd) return '';
  let name = '';
  const star = /filename\*\s*=\s*(?:utf-8|iso-8859-1)?'[^']*'([^;]+)/i.exec(cd);
  if (star) {
    try {
      name = decodeURIComponent(star[1].trim());
    } catch {
      name = star[1].trim();
    }
  } else {
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(cd);
    if (plain) name = (plain[1] ?? plain[2] ?? '').trim();
  }
  return name.split(/[\\/]/).pop().slice(0, 200);
}

// webRequest-shaped details from a probe (HEAD or ranged GET) response.
export function probeDetails(url, get) {
  const responseHeaders = [];
  const put = (name, value) => value && responseHeaders.push({ name, value: String(value) });
  put('content-type', get('content-type'));
  const total = /\/\s*(\d+)\s*$/.exec(get('content-range') || '');
  put('content-length', total ? total[1] : get('content-length'));
  put('content-disposition', get('content-disposition'));
  return { url, type: 'media', method: 'GET', responseHeaders };
}

export function isNoisyDirectUrl(url) {
  try {
    const name = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    const ext = extOf(url);
    if (SCRIPT_EXTS.has(ext)) return true;
    return (
      !ext &&
      name.length >= 32 &&
      /^[a-z0-9_-]+$/i.test(name) &&
      /[a-z]/.test(name) &&
      /[A-Z]/.test(name) &&
      /\d/.test(name)
    );
  } catch {
    return false;
  }
}

// Media that belongs to other posts on the page, not the page's own video.
export function isSiteNoise(url, pageUrl) {
  try {
    const u = new URL(url);
    const page = new URL(pageUrl).hostname.replace(/^(www|mobile)\./, '');
    // X: reply GIFs; the main post comes via yt-dlp
    if ((page === 'x.com' || page === 'twitter.com') && u.hostname === 'video.twimg.com') {
      return /^\/tweet_video\//.test(u.pathname);
    }
  } catch {
    /* bad URL */
  }
  return false;
}

/**
 * @param {{trustName?: boolean}} opts trustName: URL came from page markup, skip the opaque-name filter
 * @returns {null | {kind:'hls'|'dash'|'direct', container:string, contentType:string, size:number}}
 */
export function classify(details, opts = {}) {
  const { url, type, method } = details;
  if (!url || !/^https?:/i.test(url)) return null;
  // Real media is delivered over GET. YouTube's SABR streams it over POST, so
  // skipping non-GET drops that (and similar push-style) noise wholesale.
  if (method && method !== 'GET') return null;
  if (type && !INTERESTING_TYPES.has(type)) return null;

  const ext = extOf(url);
  const ctypeRaw = headerValue(details.responseHeaders, 'content-type');
  const ctype = ctypeRaw.split(';')[0].trim();
  const size = Number(headerValue(details.responseHeaders, 'content-length')) || 0;

  // --- streaming manifests -------------------------------------------------
  if (HLS_EXTS.has(ext) || HLS_CTYPES.has(ctype)) {
    return { kind: 'hls', container: 'm3u8', contentType: ctype, size };
  }
  if (DASH_EXTS.has(ext) || DASH_CTYPES.has(ctype)) {
    return { kind: 'dash', container: 'mpd', contentType: ctype, size };
  }

  // --- explicit stream segments: ignore ------------------------------------
  if (SEGMENT_EXTS.has(ext)) return null;
  if (SEGMENT_CTYPES.has(ctype) && !DIRECT_EXTS.has(ext)) return null;

  // --- direct progressive media -------------------------------------------
  const looksMedia =
    DIRECT_EXTS.has(ext) ||
    ctype.startsWith('video/') ||
    (ctype.startsWith('audio/') && !ctype.includes('mpegurl'));

  if (looksMedia) {
    if (!opts.trustName && !DIRECT_EXTS.has(ext) && isNoisyDirectUrl(url)) return null;
    // A standalone media file worth listing is essentially never < 50 KB. This
    // drops ad creatives, range chunks and SABR probes that carry a video/*
    // type (or even a .mp4 name) but are only a few KB.
    if (size && size < 50 * 1024) return null;
    const container = DIRECT_EXTS.has(ext) ? ext : ctype.split('/')[1] || 'bin';
    return { kind: 'direct', container, contentType: ctype, size };
  }

  return null;
}
