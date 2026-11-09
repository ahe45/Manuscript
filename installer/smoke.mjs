import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer, request } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createInterface } from 'node:readline';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { unzipSync, zipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { hashAdminPassword, issueCandidateCode } from '../access.mjs';

const exec = promisify(execFile);
const fixtureRoot = resolve(process.env.LOCALAPPDATA, 'Manuscript-Test');
const fixture = join(fixtureRoot, randomBytes(8).toString('hex'));
const stage = process.env.MANUSCRIPT_TEST_STAGE;
const install = stage ? resolve(stage) : join(fixture, 'installed');
const data = join(fixture, 'data');
const release = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const setup = resolve(process.argv[2] ?? `installer/output/Manuscript-${release.version}-Setup.exe`);
const openssl = process.env.MANUSCRIPT_TEST_OPENSSL ?? 'openssl.exe';
const appId = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{1AB84AB3-BD04-437C-AAB7-92952A7F785A}_is1';
const identity = { number: '0420', name: '설치 검증', birthDate: '2000-01-02' };
const savedBody = '오프라인에서 작성한 답안입니다.';
const loginBody = { ...identity };
const config = {
  title: 'Manuscript 테스트', columns: 20, candidateNumberDigits: null,
  questionTitles: ['첫 문항', '미작성 문항'], questionMaxCharacters: [40, 30],
};
let runtime;
let proxy;
let web;
let browser;
let installed = false;
let passed = false;
let desktopShortcut;

function launch(executable, args, options) {
  const child = spawn(executable, args, { windowsHide: true, ...options });
  let output = '';
  child.stdout?.on('data', value => output += value);
  child.stderr?.on('data', value => output += value);
  const done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  void done.catch(() => {});
  return { child, done, output: () => output };
}

async function startOffline() {
  runtime = launch(join(install, 'runtime/node/node.exe'), ['installer/runtime.mjs'], {
    cwd: install, env: { ...process.env, MANUSCRIPT_TEST_DATA: data },
  });
  const lines = createInterface({ input: runtime.child.stdout });
  runtime.lines = lines;
  const ready = new Promise(resolve => lines.on('line', line => {
    if (line.startsWith('READY ')) resolve(line.slice(6));
  }));
  return Promise.race([ready, runtime.done.then(() => { throw new Error(runtime.output()); })]);
}

async function maintenance(command, prefix) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const timeout = setTimeout(() => reject(new Error('Maintenance timeout: ' + runtime.output())), 60000);
  const line = value => {
    if (value.startsWith(prefix + ' ')) resolve(value.slice(prefix.length + 1));
    else if (value.startsWith('FAILED ') || value.startsWith('ERROR ')) reject(new Error(value));
  };
  runtime.lines.on('line', line);
  try {
    runtime.child.stdin.write(command + '\n');
    return await promise;
  } finally {
    clearTimeout(timeout);
    runtime.lines.off('line', line);
  }
}

async function stopOffline() {
  if (!runtime) return;
  if (runtime.child.exitCode === null) runtime.child.stdin.end('stop\n');
  const code = await runtime.done;
  assert.equal(code, 0, runtime.output());
  runtime = undefined;
}

async function checkDownloads(page) {
  for (const [label, name, pages] of [
    ['현재 문항', '0420_첫 문항.pdf', 1],
    ['전체(개별)', '0420.zip', null],
    ['전체(병합)', '0420.pdf', 2],
  ]) {
    await page.getByRole('button', { name: '다운로드', exact: true }).click();
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.getByRole('button', { name: label, exact: true }).click(),
    ]);
    assert.equal(download.suggestedFilename(), name);
    const bytes = await readFile(await download.path());
    if (pages === null) {
      const files = unzipSync(bytes);
      assert.deepEqual(Object.keys(files), ['0420_첫 문항.pdf', '0420_미작성 문항.pdf']);
      for (const pdf of Object.values(files)) assert.equal((await PDFDocument.load(pdf)).getPageCount(), 1);
    } else {
      const pdf = await PDFDocument.load(bytes);
      assert.equal(pdf.getPageCount(), pages);
      assert.ok(Math.abs(pdf.getPage(0).getWidth() - 842) < 1);
    }
  }
}

