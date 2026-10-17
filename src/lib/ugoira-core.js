// Ugoira data validation (shared).

const MAX_FRAMES = 3000;
const FRAME_NAME = /^[\w-]{1,64}\.(jpe?g|png|gif|webp)$/i;

// Validated {zip, frames} or null.
export function cleanUgoira(u) {
  if (!u || typeof u !== 'object') return null;
  let zip;
  try {
    zip = new URL(String(u.zip || ''));
  } catch {
    return null;
  }
  if (zip.protocol !== 'https:' || !/(^|\.)pximg\.net$/i.test(zip.hostname)) return null;
  if (!Array.isArray(u.frames) || !u.frames.length || u.frames.length > MAX_FRAMES) return null;
  const frames = [];
  for (const f of u.frames) {
    const file = String(f?.file || '');
    const delay = Math.round(Number(f?.delay));
    if (!FRAME_NAME.test(file) || !Number.isFinite(delay) || delay < 0) return null;
    frames.push({ file, delay: Math.min(delay, 60000) });
  }
  return { zip: zip.href, frames };
}

// Total length, seconds.
export function ugoiraDuration(frames) {
  return (frames || []).reduce((s, f) => s + (Number(f.delay) || 0), 0) / 1000;
}
