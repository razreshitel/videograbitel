// Pixiv ugoira helpers.

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import zlib from 'node:zlib';

export { cleanUgoira } from '../lib/ugoira-core.js';

// Entries of a stored/deflated ZIP.
export function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip entry');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, data);
    else if (method === 8) out.set(name, zlib.inflateRawSync(data));
    else throw new Error(`unsupported zip method ${method}`);
  }
  return out;
}

// ffconcat frame list.
export function concatList(frames) {
  const lines = ['ffconcat version 1.0'];
  for (const f of frames) lines.push(`file '${f.file}'`, `duration ${(f.delay / 1000).toFixed(3)}`);
  return lines.join('\n') + '\n';
}

// Last frame delay, cs.
export function finalDelay(frames) {
  return Math.max(1, Math.round((frames[frames.length - 1]?.delay ?? 100) / 10));
}

// HTTP CONNECT tunnel.
function connectTunnel(proxy, host, signal) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:443` };
    if (proxy.username) {
      const cred = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['Proxy-Authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
    }
    const req = http.request({
      host: proxy.hostname.replace(/^\[|\]$/g, ''),
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${host}:443`,
      headers,
      signal,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`proxy refused CONNECT (${res.statusCode})`));
      }
    });
    req.once('error', reject);
    req.end();
  });
}

// GET into a Buffer.
export async function fetchBuffer(url, { headers = {}, proxy = '', signal, onProgress } = {}) {
  const u = new URL(url);
  let createConnection;
  if (proxy) {
    const p = new URL(proxy);
    if (p.protocol !== 'http:') throw new Error(`only http:// proxies are supported here, got ${p.protocol}`);
    const socket = await connectTunnel(p, u.hostname, signal);
    createConnection = () => tls.connect({ socket, servername: u.hostname });
  }
  return new Promise((resolve, reject) => {
    const req = https.get(u, { headers, signal, agent: proxy ? false : undefined, createConnection }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP Error ${res.statusCode}${res.statusCode === 403 ? ': Forbidden' : ''}`));
        return;
      }
      const total = Number(res.headers['content-length']) || 0;
      const chunks = [];
      let got = 0;
      res.on('data', (c) => {
        chunks.push(c);
        got += c.length;
        onProgress?.(got, total);
      });
      res.once('end', () => resolve(Buffer.concat(chunks)));
      res.once('error', reject);
    });
    req.once('error', reject);
  });
}
