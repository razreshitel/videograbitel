// Pure, chrome-free helpers for the download queue. Kept separate from queue.js
// so they can be unit-tested without the extension runtime (see test/queue.test.mjs).

// A job moves: queued -> running -> postprocess -> done|error|cancelled.
export const ACTIVE_STATUSES = new Set(['queued', 'running', 'postprocess']);
export const TERMINAL_STATUSES = new Set(['done', 'error', 'cancelled']);

export function isActive(job) {
  return ACTIVE_STATUSES.has(job.status);
}
export function isTerminal(job) {
  return TERMINAL_STATUSES.has(job.status);
}

// How many more downloads may run, given a concurrency cap.
export function availableSlots(jobs, max) {
  const busy = jobs.filter((j) => j.status === 'running' || j.status === 'postprocess').length;
  return Math.max(0, max - busy);
}

// Which queued jobs should start now: oldest first, up to the free slots.
export function pickQueued(jobs, max) {
  const slots = availableSlots(jobs, max);
  if (slots <= 0) return [];
  return jobs
    .filter((j) => j.status === 'queued')
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .slice(0, slots);
}

// Jobs saved before a worker restart: running ones lost their host process.
export function restoreJobs(list) {
  const out = [];
  for (const j of Array.isArray(list) ? list : []) {
    if (!j?.id || !j.url) continue;
    out.push(isActive(j) ? { ...j, status: 'error', error: 'Interrupted. Press Retry.', endedAt: Date.now() } : j);
  }
  return out;
}
