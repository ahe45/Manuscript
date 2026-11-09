import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { BlockList, isIPv4, isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createAppDatabase } from './database.mjs';
import { createPdfDownload, writeCandidatePdfArchive } from './pdf.mjs';
import { layout, withinCellLimit } from './dist/layout.js';
import { koreanFontAsset } from './fonts.mjs';
import { createPdfQueue, PdfQueueError } from './pdf-queue.mjs';
import { candidateDetails, checkAdminPassword, createLoginThrottle, readWebAccess, webRequestOrigin } from './access.mjs';

const port = Number(process.env.PORT ?? 4174);
const profile = process.env.APP_PROFILE ?? 'local';
if (!['local', 'offline', 'web'].includes(profile) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('APP_PROFILE 또는 PORT 설정을 확인하세요.');
}
const webAccess = readWebAccess(process.env);
const lanHost = profile === 'local' ? process.env.LAN_HOST : undefined;
const lanSubnet = profile === 'local' ? process.env.LAN_SUBNET : undefined;
const lanClients = new BlockList();
if (lanHost || lanSubnet) {
  const [network, prefix] = (lanSubnet ?? '').split('/');
  const privateNetworks = new BlockList();
  privateNetworks.addSubnet('10.0.0.0', 8);
  privateNetworks.addSubnet('172.16.0.0', 12);
  privateNetworks.addSubnet('192.168.0.0', 16);
  if (!isIPv4(lanHost ?? '') || !privateNetworks.check(lanHost) || !isIPv4(network) ||
      !privateNetworks.check(network) || !/^(1[6-9]|2\d|3[0-2])$/.test(prefix ?? '')) {
    console.error('LAN_HOST와 LAN_SUBNET을 사설 IPv4 주소 및 /16~32 네트워크로 설정하세요.');
    process.exit(1);
  }
  lanClients.addSubnet(network, Number(prefix));
  if (!lanClients.check(lanHost)) {
    console.error('LAN_HOST가 LAN_SUBNET의 범위에 있어야 합니다.');
    process.exit(1);
  }
}
const candidateSecret = process.env.CANDIDATE_KEY_SECRET;

const sessionDuration = 12 * 60 * 60;
const sessions = new Map();
const adminSessions = new Map();
const loginThrottle = createLoginThrottle();
let activeAdminChecks = 0;
let hasLegacyDrafts = false;
let hasSavedAt = false;
const servers = new Set();
const queuePdf = createPdfQueue();
const queuePdfArchive = createPdfQueue({ concurrency: 1, maxWaiting: 0, runMs: 15 * 60 * 1000 });

const pool = createAppDatabase(process.env);
const adminPages = new Set(['/admin-home', '/setting', '/setting/', '/answer-downloads']);
const adminAnswerApis = new Set(['/api/admin/answers', '/api/admin/answers/export', '/api/admin/answers/pdf']);

