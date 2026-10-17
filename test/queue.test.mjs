import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isActive, isTerminal, availableSlots, pickQueued, restoreJobs } from '../src/background/queue-core.js';

const job = (over) => ({ id: 'x', status: 'queued', createdAt: 0, endedAt: 0, ...over });

test('isActive / isTerminal partition the statuses', () => {
  for (const s of ['queued', 'running', 'postprocess']) {
    assert.equal(isActive(job({ status: s })), true);
    assert.equal(isTerminal(job({ status: s })), false);
  }
  for (const s of ['done', 'error', 'cancelled']) {
    assert.equal(isActive(job({ status: s })), false);
    assert.equal(isTerminal(job({ status: s })), true);
  }
});

test('availableSlots counts only running/postprocess against the cap', () => {
  const jobs = [
    job({ status: 'running' }),
    job({ status: 'postprocess' }),
    job({ status: 'queued' }),
    job({ status: 'done' }),
  ];
  assert.equal(availableSlots(jobs, 2), 0);
  assert.equal(availableSlots(jobs, 3), 1);
  assert.equal(availableSlots([], 2), 2);
});

test('pickQueued returns oldest queued jobs up to free slots', () => {
  const jobs = [
    job({ id: 'r', status: 'running' }),
    job({ id: 'q2', status: 'queued', createdAt: 20 }),
    job({ id: 'q1', status: 'queued', createdAt: 10 }),
    job({ id: 'q3', status: 'queued', createdAt: 30 }),
  ];
  // 1 slot free (cap 2, one running) -> only the oldest queued
  assert.deepEqual(pickQueued(jobs, 2).map((j) => j.id), ['q1']);
  // 3 slots free
  assert.deepEqual(pickQueued(jobs, 4).map((j) => j.id), ['q1', 'q2', 'q3']);
});

test('pickQueued returns nothing when full', () => {
  const jobs = [job({ status: 'running' }), job({ status: 'running' }), job({ status: 'queued' })];
  assert.deepEqual(pickQueued(jobs, 2), []);
});

test('restoreJobs marks unfinished jobs interrupted', () => {
  const out = restoreJobs([job({ id: 'a', url: 'u', status: 'running' }), job({ id: 'b', url: 'u', status: 'done' }), { id: 'c' }, null]);
  assert.deepEqual(out.map((j) => [j.id, j.status]), [['a', 'error'], ['b', 'done']]);
});
