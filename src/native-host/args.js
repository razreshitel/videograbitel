// Pure yt-dlp arg helpers.

import net from 'node:net';

export function proxyArgs(proxy) {
  const p = String(proxy || '').trim();
  return /^[a-z0-9.+-]+:\/\//i.test(p) ? ['--proxy', p] : [];
}

// Loopback proxy address, else null.
export function localProxyAddr(proxy) {
  try {
    const u = new URL(String(proxy || '').trim());
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) return null;
    const port = Number(u.port) || (/^https/i.test(u.protocol) ? 443 : u.protocol.startsWith('socks') ? 1080 : 80);
    return { host, port };
  } catch {
    return null;
  }
}

export function portOpen({ host, port }, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

// Dead local proxy -> direct.
export async function usableProxy(proxy) {
  const p = String(proxy || '').trim();
  if (!proxyArgs(p).length) return '';
  const addr = localProxyAddr(p);
  if (addr && !(await portOpen(addr))) return null;
  return p;
}

const clean = (v, max) => String(v || '').replace(/[\r\n\0]/g, '').trim().slice(0, max);

// Browser request headers.
export function headerArgs(h) {
  if (!h || typeof h !== 'object') return [];
  const out = [];
  const referer = clean(h.referer, 2000);
  const ua = clean(h.userAgent, 500);
  const origin = clean(h.origin, 500);
  const cookie = clean(h.cookie, 8000);
  if (/^https?:\/\//i.test(referer)) out.push('--referer', referer);
  if (ua) out.push('--user-agent', ua);
  if (/^https?:\/\//i.test(origin)) out.push('--add-header', `Origin:${origin}`);
  if (cookie) out.push('--add-header', `Cookie:${cookie}`);
  return out;
}