const files = new Map([
  ['/manuscript.ico', ['../Manuscript.ico', 'image/vnd.microsoft.icon']],
  ['/login', ['login.html', 'text/html; charset=utf-8']],
  ['/login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/setting-login', ['setting-login.html', 'text/html; charset=utf-8']],
  ['/setting-login.js', ['setting-login.js', 'text/javascript; charset=utf-8']],
  ['/admin-home', ['admin-home.html', 'text/html; charset=utf-8']],
  ['/setting', ['setting.html', 'text/html; charset=utf-8']],
  ['/setting/', ['setting.html', 'text/html; charset=utf-8']],
  ['/answer-downloads', ['answer-downloads.html', 'text/html; charset=utf-8']],
  ['/answer-downloads.js', ['answer-downloads.js', 'text/javascript; charset=utf-8']],
  ['/download-menu.js', ['download-menu.js', 'text/javascript; charset=utf-8']],
  ['/manuscript', ['index.html', 'text/html; charset=utf-8']],
  ['/setting.js', ['setting.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/editor.js', ['editor.js', 'text/javascript; charset=utf-8']],
  ['/layout.js', ['layout.js', 'text/javascript; charset=utf-8']],
  ['/glyphs.js', ['glyphs.js', 'text/javascript; charset=utf-8']],
  ['/print.js', ['print.js', 'text/javascript; charset=utf-8']],
]);

function validCellLimit(limit) {
  return limit === null || (Number.isInteger(limit) && limit >= 1 && limit <= 10000);
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function redirect(response, location) {
  response.writeHead(303, { Location: location, 'Cache-Control': 'no-store' }).end();
}

function setSessionCookie(response, token, maxAge, admin = false) {
  const name = admin ? 'manuscript_admin' : 'manuscript_session';
  response.setHeader('Set-Cookie', `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${webAccess ? '; Secure' : ''}`);
}

function sessionToken(request) {
  return request.headers.cookie?.match(/(?:^|;\s*)manuscript_session=([a-f0-9]{64})(?:;|$)/)?.[1];
}

function currentSession(request) {
  const token = sessionToken(request);
  const session = sessions.get(token);
  if (!session || session.expiresAt > Date.now()) return session;
  sessions.delete(token);
}

function adminToken(request) {
  return request.headers.cookie?.match(/(?:^|;\s*)manuscript_admin=([a-f0-9]{64})(?:;|$)/)?.[1];
}

function isAdmin(request, local) {
  if (!webAccess && !local) return false;
  const token = adminToken(request);
  if ((adminSessions.get(token) ?? 0) > Date.now()) return true;
  adminSessions.delete(token);
  return false;
}

function loginKey(request, kind) {
  const forwarded = request.headers['x-forwarded-for'];
  const ip = webAccess && typeof forwarded === 'string' && isIP(forwarded) ? forwarded : request.socket.remoteAddress;
  return kind + ':' + ip;
}

async function adminLogin(request, response, local) {
  if (!webAccess && !local) {
    json(response, 403, { error: '설정은 서버 PC의 로컬 주소에서 변경할 수 있습니다.' });
    request.resume();
    return;
  }
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    json(response, 405, { error: '지원하지 않는 요청입니다.' });
    request.resume();
    return;
  }
  const key = loginKey(request, 'admin');
  if (loginThrottle.blocked(key, 8) || activeAdminChecks >= 4) {
    json(response, 429, { error: '잠시 후 관리자 로그인을 다시 시도해 주세요.' });
    request.resume();
    return;
  }
  const input = await readJson(request, response, 2048);
  if (response.writableEnded) return;
  if (activeAdminChecks >= 4) {
    json(response, 429, { error: '잠시 후 관리자 로그인을 다시 시도해 주세요.' });
    return;
  }
  activeAdminChecks++;
  try {
    const validPassword = webAccess ? await checkAdminPassword(webAccess.adminHash, input?.password) : input?.password === '1234';
    if (!validPassword) {
      loginThrottle.fail(key);
      json(response, 401, { error: '관리자 비밀번호를 확인해 주세요.' });
      return;
    }
  } finally {
    activeAdminChecks--;
  }
  loginThrottle.clear(key);
  const now = Date.now();
  for (const [token, expiry] of adminSessions) if (expiry <= now) adminSessions.delete(token);
  adminSessions.delete(adminToken(request));
  const token = randomBytes(32).toString('hex');
  adminSessions.set(token, now + 3600000);
  setSessionCookie(response, token, 3600, true);
  json(response, 200, { ok: true });
}

function candidateValues({ number, name, birthDate }) {
  return [number, name, birthDate];
}

async function migrateCandidateDrafts(candidate) {
  if (!hasLegacyDrafts) return;
  const key = createHmac('sha256', candidateSecret).update(JSON.stringify(candidate)).digest();
  const identity = candidateValues(candidate);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const legacy = await connection.query(
      'SELECT question_number FROM legacy_candidate_drafts WHERE candidate_key = ? FOR UPDATE', [key]
    );
    if (legacy.length) {
      await connection.query(
        'INSERT INTO candidate_drafts (candidate_number, candidate_name, birth_date, question_number, body, revision) ' +
        'SELECT ?, ?, ?, question_number, body, revision FROM legacy_candidate_drafts WHERE candidate_key = ? ' +
        'ON DUPLICATE KEY UPDATE candidate_number = VALUES(candidate_number)',
        [...identity, key]
      );
      await connection.query(
        'DELETE legacy FROM legacy_candidate_drafts AS legacy JOIN candidate_drafts AS draft ' +
        'ON draft.candidate_number = ? AND draft.candidate_name = ? AND draft.birth_date = ? ' +
        'AND draft.question_number = legacy.question_number AND draft.revision = legacy.revision ' +
        'AND BINARY draft.body = BINARY legacy.body WHERE legacy.candidate_key = ?',
        [...identity, key]
      );
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function login(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    json(response, 405, { error: '지원하지 않는 요청입니다.' });
    return;
  }
  const value = await readJson(request, response, 2048);
  if (response.writableEnded) return;
  const candidate = candidateDetails(value);
  const key = loginKey(request, 'candidate');
  if (webAccess && loginThrottle.blocked(key, 30)) {
    json(response, 429, { error: '잠시 후 로그인을 다시 시도해 주세요.' });
    return;
  }
  if (!candidate) {
    if (webAccess) loginThrottle.fail(key);
    json(response, 400, { error: '수험번호, 이름, 생년월일을 올바르게 입력해 주세요.' });
    return;
  }
  const { candidateNumberDigits } = await loadEditor();
  if (candidateNumberDigits !== null &&
      (candidate.number.length !== candidateNumberDigits || !/^[0-9]+$/.test(candidate.number))) {
    if (webAccess) loginThrottle.fail(key);
    json(response, 400, { error: `수험번호는 숫자 ${candidateNumberDigits}자리로 입력해 주세요.` });
    return;
  }

  await migrateCandidateDrafts(candidate);
  await pool.query(
    "INSERT INTO candidate_drafts (candidate_number, candidate_name, birth_date, body) VALUES (?, ?, ?, '') " +
    'ON DUPLICATE KEY UPDATE candidate_number = VALUES(candidate_number)',
    candidateValues(candidate)
  );
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(token);
  }
  sessions.delete(sessionToken(request));
  const token = randomBytes(32).toString('hex');
  const editorToken = randomBytes(24).toString('hex');
  sessions.set(token, { candidate, editorToken, expiresAt: now + sessionDuration * 1000 });
  if (webAccess) loginThrottle.clear(key);
  setSessionCookie(response, token, sessionDuration);
  json(response, 200, { ok: true });
}

async function readJson(request, response, maxBytes) {
  const contentType = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    json(response, 415, { error: 'JSON 요청만 지원합니다.' });
    request.resume();
    return;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) {
      json(response, 413, { error: '저장할 데이터가 너무 큽니다.' });
      request.resume();
      return;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
  } catch {
    json(response, 400, { error: '요청 데이터를 읽을 수 없습니다.' });
  }
}