async function openDraft(context, url, credentials = loginBody) {
  const response = await context.request.post(url + '/api/login', { headers: { Origin: url }, data: credentials });
  assert.equal(response.status(), 200, await response.text());
  const page = await context.newPage();
  await page.goto(url + '/manuscript');
  await page.locator('#source:enabled').waitFor({ state: 'attached' });
  return page;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function checkWebProfile() {
  const settings = JSON.parse(await readFile(join(data, 'settings.json'), 'utf8'));
  const reservation = createHttpServer();
  const backendPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const key = join(fixture, 'test-key.pem');
  const cert = join(fixture, 'test-cert.pem');
  await exec(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', key, '-out', cert], { windowsHide: true });
  proxy = createHttpsServer({ key: await readFile(key), cert: await readFile(cert) }, (incoming, outgoing) => {
    const upstream = request({
      hostname: '127.0.0.1', port: backendPort, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, 'x-forwarded-proto': 'https', 'x-forwarded-for': incoming.socket.remoteAddress },
    }, response => {
      outgoing.writeHead(response.statusCode, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', () => outgoing.writeHead(502).end());
    incoming.pipe(upstream);
  });
  const url = 'https://127.0.0.1:' + await listen(proxy);
  const adminPassword = 'test-fixture-passphrase';
  const candidateSecret = randomBytes(32).toString('hex');
  web = launch(join(install, 'runtime/node/node.exe'), ['server.mjs'], {
    cwd: install,
    env: {
      ...process.env, APP_PROFILE: 'web', PUBLIC_ORIGIN: url, PORT: String(backendPort),
      ADMIN_PASSWORD_HASH: await hashAdminPassword(adminPassword), CANDIDATE_ACCESS_SECRET: candidateSecret,
      DB_HOST: '127.0.0.1', DB_PORT: String(settings.dbPort), DB_NAME: 'Manuscript',
      DB_USER: 'manuscript_app', DB_PASSWORD: settings.appPassword, PDF_BROWSER_CHANNEL: 'chrome',
    },
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, acceptDownloads: true });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const response = await context.request.get(url + '/healthz');
      if (response.ok()) { ready = true; break; }
      await delay(200);
    }
    assert.ok(ready, web.output());
    assert.equal((await fetch('http://127.0.0.1:' + backendPort + '/login')).status, 403);
    assert.equal((await context.request.put(url + '/api/settings', { headers: { Origin: url }, data: config })).status(), 403);
    assert.equal((await context.request.get(url + '/api/admin/answers')).status(), 403);
    assert.equal((await context.request.get(url + '/api/admin/answers/export')).status(), 403);
    assert.equal((await context.request.post(url + '/api/login', { headers: { Origin: url }, data: loginBody })).status(), 401);
    const adminPage = await context.newPage();
    assert.equal((await context.request.get(url + '/admin')).status(), 404);
    await adminPage.goto(url + '/login');
    await adminPage.getByRole('link', { name: '관리자', exact: true }).click();
    await adminPage.waitForURL('**/setting-login');
    await adminPage.locator('#admin-password').fill(adminPassword);
    await adminPage.getByRole('button', { name: '관리자 진입', exact: true }).click();
    await adminPage.waitForURL('**/admin-home');
    await adminPage.getByRole('link', { name: '답안지 다운로드' }).click();
    await adminPage.waitForURL('**/answer-downloads');
    await adminPage.locator('#answer-rows tr').first().waitFor();
    const exported = await context.request.get(url + '/api/admin/answers/export?mode=merged');
    assert.equal(exported.status(), 200);
    const archivedPdfs = unzipSync(await exported.body());
    assert.equal((await PDFDocument.load(archivedPdfs[identity.number + '.pdf'])).getPageCount(), 2);
    const individual = await context.request.get(url + '/api/admin/answers/export?mode=individual');
    assert.equal(individual.status(), 200);
    const individualPdfs = unzipSync(await individual.body());
    for (const title of config.questionTitles) {
      assert.equal((await PDFDocument.load(individualPdfs[`${identity.number}_${title}.pdf`])).getPageCount(), 1);
    }
    await adminPage.getByRole('link', { name: '관리자 메뉴' }).click();
    await adminPage.getByRole('link', { name: '원고지 설정' }).click();
    await adminPage.waitForURL('**/setting');
    assert.ok((await context.cookies()).find(cookie => cookie.name === 'manuscript_admin')?.secure);
    assert.equal((await context.request.put(url + '/api/settings', { headers: { Origin: url }, data: config })).status(), 200);
    const page = await openDraft(context, url, { ...loginBody, accessCode: issueCandidateCode(candidateSecret, identity) });
    assert.equal(await page.locator('#source').inputValue(), savedBody);
    assert.ok((await context.cookies()).find(cookie => cookie.name === 'manuscript_session')?.secure);
    assert.equal((await context.request.put(url + '/api/settings', { headers: { Origin: 'https://other.invalid' }, data: config })).status(), 403);
    await checkDownloads(page);
    const another = await browser.newContext({ ignoreHTTPSErrors: true });
    try {
      const other = { ...identity, number: '0421' };
      await openDraft(another, url, { ...other, accessCode: issueCandidateCode(candidateSecret, other) });
      const first = await (await context.request.get(url + '/api/draft')).json();
      const second = await (await another.request.get(url + '/api/draft')).json();
      assert.equal(second.body, '');
      const queue = (client, draft, mode) => client.request.post(url + '/api/pdf', {
        headers: { Origin: url, 'X-Editor-Session': draft.editorToken }, data: { body: draft.body, mode },
      });
      const concurrent = await Promise.all([queue(context, first, 'merged'), queue(another, second, 'current'), queue(context, first, 'individual')]);
      assert.deepEqual(concurrent.map(response => response.status()), [200, 200, 200]);
      assert.equal(concurrent[1].headers()['content-disposition'], "attachment; filename*=UTF-8''" + encodeURIComponent('0421_첫 문항.pdf'));
    } finally {
      await another.close();
    }
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await page.waitForURL('**/login');
    assert.equal((await context.request.get(url + '/api/draft')).status(), 401);
    console.log('HTTPS proxy, admin authorization, candidate code, and web downloads passed');
  } finally {
    await context.close();
    if (web.child.exitCode === null) web.child.kill();
    await web.done;
    web = undefined;
    await new Promise(resolve => proxy.close(resolve));
    proxy = undefined;
  }
}

try {
  if (!stage) {
    try {
      await exec('reg.exe', ['query', appId], { windowsHide: true });
      throw new Error('기존 Manuscript 설치가 있는 Windows 계정에서는 설치 검증을 실행할 수 없습니다.');
    } catch (error) {
      if (error.code !== 1) throw error;
    }
  }
  await mkdir(fixture, { recursive: true });
  if (!stage && process.env.MANUSCRIPT_TEST_SHORTCUT === '1') {
    const desktop = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Environment]::GetFolderPath("DesktopDirectory")'], { windowsHide: true });
    desktopShortcut = join(desktop.stdout.trim(), 'Manuscript.lnk');
    await assert.rejects(readFile(desktopShortcut), { code: 'ENOENT' }, 'Existing desktop shortcut must be preserved');
  }
  console.log('Fixture: ' + fixture);
  if (!stage) {
    const icons = desktopShortcut ? ['/TASKS=desktopicon'] : ['/NOICONS'];
    await exec(setup, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', ...icons, '/DIR=' + install], {
      windowsHide: true, timeout: 180000,
    });
    installed = true;
  }
  if (desktopShortcut) {
    const info = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $p=$env:MANUSCRIPT_TEST_LINK; ' +
      '$link=(New-Object -ComObject WScript.Shell).CreateShortcut($p); ' +
      '$item=(New-Object -ComObject Shell.Application).Namespace((Split-Path -Parent $p)).ParseName((Split-Path -Leaf $p)); ' +
      '$link.TargetPath; $link.IconLocation; $item.ExtendedProperty("System.AppUserModel.ID")'], {
      windowsHide: true, env: { ...process.env, MANUSCRIPT_TEST_LINK: desktopShortcut },
    });
    assert.deepEqual(info.stdout.trim().split(/\r?\n/), [join(install, 'Manuscript.exe'), join(install, 'Manuscript.exe') + ',0', 'UPlus.Manuscript']);
    console.log('Desktop shortcut target, EXE icon and taskbar AppUserModelID passed');
  }
  const url = await startOffline();
  const adminLogin = await fetch(url + '/api/admin/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '1234' }),
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = adminLogin.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(url + '/api/settings', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: adminCookie }, body: JSON.stringify(config),
  })).status, 200);

  await assert.rejects(readdir(join(install, 'runtime/browsers')), { code: 'ENOENT' });
  const { chromium } = await import('playwright-core');
  browser = await chromium.launch({ channel: 'chrome' });
  const context = await browser.newContext({ acceptDownloads: true });
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1'
    ? route.continue() : route.abort());
  let page = await openDraft(context, url);
  const ime = await context.newCDPSession(page);
  await ime.send('Input.imeSetComposition', { text: '한', selectionStart: 1, selectionEnd: 1 });
  await page.locator('#draft-status[data-state=saved]').waitFor();
  assert.equal((await (await context.request.get(url + '/api/draft')).json()).body, '한');
  await ime.send('Input.insertText', { text: savedBody });
  await ime.detach();
  await page.getByRole('button', { name: '다음 문제' }).click();
  await page.waitForURL('**/manuscript?question=2');
  const secondDraft = await (await context.request.get(url + '/api/draft?question=2')).json();
  assert.equal(secondDraft.maxCharacters, 30);
  assert.equal(secondDraft.body, '');
  const draft = await (await context.request.get(url + '/api/draft')).json();
  assert.equal(draft.maxCharacters, 40);
  assert.equal(draft.body, savedBody);
  assert.ok(draft.savedAt > 0);
  const tooLong = await context.request.put(url + '/api/draft', {
    headers: { 'X-Editor-Session': draft.editorToken },
    data: { body: '가'.repeat(45), revision: draft.revision },
  });
  assert.equal(tooLong.status(), 400);
  await page.getByRole('button', { name: '이전 문제' }).click();
  await page.waitForURL('**/manuscript?question=1');
  await page.locator('#source:enabled').waitFor({ state: 'attached' });
  const lastSaved = await page.locator('#last-saved').textContent();
  assert.match(lastSaved, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.waitForURL('**/login');
  page = await openDraft(context, url);
  assert.equal(await page.locator('#last-saved').textContent(), lastSaved);
  await checkDownloads(page);

  await page.route('**/api/draft', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 503, json: { error: '테스트 저장 실패' } }) : route.continue());
  await page.locator('#source').focus();
  await page.keyboard.insertText(' 확인');
  await page.getByRole('button', { name: '다운로드', exact: true }).click();
  await page.getByRole('button', { name: '현재 문항', exact: true }).click();
  const downloadError = page.locator('#download-status[data-state=error]');
  await downloadError.waitFor();
  assert.match(await downloadError.textContent(), /원고를 저장하지 못해/);
  assert.equal(await page.locator('#source').inputValue(), savedBody + ' 확인');
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.locator('#draft-status[data-state=error]').waitFor();
  assert.equal(new URL(page.url()).pathname, '/manuscript');
  await page.unroute('**/api/draft');
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.waitForURL('**/login');
  page = await openDraft(context, url);
  assert.equal(await page.locator('#source').inputValue(), savedBody + ' 확인');
  await page.locator('#source').fill(savedBody);
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.waitForURL('**/login');
  const backup = await maintenance('backup', 'BACKUP');
  assert.ok(backup.endsWith('.msbackup'));
  const files = unzipSync(await readFile(backup));
  assert.ok(files['database.sql'] && files['metadata.json']);
  const meta = JSON.parse(Buffer.from(files['metadata.json']).toString());
  assert.equal(meta.application, 'Manuscript');
  const tampered = join(fixture, 'tampered.msbackup');
  await writeFile(tampered, zipSync({
    ...files, 'metadata.json': Buffer.from(JSON.stringify({ ...meta, sha256: '0'.repeat(64) })),
  }));
  page = await openDraft(context, url);
  await page.locator('#source').fill('복원 전에 바꾼 답안');
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await page.waitForURL('**/login');
  const restore = path => 'restore ' + Buffer.from(path).toString('base64');
  await assert.rejects(maintenance(restore(tampered), 'RESTORED'), /손상된/);
  page = await openDraft(context, url);
  assert.equal(await page.locator('#source').inputValue(), '복원 전에 바꾼 답안');
  const safetyBackup = await maintenance(restore(backup), 'RESTORED');
  assert.notEqual(safetyBackup, backup);
  assert.ok((await readFile(safetyBackup)).length > 0);
  page = await openDraft(context, url);
  assert.equal(await page.locator('#source').inputValue(), savedBody);
  console.log('Backup, tamper rejection, pre-restore safety backup and answer restoration passed');
  await context.close();
  await stopOffline();
  console.log('Installed offline runtime, save-before-navigation, retry, cell limit, and all downloads passed');

  const settingsFile = join(data, 'settings.json');
  const previous = JSON.parse(await readFile(settingsFile, 'utf8'));
  await writeFile(settingsFile, JSON.stringify({ ...previous, schemaVersion: '0.0.0' }));
  const reopened = await startOffline();
  assert.ok((await readdir(join(data, 'backups'))).some(name => name.endsWith('.msbackup')));
  const fresh = await browser.newContext();
  page = await openDraft(fresh, reopened);
  assert.equal(await page.locator('#source').inputValue(), savedBody);
  assert.match(await page.locator('#last-saved').textContent(), /\d{4}-\d{2}-\d{2}/);
  await fresh.close();
  await checkWebProfile();
  await stopOffline();
  if (installed) {
    await exec(join(install, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { windowsHide: true, timeout: 120000 });
    installed = false;
  }
  if (desktopShortcut) await assert.rejects(readFile(desktopShortcut), { code: 'ENOENT' });
  assert.equal((await JSON.parse(await readFile(settingsFile, 'utf8'))).schemaVersion, release.version);
  assert.ok((await readdir(join(data, 'database'))).includes('manuscript'));
  console.log(stage ? 'Upgrade backup and restart passed' : 'Upgrade backup, restart, and data retention after uninstall passed');
  passed = true;
} finally {
  await browser?.close();
  if (runtime) {
    runtime.child.stdin.end('stop\n');
    await runtime.done.catch(() => {});
  }
  if (installed) {
    await exec(join(install, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'],
      { windowsHide: true, timeout: 120000 }).catch(() => {});
  }
  if (passed && fixture.startsWith(fixtureRoot + sep)) await rm(fixture, { recursive: true, force: true });
  else console.error('검증 실패 자료: ' + fixture);
}
