import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import {
  candidateDetails, checkCandidateCode, checkAdminPassword, createLoginThrottle, hashAdminPassword,
  issueCandidateCode, readWebAccess, webRequestOrigin,
} from './access.mjs';
import { createPdfQueue } from './pdf-queue.mjs';
import { layout, visibleCellCount, withinCellLimit } from './dist/layout.js';

test('web profile requires HTTPS and dedicated credentials', async () => {
  assert.equal(readWebAccess({}), null);
  const hash = await hashAdminPassword('fixture password');
  assert.equal(await checkAdminPassword(hash, 'fixture password'), true);
  assert.equal(await checkAdminPassword(hash, 'wrong password'), false);
  const env = {
    APP_PROFILE: 'web', PUBLIC_ORIGIN: 'https://example.test',
    ADMIN_PASSWORD_HASH: hash, CANDIDATE_ACCESS_SECRET: 'x'.repeat(32),
  };
  assert.equal(readWebAccess(env).host, 'example.test');
  assert.throws(() => readWebAccess({ ...env, PUBLIC_ORIGIN: 'http://example.test' }));
  assert.throws(() => readWebAccess({ ...env, PUBLIC_ORIGIN: 'https://example.test/path' }));
  assert.throws(() => readWebAccess({ ...env, ADMIN_PASSWORD_HASH: '' }));
});

test('new administrator passwords accept 4 to 20 characters', async () => {
  for (const password of ['1234', '가'.repeat(20)]) {
    assert.equal(await checkAdminPassword(await hashAdminPassword(password), password), true);
  }
  for (const password of ['123', '가'.repeat(21)]) {
    await assert.rejects(hashAdminPassword(password), /4~20자/);
  }
});

test('web profile can use the HTTPS proxy host without a configured public origin', () => {
  const env = {
    APP_PROFILE: 'web', ADMIN_PASSWORD_HASH: '0'.repeat(32) + ':' + '1'.repeat(64),
    CANDIDATE_ACCESS_SECRET: 'x'.repeat(32),
  };
  const access = readWebAccess(env);
  const headers = { host: 'Manuscript.example.test:443', 'x-forwarded-proto': 'https' };
  assert.equal(webRequestOrigin(access, headers), 'https://manuscript.example.test');
  assert.equal(webRequestOrigin(access, { host: headers.host }), undefined);
  assert.equal(webRequestOrigin(access, { ...headers, host: 'other.test@manuscript.example.test' }), undefined);
  assert.equal(webRequestOrigin(access, { ...headers, host: 'manuscript.example.test/path' }), undefined);
  assert.equal(webRequestOrigin(access, { ...headers, host: 'manuscript.example.test:8443' }), 'https://manuscript.example.test:8443');
  assert.equal(webRequestOrigin(readWebAccess({ ...env, PUBLIC_ORIGIN: 'https://only.example.test' }), headers), undefined);
});

test('candidate code is bound to normalized candidate identity', () => {
  const secret = 'x'.repeat(32);
  const candidate = candidateDetails({ number: ' 0001 ', name: ' 한글 ', birthDate: '2000-01-01' });
  const code = issueCandidateCode(secret, candidate);
  assert.equal(checkCandidateCode(secret, candidate, code.toLowerCase()), true);
  assert.equal(checkCandidateCode(secret, { ...candidate, number: '0002' }, code), false);
  assert.equal(checkCandidateCode(secret, candidate, ''), false);
  assert.equal(candidateDetails({ ...candidate, birthDate: '2000-02-31' }), undefined);
});

test('login throttle expires and clears failures', () => {
  const throttle = createLoginThrottle(100);
  throttle.fail('admin', 0);
  throttle.fail('admin', 10);
  assert.equal(throttle.blocked('admin', 2, 99), true);
  assert.equal(throttle.blocked('admin', 2, 100), false);
  throttle.fail('admin', 110);
  throttle.clear('admin');
  assert.equal(throttle.blocked('admin', 1, 110), false);
});

test('PDF queue starts waiting jobs in order and rejects overload', async () => {
  const enqueue = createPdfQueue({ concurrency: 1, maxWaiting: 1 });
  const started = [];
  const first = Promise.withResolvers();
  const active = enqueue(() => { started.push(1); return first.promise; });
  const waiting = enqueue(() => { started.push(2); return 'second'; });
  await assert.rejects(enqueue(() => 'overflow'), { status: 503 });
  assert.deepEqual(started, [1]);
  first.resolve('first');
  assert.deepEqual(await Promise.all([active, waiting]), ['first', 'second']);
  assert.deepEqual(started, [1, 2]);
});

test('PDF queue removes aborted waiters and aborts long jobs', async () => {
  const enqueue = createPdfQueue({ concurrency: 1, maxWaiting: 1, runMs: 25 });
  const active = enqueue(signal => delay(1000, null, { signal }));
  const client = new AbortController();
  const waiting = enqueue(() => assert.fail('canceled job started'), client.signal);
  client.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  const next = enqueue(() => 'ready');
  await assert.rejects(active, { status: 504 });
  assert.equal(await next, 'ready');
});

test('shared cell limits apply to drafts and print grids', () => {
  const body = layout('“가나다.”', 5, 5);
  assert.equal(withinCellLimit(body, 5), false);
  assert.equal(withinCellLimit(body, 6), true);
  assert.equal(visibleCellCount(body, 5, 5), 5);
  assert.equal(visibleCellCount(layout(''), 20, null), 200);
});