async function loadEditor(session, question = 1) {
  const savedAt = hasSavedAt ? 'UNIX_TIMESTAMP(draft.saved_at) * 1000' : 'NULL';
  const draftFields = session ? ", COALESCE(draft.body, '') AS body, COALESCE(draft.revision, 0) AS revision, " + savedAt + ' AS savedAt' : '';
  const draftJoin = session ? ' LEFT JOIN candidate_drafts AS draft ON draft.candidate_number = ? ' +
    'AND draft.candidate_name = ? AND draft.birth_date = ? AND draft.question_number = ?' : '';
  const [row] = await pool.query(
    'SELECT title, columns_per_row AS columns, max_characters AS legacyMaxCharacters, ' +
    'candidate_number_digits AS candidateNumberDigits, question_titles AS questionTitles' + draftFields +
    ' FROM editor_state' + draftJoin + ' WHERE editor_state.id = 1',
    session ? [...candidateValues(session.candidate), question] : []
  );
  if (!row) throw new Error('원고지의 초기 데이터가 없습니다. db/schema.sql을 실행하세요.');
  const { legacyMaxCharacters, questionTitles: storedQuestions, ...settings } = row;
  const questions = typeof storedQuestions === 'string' ? JSON.parse(storedQuestions) : storedQuestions;
  const configuredQuestions = questions ?? ['문제 1'];
  // Old databases store just the titles and one shared limit.
  settings.questionTitles = configuredQuestions.map(entry => typeof entry === 'string' ? entry : entry.title);
  settings.questionMaxCharacters = configuredQuestions.map(entry =>
    typeof entry === 'string' ? legacyMaxCharacters : entry.maxCharacters);
  return session ? {
    ...settings, revision: Number(row.revision), savedAt: row.savedAt === null ? null : Number(row.savedAt),
    maxCharacters: settings.questionMaxCharacters[question - 1],
    question, candidate: session.candidate, editorToken: session.editorToken,
  } : settings;
}

