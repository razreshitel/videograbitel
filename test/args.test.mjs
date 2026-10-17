import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { proxyArgs, localProxyAddr, usableProxy, headerArgs, safeName } from '../src/native-host/args.js';

test('proxyArgs accepts scheme URLs only', () => {
  assert.deepEqual(proxyArgs('http://u:p@127.0.0.1:8080'), ['--proxy', 'http://u:p@127.0.0.1:8080']);
  assert.deepEqual(proxyArgs('127.0.0.1:8080'), []);
  assert.deepEqual(proxyArgs(''), []);
});

test('localProxyAddr detects loopback proxies', () => {
  assert.deepEqual(localProxyAddr('http://u:p@127.0.0.1:48774'), { host: '127.0.0.1', port: 48774 });
  assert.deepEqual(localProxyAddr('socks5://localhost'), { host: 'localhost', port: 1080 });
  assert.equal(localProxyAddr('http://proxy.example.com:3128'), null);
  assert.equal(localProxyAddr('garbage'), null);
});

test('usableProxy falls back to direct when the local port is dead', async () => {
  const srv = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  const { port } = srv.address();
  assert.equal(await usableProxy(`http://u:p@127.0.0.1:${port}`), `http://u:p@127.0.0.1:${port}`);
  await new Promise((r) => srv.close(r));
  assert.equal(await usableProxy(`http://u:p@127.0.0.1:${port}`), null);
  assert.equal(await usableProxy(''), '');
  assert.equal(await usableProxy('http://proxy.example.com:3128'), 'http://proxy.example.com:3128');
});

test('headerArgs forwards browser headers and strips line breaks', () => {
  const args = headerArgs({
    referer: 'https://site.example/watch/1',
    userAgent: 'Mozilla/5.0 Test',
    origin: 'https://site.example',
    cookie: 'a=1;\r\nX-Evil: 1',
  });
  assert.deepEqual(args, [
    '--referer', 'https://site.example/watch/1',
    '--user-agent', 'Mozilla/5.0 Test',
    '--add-header', 'Origin:https://site.example',
    '--add-header', 'Cookie:a=1;X-Evil: 1',
  ]);
  assert.deepEqual(headerArgs({ referer: 'javascript:alert(1)' }), []);
  assert.deepEqual(headerArgs(null), []);
});

test('safeName: tidy page titles', () => {
  assert.equal(
    safeName('🦊 Jordy в X: «Just picked up Ace Combat 8 https://t.co/GpNUAt40Va» / X'),
    '🦊 Jordy в X - «Just picked up Ace Combat 8» - X',
  );
  assert.equal(safeName('a/b\\c?.mp4'), 'a_b_c_');
  assert.equal(safeName('100% done | Site'), '100_ done - Site');
  assert.equal(safeName('  ...  '), '');
  assert.equal(safeName('../../evil'), '_.._evil');
});
