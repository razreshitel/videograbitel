// Pure page-text scanner: media URLs a page knows about but may not have
// requested yet (carousel slides, player configs, JSON props, JSON-LD).

import { extOf } from './util.js';

const DIRECT_EXTS = new Set([
  'mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi', 'flv', 'ogv',
  'm4a', 'mp3', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'weba',
]);
const HLS_EXTS = new Set(['m3u8', 'm3u']);
const DASH_EXTS = new Set(['mpd']);
const SKIP_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'avif', 'ico', 'css', 'js', 'mjs', 'woff', 'woff2']);

export const MAX_SCAN_ITEMS = 40;

// 'hls' | 'dash' | 'direct' | ''
export function kindByExt(url) {
  const ext = extOf(url);
  if (HLS_EXTS.has(ext)) return 'hls';
  if (DASH_EXTS.has(ext)) return 'dash';
  if (DIRECT_EXTS.has(ext)) return 'direct';
  return '';
}

// JSON and HTML escapes -> plain text
export function unescapeText(s) {
  return String(s || '')
    .replace(/\\\//g, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// A nested "https://" ends the outer match so URL-in-query params surface too.
const URL_RE = /https?:\/\/(?:(?!https?:\/\/)[^\s"'<>\\`])+/g;
const TRAIL_RE = /[)\]},.;:!?]+$/;

const EXPLICIT_KEY_RE =
  /["']?(?:video_?url|videoURL|video_?src|mp4|mp4_?url|hls|hls_?url|hlsManifestUrl|dash_?url|dashManifestUrl|stream_?url|playback_?url|play_?url)["']?\s*:\s*["'](https?:[^"'\\]+)["']/gi;
const GENERIC_KEY_RE =
  /["']?(?:url|src|source|file|original_?url|content_?url|uri|href)["']?\s*:\s*["'](https?:[^"'\\]+)["']/gi;
const MARKER_SRC =
  `["'](?:@type|type|file_?type|kind|mime_?type|content_?type|mime|format|media_?type|resource_?type)["']\\s*:\\s*["']([^"']*)["']`;
const MARKER_AT = new RegExp(MARKER_SRC, 'iy');
const MARKER_ALL = new RegExp(MARKER_SRC, 'gi');
const VIDEO_VALUE_RE = /^(?:video(?:\/|$)|VideoObject$|audio(?:\/|$)|AudioObject$|mp4$|webm$|mov$|m4v$|m3u8$|mpd$|hls$|dash$|mp3$|m4a$)/i;

function cleanUrl(raw) {
  try {
    const u = new URL(raw.replace(TRAIL_RE, ''));
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

function markerAt(seg, i) {
  MARKER_AT.lastIndex = i;
  const m = MARKER_AT.exec(seg);
  return m ? m[1] : null;
}

// Nearest type-like key of the same object (or its parent), walking forward.
function markerForward(seg) {
  let inside = 0;
  let out = 0;
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (ch === '{') inside++;
    else if (ch === '}') {
      if (inside > 0) inside--;
      else if (++out > 1) return null;
    } else if ((ch === '"' || ch === "'") && inside === 0) {
      const v = markerAt(seg, i);
      if (v != null) return v;
    }
  }
  return null;
}

// Same, walking backward from the URL.
function markerBackward(seg) {
  const starts = new Map();
  for (const m of seg.matchAll(MARKER_ALL)) starts.set(m.index, m[1]);
  let inside = 0;
  let out = 0;
  for (let i = seg.length - 1; i >= 0; i--) {
    const ch = seg[i];
    if (ch === '}') inside++;
    else if (ch === '{') {
      if (inside > 0) inside--;
      else if (++out > 1) return null;
    } else if (inside === 0 && starts.has(i)) return starts.get(i);
  }
  return null;
}

function isVideoObject(text, start, end) {
  const fwd = markerForward(text.slice(end, end + 800));
  if (fwd != null) return VIDEO_VALUE_RE.test(fwd.trim());
  const back = markerBackward(text.slice(Math.max(0, start - 800), start));
  return back != null && VIDEO_VALUE_RE.test(back.trim());
}

/**
 * @returns {{url:string, kind:string, source:string}[]} deduped, capped
 */
export function scanText(raw) {
  const text = unescapeText(raw);
  const out = [];
  const seen = new Set();
  const add = (u, source) => {
    const url = cleanUrl(u);
    if (!url || seen.has(url) || SKIP_EXTS.has(extOf(url))) return false;
    seen.add(url);
    out.push({ url, kind: kindByExt(url), source });
    return out.length >= MAX_SCAN_ITEMS;
  };

  for (const m of text.matchAll(URL_RE)) {
    if (kindByExt(cleanUrl(m[0])) && add(m[0], 'ext')) return out;
  }
  for (const m of text.matchAll(EXPLICIT_KEY_RE)) {
    if (add(m[1], 'key')) return out;
  }
  for (const m of text.matchAll(GENERIC_KEY_RE)) {
    const start = m.index + m[0].indexOf(m[1]);
    const end = start + m[1].length;
    if (isVideoObject(text, start, end) && add(m[1], 'json')) return out;
  }
  return out;
}
