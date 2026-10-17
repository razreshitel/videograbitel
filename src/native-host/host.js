// VideoGrabitel native messaging host.
// Chrome launches this (via videograbitel-host.bat) and talks to it over stdio using
// the native-messaging framing: a 4-byte little-endian length prefix + UTF-8 JSON.
// It bridges the extension to local yt-dlp + ffmpeg binaries. This lets
// VideoGrabitel handle YouTube and large files without any in-browser limits.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyArgs, usableProxy, headerArgs, safeName } from './args.js';
import { cleanUgoira, readZip, concatList, finalDelay, fetchBuffer } from './ugoira.js';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HOST_DIR, '..', '..');
const BIN = path.join(REPO_ROOT, 'bin');
const EXE = process.platform === 'win32' ? '.exe' : '';

// Prefer bundled binaries in bin/, fall back to whatever is on PATH.
function toolPath(name) {
  const local = path.join(BIN, name + EXE);
  return fs.existsSync(local) ? local : name;
}
const YTDLP = toolPath('yt-dlp');
const HAS_LOCAL_YTDLP = YTDLP !== 'yt-dlp';
const FFMPEG_DIR = fs.existsSync(path.join(BIN, 'ffmpeg' + EXE)) ? BIN : null;
// Deno lets yt-dlp solve YouTube's JS challenges (avoids 403s / missing formats).
const DENO = fs.existsSync(path.join(BIN, 'deno' + EXE)) ? path.join(BIN, 'deno' + EXE) : null;

// Shared yt-dlp args: UTF-8 output (Windows consoles default to the ANSI code
// page, which mangles non-Latin file names) plus our bundled JS runtime.
function jsRuntimeArgs() {
  return ['--encoding', 'utf-8', ...(DENO ? ['--js-runtimes', `deno:${DENO}`] : [])];
}

// The Downloads folder can be relocated (e.g. to another drive or OneDrive), so
// "homedir/Downloads" is only a guess. On Windows, read the real known-folder
// path from the registry; fall back to the guess, then the home folder.
function downloadsDir() {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync(
        'reg',
        [
          'query',
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
          '/v',
          '{374DE290-123F-4565-9164-39C4925E467B}',
        ],
        { encoding: 'utf8' },
      );
      const m = out.match(/REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m);
      if (m) {
        const p = m[1].replace(/%([^%]+)%/g, (_, v) => process.env[v] || `%${v}%`);
        if (fs.existsSync(p)) return p;
      }
    } catch {
      /* fall through to the heuristic */
    }
  }
  const d = path.join(os.homedir(), 'Downloads');
  return fs.existsSync(d) ? d : os.homedir();
}

// --- native messaging IO ----------------------------------------------------
function send(msg) {
  const json = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  process.stdout.write(Buffer.concat([header, json]));
}

let inbuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inbuf = Buffer.concat([inbuf, chunk]);
  while (inbuf.length >= 4) {
    const len = inbuf.readUInt32LE(0);
    // A sane request is tiny; a huge length means a corrupt/desynced stream.
    if (len > 64 * 1024 * 1024) {
      process.stderr.write('videograbitel-host: framing desync, aborting\n');
      process.exit(1);
    }
    if (inbuf.length < 4 + len) break;
    const body = inbuf.subarray(4, 4 + len);
    inbuf = inbuf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch {
      continue;
    }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));

// --- request handling -------------------------------------------------------
let current = null;
let cancelRequested = false;

// yt-dlp spawns ffmpeg as a child; proc.kill() leaves it orphaned on Windows.
// Kill the whole tree so nothing keeps holding the output file.
function killTree(proc) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F']);
    } catch {
      /* already gone */
    }
  } else {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

// Reveal a file in the OS file manager (selecting it), or open a folder.
function revealPath(p) {
  if (!p) return;
  let isDir = false;
  try {
    isDir = fs.statSync(p).isDirectory();
  } catch {
    /* path may be gone */
  }
  try {
    if (process.platform === 'win32') {
      if (isDir) spawn('explorer.exe', [p], { windowsHide: true });
      else spawn('explorer.exe', [`/select,${p}`], { windowsHide: true });
    } else if (process.platform === 'darwin') {
      spawn('open', isDir ? [p] : ['-R', p]);
    } else {
      spawn('xdg-open', [isDir ? p : path.dirname(p)]);
    }
  } catch {
    /* nothing we can do */
  }
}

// Open a file with its default application (no console window on Windows).
function openPath(p) {
  if (!p) return;
  try {
    if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', p], { windowsHide: true });
    else if (process.platform === 'darwin') spawn('open', [p]);
    else spawn('xdg-open', [p]);
  } catch {
    /* nothing we can do */
  }
}

function handle(msg) {
  switch (msg.action) {
    case 'ping':
      return ping();
    case 'preview':
      return preview(msg);
    case 'download':
      return download(msg);
    case 'cancel':
      cancelRequested = true;
      if (typeof current?.cancel === 'function') current.cancel();
      else killTree(current);
      return;
    case 'reveal':
      return revealPath(msg.file);
    case 'open':
      return openPath(msg.file);
    default:
      send({ type: 'error', message: `unknown action: ${msg.action}` });
  }
}

function probeTool(command, args) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    let proc;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    try {
      proc = spawn(command, args, { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already stopped */
      }
      finish(null);
    }, 2500);
    proc.stdout?.on('data', (d) => (output += d));
    proc.on('error', () => finish(null));
    proc.on('close', (code) => finish(code === 0 ? output.trim() || true : null));
  });
}

