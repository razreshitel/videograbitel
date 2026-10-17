import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { cleanUgoira, readZip, concatList, finalDelay } from '../src/native-host/ugoira.js';
import { ugoiraDuration } from '../src/lib/ugoira-core.js';

// Minimal zip writer for tests.
function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const { name, data, deflate } of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, body);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

test('readZip reads stored and deflated entries', () => {
  const a = Buffer.from('frame-a'.repeat(50));
  const b = Buffer.from('frame-b'.repeat(50));
  const zip = makeZip([
    { name: '000000.jpg', data: a },
    { name: '000001.jpg', data: b, deflate: true },
  ]);
  const out = readZip(zip);
  assert.deepEqual([...out.keys()], ['000000.jpg', '000001.jpg']);
  assert.ok(out.get('000000.jpg').equals(a));
  assert.ok(out.get('000001.jpg').equals(b));
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /not a zip/);
});

test('cleanUgoira accepts pixiv data and rejects anything else', () => {
  const good = {
    zip: 'https://i.pximg.net/img-zip-ugoira/img/2014/06/25/14/30/22/44298467_ugoira1920x1080.zip',
    frames: [
      { file: '000000.jpg', delay: 125 },
      { file: '000001.jpg', delay: 80.4 },
    ],
  };
  assert.deepEqual(cleanUgoira(good), {
    zip: good.zip,
    frames: [
      { file: '000000.jpg', delay: 125 },
      { file: '000001.jpg', delay: 80 },
    ],
  });
  assert.equal(cleanUgoira({ ...good, zip: 'https://evil.example/x.zip' }), null);
  assert.equal(cleanUgoira({ ...good, zip: 'http://i.pximg.net/x.zip' }), null);
  assert.equal(cleanUgoira({ ...good, frames: [{ file: '../x.jpg', delay: 10 }] }), null);
  assert.equal(cleanUgoira({ ...good, frames: [{ file: "a'.jpg", delay: 10 }] }), null);
  assert.equal(cleanUgoira({ ...good, frames: [] }), null);
  assert.equal(cleanUgoira(null), null);
});

test('concatList and finalDelay keep per-frame timing', () => {
  const frames = [
    { file: '000000.jpg', delay: 125 },
    { file: '000001.jpg', delay: 40 },
  ];
  assert.equal(
    concatList(frames),
    "ffconcat version 1.0\nfile '000000.jpg'\nduration 0.125\nfile '000001.jpg'\nduration 0.040\n",
  );
  assert.equal(finalDelay(frames), 4);
  assert.equal(finalDelay([{ file: 'a.jpg', delay: 0 }]), 1);
  assert.equal(ugoiraDuration(frames), 0.165);
});