async function saveSettings(request, response) {
  const settings = await readJson(request, response, 16384);
  if (response.writableEnded) return;
  if (!Number.isInteger(settings?.columns) || settings.columns < 5 || settings.columns > 40) {
    json(response, 400, { error: '한 행의 입력 칸 수를 5~40칸으로 설정하세요.' });
    return;
  }

  const { columns, candidateNumberDigits, questionTitles, questionMaxCharacters } = settings;
  if (!Array.isArray(questionTitles) || questionTitles.length < 1 ||
      questionTitles.length > 20 || questionTitles.some(title =>
        typeof title !== 'string' || title.length > 100 || !title.isWellFormed() || /\p{Cc}/u.test(title))) {
    json(response, 400, { error: '문제는 1~20개, 문제명은 100자 이내로 설정해 주세요.' });
    return;
  }
  if (!Array.isArray(questionMaxCharacters) || questionMaxCharacters.length !== questionTitles.length ||
      !questionMaxCharacters.every(validCellLimit)) {
    json(response, 400, { error: '문제별 글자 수를 1~10,000칸으로 설정하거나 비워 두세요.' });
    return;
  }
  if (candidateNumberDigits != null &&
      (!Number.isInteger(candidateNumberDigits) || candidateNumberDigits < 1 || candidateNumberDigits > 32)) {
    json(response, 400, { error: '수험번호 자리 수는 1~32 사이의 정수로 설정해 주세요.' });
    return;
  }
  let title;
  if (settings.title !== undefined) {
    title = typeof settings.title === 'string' ? settings.title.trim() : '';
    if (!title || title.length > 100 || !title.isWellFormed()) {
      json(response, 400, { error: '원고지 제목을 1~100자로 입력하세요.' });
      return;
    }
  }

  const questions = questionTitles.map((title, index) => ({
    title: title.trim() || `문제 ${index + 1}`,
    maxCharacters: questionMaxCharacters[index],
  }));
  await pool.query(
    'UPDATE editor_state SET title = COALESCE(?, title), columns_per_row = ?, ' +
    'candidate_number_digits = CASE WHEN ? THEN ? ELSE candidate_number_digits END, ' +
    'question_titles = ? WHERE id = 1',
    [title ?? null, columns, candidateNumberDigits !== undefined, candidateNumberDigits ?? null,
      JSON.stringify(questions)]
  );
  json(response, 200, await loadEditor());
}