async function ping() {
  const [ytdlp, ffmpeg, deno] = await Promise.all([
    probeTool(YTDLP, ['--version']),
    probeTool(toolPath('ffmpeg'), ['-version']),
    probeTool(toolPath('deno'), ['--version']),
  ]);
  send({
    type: 'pong',
    ytdlp: typeof ytdlp === 'string' ? ytdlp : null,
    ffmpeg: !!ffmpeg,
    deno: !!deno,
    bin: BIN,
  });
}

// Fetch metadata only (no download) so the UI can show a preview first.
async function preview(msg) {
  const url = String(msg.url || '');
  if (!/^https?:\/\//i.test(url)) return send({ type: 'previewError', message: 'Invalid URL.' });
  const proxy = (await usableProxy(msg.proxy)) || '';

  let out = '';
  let err = '';
  let proc;
  try {
    proc = spawn(
      YTDLP,
      ['-J', '--no-playlist', '--no-warnings', ...proxyArgs(proxy), ...headerArgs(msg.headers), ...jsRuntimeArgs(), '--', url],
      { windowsHide: true },
    );
  } catch (e) {
    return send({ type: 'previewError', message: `Could not launch yt-dlp: ${e.message}` });
  }
  proc.stdout.on('data', (d) => (out += d));
  proc.stderr.on('data', (d) => (err += d));
  proc.on('error', (e) => send({ type: 'previewError', message: e.message }));
  proc.on('close', (code) => {
    if (code !== 0) {
      return send({ type: 'previewError', message: 'yt-dlp could not read this page.', detail: err.slice(-400) });
    }
    try {
      const info = JSON.parse(out);
      // Forward small fields only.
      send({
        type: 'preview',
        title: info.title || info.fulltitle || '',
        thumbnail: info.thumbnail || '',
        duration: info.duration || 0,
        uploader: info.uploader || info.channel || info.uploader_id || '',
        extractor: info.extractor_key || info.extractor || '',
        heights: summarizeHeights(info.formats),
      });
    } catch {
      send({ type: 'previewError', message: 'Could not parse the video info.' });
    }
  });
}

// Distinct video resolutions available, highest first.
function summarizeHeights(formats) {
  if (!Array.isArray(formats)) return [];
  const hs = new Set();
  for (const f of formats) {
    if (f && f.vcodec && f.vcodec !== 'none' && f.height) hs.add(f.height);
  }
  return [...hs].sort((a, b) => b - a).slice(0, 16);
}

// Force H.264 (avc1) video + AAC audio in an mp4. YouTube also serves VP9/AV1
// inside mp4 containers, which many players (incl. Windows' default) render as a
// grey screen with sound, so we match the *codec*, not just the container.
// avc1 caps at 1080p on YouTube; above that the chosen height falls back to
// whatever codec is available (may be VP9/AV1, as explicitly requested).
const QUALITY = {
  best: ['-f', 'bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1]/bv*+ba/b', '--merge-output-format', 'mp4'],
  audio: ['-x', '--audio-format', 'mp3'],
};

// 'best' | 'audio' | a numeric height ('1080', '720', '2160', …).
function qualityArgs(q) {
  if (q === 'audio') return QUALITY.audio;
  const h = parseInt(q, 10);
  if (Number.isFinite(h) && h > 0) {
    return [
      '-f',
      `bv*[height<=${h}][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=${h}][vcodec^=avc1]/bv*[height<=${h}]+ba/b[height<=${h}]`,
      '--merge-output-format',
      'mp4',
    ];
  }
  return QUALITY.best;
}

async function download(msg) {
  if (current) return send({ type: 'error', message: 'A download is already running.' });
  cancelRequested = false;

  const url = String(msg.url || '');
  if (!/^https?:\/\//i.test(url)) return send({ type: 'error', message: 'Invalid or missing URL.' });
  current = true; // busy during probe
  const proxy = await usableProxy(msg.proxy);
  current = null;
  if (cancelRequested) return send({ type: 'cancelled' });
  if (proxy === null) send({ type: 'log', line: '[videograbitel] proxy is offline, downloading directly' });

  const outDir = downloadsDir();
  if (msg.ugoira) return downloadUgoira(msg, proxy, outDir);
  // A user-renamed download uses that name as the output base; otherwise fall back
  // to yt-dlp's metadata title. Either way the name is sanitized and the root is
  // pinned with -P, so the (metadata- or user-) name can never steer the path.
  const custom = safeName(msg.filename);
  const nameTpl = custom ? `${custom}.%(ext)s` : '%(title).180B [%(id)s].%(ext)s';
  const args = [
    '--newline',
    '--no-playlist',
    '--no-mtime',
    '--retries',
    '10',
    '--fragment-retries',
    '10', // keep .part files (no --no-part) so a flaky download can resume
    '--windows-filenames', // sanitize reserved/invalid names so metadata can't steer the path
    '-P',
    outDir, // fixed download root, independent of the (metadata-driven) name template
    '-o',
    nameTpl,
    ...qualityArgs(msg.quality),
  ];
  if (msg.subs && msg.quality !== 'audio') {
    args.push('--embed-subs', '--write-auto-subs', '--sub-langs', 'en.*,en');
  }
  if (FFMPEG_DIR) args.push('--ffmpeg-location', FFMPEG_DIR);
  args.push(...proxyArgs(proxy));
  args.push(...headerArgs(msg.headers));
  args.push(...jsRuntimeArgs());
  args.push('--', url); // end-of-options: never treat the URL as a flag

  send({ type: 'started', url, outDir, ytdlp: YTDLP });

  let proc;
  try {
    proc = spawn(YTDLP, args, { windowsHide: true });
  } catch (e) {
    return send({ type: 'error', message: `Could not launch yt-dlp: ${e.message}` });
  }
  current = proc;

  let finalFile = null;
  let stderrTail = '';

  const onLine = (line) => {
    const pm = line.match(/\[download\]\s+([\d.]+)%/);
    if (pm) {
      const sp = line.match(/at\s+([\d.]+\s*\w+\/s)/);
      const eta = line.match(/ETA\s+([\d:]+)/);
      const total = line.match(/of\s+~?\s*([\d.]+\s*[KMGT]i?B)/i);
      send({
        type: 'progress',
        percent: parseFloat(pm[1]),
        speed: sp ? sp[1] : '',
        eta: eta ? eta[1] : '',
        total: total ? total[1].replace(/\s+/g, '') : '',
      });
    }
    // Report processing phases.
    const phase = line.match(/^\[(Merger|ExtractAudio|VideoConvertor|VideoRemuxer|Fixup\w*|Metadata|EmbedSubtitle)\]/);
    if (phase) send({ type: 'phase', name: phase[1] });
    const dest =
      line.match(/Merging formats into "(.+)"/) ||
      line.match(/\[ExtractAudio\] Destination:\s*(.+)\s*$/) ||
      line.match(/\[download\] Destination:\s*(.+)\s*$/);
    if (dest) finalFile = dest[1].replace(/"$/, '').trim();
    const already = line.match(/\[download\]\s+(.+?)\s+has already been downloaded/);
    if (already) finalFile = already[1].trim();
    // Clamp: a single multi-MB line would exceed Chrome's ~1MB message cap and
    // drop the whole connection mid-download.
    send({ type: 'log', line: line.length > 2000 ? `${line.slice(0, 2000)}…` : line });
  };

  lineStream(proc.stdout, onLine);
  lineStream(proc.stderr, (l) => {
    stderrTail = `${stderrTail}\n${l}`.slice(-2000);
    onLine(l);
  });

  proc.on('error', (e) => {
    current = null;
    const hint = HAS_LOCAL_YTDLP ? '' : ': yt-dlp not found. Run "npm run fetch-tools".';
    send({ type: 'error', message: `yt-dlp failed to start: ${e.message}${hint}` });
  });
  proc.on('close', (code) => {
    current = null;
    if (cancelRequested) send({ type: 'cancelled' });
    else if (code === 0) send({ type: 'done', file: finalFile, outDir });
    else send({ type: 'error', message: `yt-dlp exited with code ${code}.`, detail: stderrTail.trim() });
  });
}

// Pixiv ugoira: frame ZIP -> GIF.
async function downloadUgoira(msg, proxy, outDir) {
  const ugo = cleanUgoira(msg.ugoira);
  if (!ugo) return send({ type: 'error', message: 'Invalid ugoira data.' });
  const ffmpeg = toolPath('ffmpeg');
  const name = safeName(msg.filename) || `ugoira ${path.basename(new URL(ugo.zip).pathname, '.zip')}`;
  const outFile = uniquePath(outDir, name, '.gif');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'videograbitel-'));
  const ctrl = new AbortController();
  let proc = null;
  // Clean up before reporting: Chrome may kill us right after.
  const finish = (m) => {
    current = null;
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* leave it to the OS */
    }
    send(m);
  };
  current = {
    cancel() {
      ctrl.abort();
      killTree(proc);
    },
  };
  send({ type: 'started', url: ugo.zip, outDir });
  const headers = { Referer: 'https://www.pixiv.net/' };
  if (msg.headers?.userAgent) headers['User-Agent'] = String(msg.headers.userAgent).replace(/[\r\n]/g, '');
  const t0 = Date.now();
  const tunnel = /^http:\/\//i.test(proxy || '') ? proxy : '';
  if (proxy && !tunnel) send({ type: 'log', line: '[ugoira] only http:// proxies work here, downloading directly' });
  try {
    send({ type: 'log', line: `[ugoira] ${ugo.frames.length} frames from ${ugo.zip}` });
    const zip = await fetchBuffer(ugo.zip, {
      headers,
      proxy: tunnel,
      signal: ctrl.signal,
      onProgress: throttle((got, total) => {
        const secs = (Date.now() - t0) / 1000 || 1;
        send({
          type: 'progress',
          percent: total ? (got / total) * 100 : 0,
          total: total ? formatSize(total) : '',
          speed: `${formatSize(got / secs)}/s`,
          eta: '',
        });
      }),
    });
    const entries = readZip(zip);
    for (const f of ugo.frames) {
      const data = entries.get(f.file);
      if (!data) throw new Error(`frame ${f.file} missing from the zip`);
      fs.writeFileSync(path.join(tmp, f.file), data);
    }
    fs.writeFileSync(path.join(tmp, 'frames.txt'), concatList(ugo.frames));
    if (cancelRequested) throw new Error('cancelled');
    send({ type: 'phase', name: 'VideoConvertor' });
    const args = [
      '-hide_banner', '-loglevel', 'error', '-n',
      '-f', 'concat', '-safe', '0', '-i', path.join(tmp, 'frames.txt'),
      '-filter_complex', '[0:v]split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
      '-fps_mode', 'passthrough', '-loop', '0', '-final_delay', String(finalDelay(ugo.frames)),
      outFile,
    ];
    let errTail = '';
    const code = await new Promise((resolve, reject) => {
      proc = spawn(ffmpeg, args, { windowsHide: true });
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => (errTail = `${errTail}${d}`.slice(-2000)));
      proc.once('error', reject);
      proc.once('close', resolve);
    });
    if (cancelRequested) throw new Error('cancelled');
    if (code !== 0) throw new Error(`ffmpeg exited with code ${code}: ${errTail.trim()}`);
    finish({ type: 'done', file: outFile, outDir });
  } catch (e) {
    fs.rmSync(outFile, { force: true });
    if (cancelRequested) finish({ type: 'cancelled' });
    else finish({ type: 'error', message: `Ugoira download failed: ${e.message}`, detail: e.message });
  }
}

// First free "name (n).ext".
function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${base} (${n})${ext}`);
  return p;
}

function formatSize(n) {
  const u = ['B', 'KiB', 'MiB', 'GiB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 2 : 0)}${u[i]}`;
}

// At most every 250 ms.
function throttle(fn) {
  let last = 0;
  return (...a) => {
    const now = Date.now();
    if (now - last < 250) return;
    last = now;
    fn(...a);
  };
}

// Split trimmed lines.
function lineStream(stream, cb) {
  let acc = '';
  stream.setEncoding('utf8');
  stream.on('data', (d) => {
    acc += d;
    let i;
    while ((i = acc.search(/\r\n|\r|\n/)) >= 0) {
      const line = acc.slice(0, i);
      acc = acc.slice(i + (acc[i] === '\r' && acc[i + 1] === '\n' ? 2 : 1));
      if (line.trim()) cb(line);
    }
  });
  stream.on('end', () => {
    if (acc.trim()) cb(acc);
  });
}

send({ type: 'ready', platform: process.platform, ytdlp: HAS_LOCAL_YTDLP ? 'bundled' : 'path', ffmpeg: !!FFMPEG_DIR });
