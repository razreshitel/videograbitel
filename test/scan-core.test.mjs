import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText, unescapeText, kindByExt, MAX_SCAN_ITEMS } from '../src/lib/scan-core.js';

const urls = (text) => scanText(text).map((x) => x.url);

test('unescapeText handles JSON and HTML escapes', () => {
  assert.equal(unescapeText('https:\\/\\/a.b\\/c?x=1\\u0026y=2'), 'https://a.b/c?x=1&y=2');
  assert.equal(unescapeText('&quot;a&quot; &amp;amp;'), '"a" &amp;');
});

test('kindByExt', () => {
  assert.equal(kindByExt('https://x/v.mp4?a=1'), 'direct');
  assert.equal(kindByExt('https://x/p.m3u8'), 'hls');
  assert.equal(kindByExt('https://x/p.mpd'), 'dash');
  assert.equal(kindByExt('https://x/opaque'), '');
});

test('finds media by extension anywhere in text', () => {
  const t = 'see <a href="https://cdn.x/v.mp4">x</a> and {"a":"https://cdn.x/live/master.m3u8"} https://cdn.x/d.mpd.';
  const r = scanText(t);
  assert.deepEqual(
    r.map((x) => [x.url, x.kind]),
    [
      ['https://cdn.x/v.mp4', 'direct'],
      ['https://cdn.x/live/master.m3u8', 'hls'],
      ['https://cdn.x/d.mpd', 'dash'],
    ],
  );
});

test('surfaces a media URL nested in another URL query', () => {
  assert.deepEqual(urls('https://a.com/play?src=https://b.com/v.mp4?t=1'), ['https://b.com/v.mp4?t=1']);
});

test('Gumroad-style props: image object skipped, video object kept', () => {
  const t =
    '<div data-props="{&quot;covers&quot;:[{&quot;url&quot;:&quot;https://files.x/png1&quot;,&quot;thumbnail&quot;:null,' +
    '&quot;id&quot;:&quot;a&quot;,&quot;type&quot;:&quot;image&quot;,&quot;filetype&quot;:&quot;png&quot;,&quot;width&quot;:670},' +
    '{&quot;url&quot;:&quot;https://files.x/vid1&quot;,&quot;original_url&quot;:&quot;https://files.x/vid1&quot;,' +
    '&quot;thumbnail&quot;:&quot;https://files.x/thumb1&quot;,&quot;id&quot;:&quot;b&quot;,&quot;type&quot;:&quot;video&quot;,' +
    '&quot;filetype&quot;:&quot;mp4&quot;}]}"></div>';
  const r = scanText(t);
  assert.deepEqual(r, [{ url: 'https://files.x/vid1', kind: '', source: 'json' }]);
});

test('escaped JSON slashes', () => {
  assert.deepEqual(urls('{"url":"https:\\/\\/cdn.x\\/v.mp4"}'), ['https://cdn.x/v.mp4']);
});

test('explicit video keys need no marker', () => {
  assert.deepEqual(urls('{"video_url":"https://x/abc","thumb":"https://x/t.jpg"}'), ['https://x/abc']);
  assert.deepEqual(urls("var cfg = { hlsUrl: 'https://x/live' };"), ['https://x/live']);
});

test('parent marker covers a nested src object', () => {
  assert.deepEqual(urls('{"type":"video","src":{"url":"https://x/inner"}}'), ['https://x/inner']);
});

test('marker from a sibling object does not leak', () => {
  const t = '[{"url":"https://x/a"},{"type":"video","url":"https://x/b"},{"url":"https://x/c","type":"image"}]';
  assert.deepEqual(urls(t), ['https://x/b']);
});

test('JSON-LD VideoObject contentUrl', () => {
  const t = '{"@type":"VideoObject","name":"n","thumbnailUrl":"https://x/t.jpg","contentUrl":"https://x/stream"}';
  assert.deepEqual(urls(t), ['https://x/stream']);
});

test('mime markers and audio count as media', () => {
  assert.deepEqual(urls('{"src":"https://x/1","mime_type":"video/mp4"}'), ['https://x/1']);
  assert.deepEqual(urls('{"file":"https://x/2","type":"audio"}'), ['https://x/2']);
  assert.deepEqual(urls('{"file":"https://x/3","type":"text"}'), []);
});

test('image extensions never qualify', () => {
  assert.deepEqual(urls('{"url":"https://x/p.png","type":"video"}'), []);
});

test('dedupes and caps the list', () => {
  const many = Array.from({ length: 70 }, (_, i) => `https://x/v${i % 60}.mp4`).join(' ');
  const r = scanText(many);
  assert.equal(r.length, MAX_SCAN_ITEMS);
  assert.equal(new Set(r.map((x) => x.url)).size, MAX_SCAN_ITEMS);
});

test('ignores non-http schemes', () => {
  assert.deepEqual(urls('{"url":"blob:https://x/abc","type":"video"} data:video/mp4;base64,AAAA'), []);
});