async function saveDraft(request, response, session, editor) {
  if (request.headers['x-editor-session'] !== session.editorToken) {
    json(response, 409, { error: '로그인 정보가 바뀌었습니다. 입력한 내용을 복사한 뒤 원고지를 다시 열어 주세요.' });
    request.resume();
    return;
  }
  const draft = await readJson(request, response, 4 * 1024 * 1024);
  if (response.writableEnded) return;
  if (!draft || typeof draft.body !== 'string' || !draft.body.isWellFormed() ||
      !Number.isInteger(draft.revision) || draft.revision < 0 || draft.revision >= 0xffffffff) {
    json(response, 400, { error: '원고 데이터를 읽을 수 없습니다.' });
    return;
  }

  const { body, revision } = draft;
  const { question, columns, maxCharacters } = editor;
  if (maxCharacters !== null && !withinCellLimit(layout(body, columns, maxCharacters), maxCharacters)) {
    json(response, 400, { error: '최대 사용 칸 수를 초과했습니다. 원고를 줄인 뒤 저장해 주세요.' });
    return;
  }
  const identity = candidateValues(session.candidate);
  if (revision === 0) {
    await pool.query(
      "INSERT INTO candidate_drafts (candidate_number, candidate_name, birth_date, question_number, body) VALUES (?, ?, ?, ?, '') " +
      'ON DUPLICATE KEY UPDATE candidate_number = VALUES(candidate_number)',
      [...identity, question]
    );
  }
  const savedAt = hasSavedAt ? Date.now() : null;
  const saveTime = hasSavedAt ? ', saved_at = FROM_UNIXTIME(? / 1000)' : '';
  const result = await pool.query(
    'UPDATE candidate_drafts SET body = ?, revision = revision + 1' + saveTime + ' WHERE candidate_number = ? ' +
    'AND candidate_name = ? AND birth_date = ? AND question_number = ? AND revision = ?',
    [body, ...(hasSavedAt ? [savedAt] : []), ...identity, question, revision]
  );
  if (result.affectedRows === 1) {
    json(response, 200, { revision: revision + 1, savedAt });
    return;
  }

  const current = await loadEditor(session, question);
  if (current.body === body) {
    json(response, 200, { revision: current.revision, savedAt: current.savedAt });
  } else {
    json(response, 409, { error: '다른 탭에서 원고를 저장했습니다. 입력한 내용을 복사한 뒤 새로고침해 주세요.' });
  }
}

async function loadDownloadEditors(editor, candidate, body, mode) {
  const current = { ...editor, body, editorToken: undefined };
  if (mode === 'current') return [current];
  const rows = await pool.query(
    'SELECT question_number AS question, body FROM candidate_drafts ' +
    'WHERE candidate_number = ? AND candidate_name = ? AND birth_date = ? AND question_number BETWEEN 1 AND ?',
    [...candidateValues(candidate), editor.questionTitles.length]
  );
  const bodies = new Map(rows.map(row => [Number(row.question), row.body]));
  return editor.questionTitles.map((_, index) => {
    const question = index + 1;
    return question === editor.question ? current : {
      ...current, question, maxCharacters: editor.questionMaxCharacters[index], body: bodies.get(question) ?? '',
    };
  });
}

async function downloadDraft(request, response, session, editor) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    json(response, 405, { error: '지원하지 않는 요청입니다.' });
    request.resume();
    return;
  }
  if (request.headers['x-editor-session'] !== session.editorToken) {
    json(response, 409, { error: '로그인 정보가 바뀌었습니다. 원고지를 다시 열어 주세요.' });
    request.resume();
    return;
  }
  const draft = await readJson(request, response, 4 * 1024 * 1024);
  if (response.writableEnded) return;
  if (typeof draft?.body !== 'string' || !draft.body.isWellFormed()) {
    json(response, 400, { error: '원고 데이터를 읽을 수 없습니다.' });
    return;
  }
  const mode = draft.mode ?? 'current';
  if (!['current', 'individual', 'merged'].includes(mode)) {
    json(response, 400, { error: '다운로드 방식을 다시 선택해 주세요.' });
    return;
  }
  await sendPdfDownload(response, async signal => {
    const editors = await loadDownloadEditors(editor, session.candidate, draft.body, mode);
    signal.throwIfAborted();
    const overLimit = editors.find(({ body, maxCharacters }) => maxCharacters !== null &&
      !withinCellLimit(layout(body, editor.columns, maxCharacters), maxCharacters));
    if (overLimit) {
      throw new PdfQueueError(400, `${overLimit.question}번 문항이 최대 사용 칸 수를 초과했습니다. 원고를 줄인 뒤 다운로드해 주세요.`);
    }
    return createPdfDownload(editors, mode, signal);
  });
}

