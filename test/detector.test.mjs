import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, dispositionName, probeDetails, isSiteNoise } from '../src/background/detector.js';

const headers = (ct, len) => {
  const h = [];
  if (ct) h.push({ name: 'Content-Type', value: ct });
  if (len != null) h.push({ name: 'Content-Length', value: String(len) });
  return h;
};
const det = (url, opts = {}) => ({
  url,
  type: opts.type || 'xmlhttprequest',
  method: opts.method || 'GET',
  responseHeaders: headers(opts.ct, opts.len),
});

test('detects HLS by extension and content-type', () => {
  assert.equal(classify(det('https://x.com/a/playlist.m3u8')).kind, 'hls');
  assert.equal(classify(det('https://x.com/stream', { ct: 'application/vnd.apple.mpegurl' })).kind, 'hls');
});

test('detects DASH', () => {
  assert.equal(classify(det('https://x.com/a/manifest.mpd')).kind, 'dash');
});

test('detects a direct video file', () => {
  const r = classify(det('https://x.com/v.mp4', { type: 'media', ct: 'video/mp4', len: 5_000_000 }));
  assert.equal(r.kind, 'direct');
  assert.equal(r.container, 'mp4');
});

test('ignores stream segments', () => {
  assert.equal(classify(det('https://x.com/seg00001.ts')), null);
  assert.equal(classify(det('https://x.com/chunk.m4s')), null);
});

test('ignores non-GET (YouTube SABR is POST)', () => {
  assert.equal(classify(det('https://x.com/v.mp4', { method: 'POST', ct: 'video/mp4', len: 5_000_000 })), null);
});

test('ignores sub-50KB blobs even with a media name', () => {
  assert.equal(classify(det('https://x.com/v.mp4', { ct: 'video/mp4', len: 6000 })), null);
});

test('ignores UMP/protobuf chunk types', () => {
  assert.equal(classify(det('https://x.com/videoplayback', { ct: 'application/vnd.yt-ump' })), null);
});

test('ignores script endpoints mislabeled as media', () => {
  assert.equal(classify(det('https://x.com/remote_control.php', { ct: 'video/mp4', len: 5_000_000 })), null);
});

test('ignores opaque extensionless media names', () => {
  assert.equal(
    classify(det('https://x.com/Cu8HOny9tDgeXW6xDMr0-bl_mvt_eZxv-nSepKjO4Cs', { ct: 'video/mp4', len: 5_000_000 })),
    null,
  );
});

test('keeps recognizable extensionless media endpoints', () => {
  assert.equal(classify(det('https://x.com/videoplayback', { ct: 'video/mp4', len: 5_000_000 })).kind, 'direct');
});

test('ignores non-http and uninteresting resource types', () => {
  assert.equal(classify(det('data:video/mp4;base64,AAAA')), null);
  assert.equal(classify(det('https://x.com/v.mp4', { type: 'image', ct: 'video/mp4', len: 5_000_000 })), null);
});

test('page-scan hits may keep opaque names', () => {
  const d = det('https://x.com/Cu8HOny9tDgeXW6xDMr0-bl_mvt_eZxv-nSepKjO4Cs', { ct: 'video/mp4', len: 5_000_000 });
  assert.equal(classify(d, { trustName: true }).kind, 'direct');
});

test('dispositionName parses plain, quoted and RFC 5987 forms', () => {
  const h = (v) => [{ name: 'Content-Disposition', value: v }];
  assert.equal(dispositionName(h('inline; filename="Skate commercial.mp4"')), 'Skate commercial.mp4');
  assert.equal(dispositionName(h('attachment; filename=clip.webm')), 'clip.webm');
  assert.equal(dispositionName(h("inline; filename=\"x.mp4\"; filename*=UTF-8''%D0%92%D0%B8%D0%B4%D0%B5%D0%BE.mp4")), 'Видео.mp4');
  assert.equal(dispositionName(h('attachment; filename="../evil/name.mp4"')), 'name.mp4');
  assert.equal(dispositionName([]), '');
});

test('probeDetails prefers the Content-Range total', () => {
  const hdr = { 'content-type': 'video/mp4', 'content-length': '1', 'content-range': 'bytes 0-0/25656192' };
  const d = probeDetails('https://x.com/opaque', (n) => hdr[n] || null);
  assert.equal(d.type, 'media');
  const r = classify(d, { trustName: true });
  assert.equal(r.kind, 'direct');
  assert.equal(r.size, 25656192);
});

test('isSiteNoise: X reply GIFs only', () => {
  const page = 'https://x.com/FoxBoyJordy/status/2109801675204731331';
  assert.equal(isSiteNoise('https://video.twimg.com/tweet_video/HUe17UbWgAA43vh.mp4', page), true);
  assert.equal(isSiteNoise('https://video.twimg.com/tweet_video/HUe17UbWgAA43vh.mp4', 'https://x.com'), true);
  assert.equal(isSiteNoise('https://video.twimg.com/amplify_video/1/pl/a.m3u8', page), false);
  assert.equal(isSiteNoise('https://video.twimg.com/tweet_video/a.mp4', 'https://example.com/'), false);
  assert.equal(isSiteNoise('nope', page), false);
});