function attachmentHeader(filename) {
  const encodedName = encodeURIComponent(filename).replace(/['()*]/g, character =>
    '%' + character.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename*=UTF-8''${encodedName}`;
}

async function sendPdfDownload(response, task, enqueue = queuePdf) {
  const client = new AbortController();
  if (response.destroyed) return;
  const abort = () => client.abort();
  response.once('close', abort);
  try {
    const { bytes, file, filename, contentType } = await enqueue(task, client.signal);
    const size = bytes ? bytes.length : (await stat(file)).size;
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': attachmentHeader(filename),
      'Content-Length': size,
      'Cache-Control': 'no-store',
    });
    if (bytes) response.end(bytes);
    else await pipeline(createReadStream(file), response, { signal: client.signal });
  } catch (error) {
    if (response.destroyed) return;
    if (response.headersSent) {
      response.destroy();
      return;
    }
    if (error instanceof PdfQueueError) json(response, error.status, { error: error.message });
    else {
      console.error('PDF 생성 실패', error.name);
      json(response, 500, { error: 'PDF를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  } finally {
    response.removeListener('close', abort);
  }
}

const candidateSelect = 'candidate_number AS number, candidate_name AS name, DATE_FORMAT(birth_date, \'%Y-%m-%d\') AS birthDate';
const candidateOrder = ' ORDER BY candidate_number, candidate_name, birth_date';

function listAdminCandidates() {
  return pool.query('SELECT DISTINCT ' + candidateSelect + ' FROM candidate_drafts' + candidateOrder);
}

async function loadAdminAnswerEditors(candidate, settings) {
  const rows = await pool.query(
    'SELECT question_number AS question, body FROM candidate_drafts ' +
    'WHERE candidate_number = ? AND candidate_name = ? AND birth_date = ? ORDER BY question_number',
    candidateValues(candidate)
  );
  if (!rows.length) throw new PdfQueueError(404, '저장된 수험생을 찾을 수 없습니다.');
  const bodies = new Map(rows.map(({ question, body }) => [Number(question), body]));
  const questionTitles = [...settings.questionTitles];
  for (const question of bodies.keys()) questionTitles[question - 1] ??= `문제 ${question}`;
  const editors = [];
  questionTitles.forEach((_, index) => {
    const body = bodies.get(index + 1) ?? '';
    const limit = settings.questionMaxCharacters[index] ?? null;
    const maxCharacters = limit !== null && !withinCellLimit(layout(body, settings.columns, limit), limit) ? null : limit;
    editors.push({ ...settings, candidate, questionTitles, question: index + 1, body, maxCharacters });
  });
  return editors;
}

async function exportAdminAnswers(request, response) {
  const mode = new URL(request.url, 'http://localhost').searchParams.get('mode') ?? 'merged';
  if (mode !== 'individual' && mode !== 'merged') {
    json(response, 400, { error: '다운로드 방식을 다시 선택해 주세요.' });
    return;
  }
  let directory;
  let file;
  try {
    await sendPdfDownload(response, async signal => {
      const settings = await loadEditor();
      const candidates = await listAdminCandidates();
      if (!candidates.length) throw new PdfQueueError(404, '저장된 수험생이 없습니다.');
      if (candidates.length >= 65535) throw new PdfQueueError(413, '전체 답안지 ZIP의 파일 개수 한도를 초과했습니다.');
      directory = await mkdtemp(join(tmpdir(), 'manuscript-answers-'));
      file = join(directory, 'answers.zip');
      async function* groups() {
        for (const candidate of candidates) {
          signal.throwIfAborted();
          yield await loadAdminAnswerEditors(candidate, settings);
        }
      }
      await writeCandidatePdfArchive(groups(), file, mode, signal);
      const label = mode === 'individual' ? '개별' : '병합';
      return { file, filename: `전체-답안지-${label}.zip`, contentType: 'application/zip' };
    }, queuePdfArchive);
  } finally {
    if (file) await rm(file, { force: true });
    if (directory) await rmdir(directory);
  }
}

async function downloadAdminAnswer(request, response) {
  const input = await readJson(request, response, 4096);
  if (response.writableEnded) return;
  const candidate = candidateDetails(input);
  if (!candidate) {
    json(response, 400, { error: '수험생 정보를 확인해 주세요.' });
    return;
  }
  const mode = input.mode ?? 'merged';
  if (mode !== 'individual' && mode !== 'merged') {
    json(response, 400, { error: '다운로드 방식을 다시 선택해 주세요.' });
    return;
  }
  await sendPdfDownload(response, async signal => {
    const editors = await loadAdminAnswerEditors(candidate, await loadEditor());
    return createPdfDownload(editors, mode, signal);
  });
}

async function handleAdminAnswers(request, response, path, local) {
  if (!isAdmin(request, local)) {
    json(response, 403, { error: '관리자 비밀번호를 먼저 입력해 주세요.' });
    request.resume();
    return;
  }
  const method = path === '/api/admin/answers/pdf' ? 'POST' : 'GET';
  if (request.method !== method) {
    response.setHeader('Allow', method);
    json(response, 405, { error: '지원하지 않는 요청입니다.' });
    request.resume();
    return;
  }
  if (path === '/api/admin/answers/pdf') await downloadAdminAnswer(request, response);
  else if (path === '/api/admin/answers/export') await exportAdminAnswers(request, response);
  else json(response, 200, await listAdminCandidates());
}

async function handleApi(request, response, path, local) {
  if (path === '/api/login') {
    await login(request, response);
    return;
  }
  if (path === '/api/admin/login') {
    await adminLogin(request, response, local);
    return;
  }
  if (adminAnswerApis.has(path)) {
    await handleAdminAnswers(request, response, path, local);
    return;
  }
  const isDraft = path === '/api/draft' || path === '/api/pdf';
  const session = isDraft ? currentSession(request) : undefined;
  if (isDraft && !session) {
    json(response, 401, { error: '로그인 시간이 지났습니다. 입력한 내용을 복사한 뒤 다시 로그인해 주세요.' });
    request.resume();
    return;
  }
  let question = 1;
  let editor;
  if (session) {
    const requested = new URL(request.url, 'http://localhost').searchParams.get('question') ?? '1';
    question = /^[1-9]\d?$/.test(requested) ? Number(requested) : 0;
    if (question >= 1 && question <= 20) editor = await loadEditor(session, question);
    if (!editor || question > editor.questionTitles.length) {
      json(response, 404, { error: '설정된 문제를 찾을 수 없습니다.' });
      request.resume();
      return;
    }
  }
  if (path === '/api/pdf') {
    await downloadDraft(request, response, session, editor);
  } else if (request.method === 'GET') {
    json(response, 200, editor ?? {
      ...await loadEditor(),
      canEditSettings: isAdmin(request, local),
    });
  } else if (request.method === 'PUT') {
    if (session) await saveDraft(request, response, session, editor);
    else if (isAdmin(request, local)) await saveSettings(request, response);
    else {
      json(response, 403, { error: webAccess || local ? '설정 비밀번호를 먼저 입력해 주세요.' : '설정은 서버 PC의 로컬 주소에서 변경할 수 있습니다.' });
      request.resume();
    }
  } else {
    response.setHeader('Allow', 'GET, PUT');
    json(response, 405, { error: '지원하지 않는 요청입니다.' });
  }
}

try {
  await loadEditor();
  await pool.query('SELECT candidate_number, candidate_name, birth_date FROM candidate_drafts LIMIT 0');
  const [savedAt] = await pool.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'candidate_drafts' AND COLUMN_NAME = 'saved_at'"
  );
  hasSavedAt = Boolean(savedAt);
  const [legacy] = await pool.query(
    "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'legacy_candidate_drafts'"
  );
  hasLegacyDrafts = Boolean(legacy);
  if (hasLegacyDrafts && (!candidateSecret || candidateSecret.length < 32)) {
    throw new Error('기존 원고 이전에 필요한 CANDIDATE_KEY_SECRET이 없습니다.');
  }
} catch (error) {
  console.error('Manuscript DB를 불러오지 못했습니다.', error.code ?? error.message);
  await pool.end();
  process.exit(1);
}

async function handleRequest(request, response, local, requestOrigin) {
  const path = request.url?.split('?')[0];
  const isApi = adminAnswerApis.has(path) || ['/api/settings', '/api/draft', '/api/login', '/api/pdf', '/api/admin/login'].includes(path);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  try {
    if (webAccess && ['POST', 'PUT'].includes(request.method) && request.headers.origin !== requestOrigin) {
      json(response, 403, { error: '요청 출처를 확인할 수 없습니다.' });
      request.resume();
      return;
    }
    if (path === '/healthz' && request.method === 'GET') {
      await pool.query('SELECT 1');
      json(response, 200, { ok: true });
      return;
    }
    if (isApi) {
      await handleApi(request, response, path, local);
      return;
    }
    if (path === '/logout' && request.method === 'POST') {
      if (!webAccess && request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
        response.writeHead(403).end();
        return;
      }
      sessions.delete(sessionToken(request));
      setSessionCookie(response, '', 0);
      redirect(response, '/login');
      return;
    }
    if (path === '/admin-logout' && request.method === 'POST') {
      if (!webAccess && request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
        response.writeHead(403).end();
        return;
      }
      adminSessions.delete(adminToken(request));
      setSessionCookie(response, '', 0, true);
      redirect(response, '/login');
      return;
    }
    if (['GET', 'HEAD'].includes(request.method)) {
      if (adminPages.has(path) && !isAdmin(request, local)) {
        redirect(response, '/setting-login');
        return;
      }
      if (path === '/' || path === '/manuscript/') {
        redirect(response, currentSession(request) ? '/manuscript' : '/login');
        return;
      }
      if (path === '/manuscript' && !currentSession(request)) {
        redirect(response, '/login');
        return;
      }
    }
    const font = koreanFontAsset(path);
    const file = files.get(path);
    if ((!file && !font) || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end();
      return;
    }
    const [asset, contentType] = font ?? [new URL('./dist/' + file[0], import.meta.url), file[1]];
    const body = await readFile(asset);
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : body);
  } catch (error) {
    console.error(error.code ?? error.name);
    if (!response.headersSent && !response.destroyed) {
      if (isApi) json(response, 500, { error: '데이터베이스에 연결하지 못했습니다. 다시 시도해 주세요.' });
      else response.writeHead(500).end();
    }
  }
}

function listen(host, local) {
  const authority = `${host}:${port}`;
  const authorities = new Set(local ? [authority, `localhost:${port}`] : [authority]);
  const server = createServer((request, response) => {
    const requestOrigin = webAccess && webRequestOrigin(webAccess, request.headers);
    if ((webAccess ? !requestOrigin : !authorities.has(request.headers.host?.toLowerCase())) ||
        (!local && !lanClients.check(request.socket.remoteAddress ?? ''))) {
      response.writeHead(403, { 'Cache-Control': 'no-store' }).end();
      request.resume();
      return;
    }
    void handleRequest(request, response, local, requestOrigin);
  });
  servers.add(server);
  server.on('close', () => servers.delete(server));
  server.on('error', error => {
    servers.delete(server);
    console.error(`원고지 접속 주소를 열지 못했습니다 (${host}:${port}).`, error.code ?? error.name);
    if (local) {
      process.exitCode = 1;
      void pool.end();
    }
  });
  server.listen(port, host, () => {
    const address = 'http://' + authority;
    const entry = webAccess ? webAccess.origin ?? `HTTPS 프록시 연결 · ${address}` : address;
    console.log(`원고지 연습장 · ${entry}`);
    if (local && lanHost) listen(lanHost, false);
  });
}

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await Promise.all([...servers].map(server => new Promise(resolve => server.close(resolve))));
  await pool.end();
  if (process.connected) process.disconnect();
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
if (process.connected) {
  process.on('message', message => { if (message === 'shutdown') void shutdown(); });
  process.on('disconnect', () => void shutdown());
}
listen('127.0.0.1', true);
