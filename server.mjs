import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHmac, randomBytes } from 'node:crypto';
import { BlockList, isIPv4 } from 'node:net';
import mariadb from 'mariadb';
import { createPdfDownload } from './pdf.mjs';
import { layout } from './dist/layout.js';

const port = Number(process.env.PORT ?? 4174);
const lanHost = process.env.LAN_HOST;
const lanSubnet = process.env.LAN_SUBNET;
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
const { DB_HOST = '127.0.0.1', DB_PORT = '3306', DB_NAME = 'Manuscript', DB_USER, DB_PASSWORD } = process.env;
const candidateSecret = process.env.CANDIDATE_KEY_SECRET;

if (!DB_USER || !DB_PASSWORD) {
  console.error('.env 파일에 DB_USER와 DB_PASSWORD를 설정하세요.');
  process.exit(1);
}
const sessionDuration = 12 * 60 * 60;
const sessions = new Map();
let hasLegacyDrafts = false;
let activePdfJobs = 0;

const pool = mariadb.createPool({
  host: DB_HOST,
  port: Number(DB_PORT),
  database: DB_NAME,
  user: DB_USER,
  password: DB_PASSWORD,
  charset: 'utf8mb4',
  connectionLimit: 4,
  connectTimeout: 3000,
  acquireTimeout: 5000,
});

const files = new Map([
  ['/login', ['login.html', 'text/html; charset=utf-8']],
  ['/login.js', ['login.js', 'text/javascript; charset=utf-8']],
  ['/manuscript', ['index.html', 'text/html; charset=utf-8']],
  ['/setting', ['setting.html', 'text/html; charset=utf-8']],
  ['/setting/', ['setting.html', 'text/html; charset=utf-8']],
  ['/setting.js', ['setting.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/editor.js', ['editor.js', 'text/javascript; charset=utf-8']],
  ['/layout.js', ['layout.js', 'text/javascript; charset=utf-8']],
]);

function validSettings(value) {
  return value && Number.isInteger(value.columns) && value.columns >= 5 && value.columns <= 40 &&
    (value.maxCharacters === null ||
      (Number.isInteger(value.maxCharacters) && value.maxCharacters >= 1 && value.maxCharacters <= 10000));
}

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function redirect(response, location) {
  response.writeHead(303, { Location: location, 'Cache-Control': 'no-store' }).end();
}

function setSessionCookie(response, token, maxAge) {
  response.setHeader('Set-Cookie', `manuscript_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`);
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

function candidateDetails(value) {
  const number = typeof value?.number === 'string' ? value.number.trim().normalize() : '';
  const name = typeof value?.name === 'string' ? value.name.trim().normalize() : '';
  const birthDate = value?.birthDate;
  if (!/^[\p{L}\p{N}-]{1,32}$/u.test(number) || !name || name.length > 80 ||
      !name.isWellFormed() || /\p{Cc}/u.test(name) ||
      typeof birthDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) return;

  const [year, month, day] = birthDate.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (year < 1900 || date > new Date() || date.getFullYear() !== year ||
      date.getMonth() !== month - 1 || date.getDate() !== day) return;
  return { number, name, birthDate };
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
  if (!candidate) {
    json(response, 400, { error: '수험번호, 이름, 생년월일을 올바르게 입력해 주세요.' });
    return;
  }
  const { candidateNumberDigits } = await loadEditor();
  if (candidateNumberDigits !== null &&
      (candidate.number.length !== candidateNumberDigits || !/^[0-9]+$/.test(candidate.number))) {
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
  const draftFields = session ? ", COALESCE(draft.body, '') AS body, COALESCE(draft.revision, 0) AS revision" : '';
  const draftJoin = session ? ' LEFT JOIN candidate_drafts AS draft ON draft.candidate_number = ? ' +
    'AND draft.candidate_name = ? AND draft.birth_date = ? AND draft.question_number = ?' : '';
  const [row] = await pool.query(
    'SELECT title, columns_per_row AS columns, max_characters AS maxCharacters, ' +
    'candidate_number_digits AS candidateNumberDigits, question_titles AS questionTitles' + draftFields +
    ' FROM editor_state' + draftJoin + ' WHERE editor_state.id = 1',
    session ? [...candidateValues(session.candidate), question] : []
  );
  if (!row) throw new Error('원고지의 초기 데이터가 없습니다. db/schema.sql을 실행하세요.');
  if (row.questionTitles === null) row.questionTitles = ['문제 1'];
  else if (typeof row.questionTitles === 'string') row.questionTitles = JSON.parse(row.questionTitles);
  return session ? { ...row, revision: Number(row.revision), question, candidate: session.candidate, editorToken: session.editorToken } : row;
}

async function saveSettings(request, response) {
  const settings = await readJson(request, response, 16384);
  if (response.writableEnded) return;
  if (!validSettings(settings)) {
    json(response, 400, { error: '한 행은 5~40칸, 최대 글자 수는 1~10,000자 또는 제한 없음으로 설정하세요.' });
    return;
  }

  const { columns, maxCharacters, candidateNumberDigits } = settings;
  let questionTitles;
  if (settings.questionTitles !== undefined) {
    if (!Array.isArray(settings.questionTitles) || settings.questionTitles.length < 1 ||
        settings.questionTitles.length > 20 || settings.questionTitles.some(title =>
          typeof title !== 'string' || title.length > 100 || !title.isWellFormed() || /\p{Cc}/u.test(title))) {
      json(response, 400, { error: '문제는 1~20개, 문제명은 100자 이내로 설정해 주세요.' });
      return;
    }
    questionTitles = settings.questionTitles.map((title, index) => title.trim() || `문제 ${index + 1}`);
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

  await pool.query(
    'UPDATE editor_state SET title = COALESCE(?, title), columns_per_row = ?, max_characters = ?, ' +
    'candidate_number_digits = CASE WHEN ? THEN ? ELSE candidate_number_digits END, ' +
    'question_titles = COALESCE(?, question_titles) WHERE id = 1',
    [title ?? null, columns, maxCharacters, candidateNumberDigits !== undefined, candidateNumberDigits ?? null,
      questionTitles ? JSON.stringify(questionTitles) : null]
  );
  json(response, 200, { title, columns, maxCharacters, candidateNumberDigits, questionTitles });
}

async function saveDraft(request, response, session, question) {
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
  const identity = candidateValues(session.candidate);
  if (revision === 0) {
    await pool.query(
      "INSERT INTO candidate_drafts (candidate_number, candidate_name, birth_date, question_number, body) VALUES (?, ?, ?, ?, '') " +
      'ON DUPLICATE KEY UPDATE candidate_number = VALUES(candidate_number)',
      [...identity, question]
    );
  }
  const result = await pool.query(
    'UPDATE candidate_drafts SET body = ?, revision = revision + 1 WHERE candidate_number = ? ' +
    'AND candidate_name = ? AND birth_date = ? AND question_number = ? AND revision = ?',
    [body, ...identity, question, revision]
  );
  if (result.affectedRows === 1) {
    json(response, 200, { revision: revision + 1 });
    return;
  }

  const current = await loadEditor(session, question);
  if (current.body === body) {
    json(response, 200, { revision: current.revision });
  } else {
    json(response, 409, { error: '다른 탭에서 원고를 저장했습니다. 입력한 내용을 복사한 뒤 새로고침해 주세요.' });
  }
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
  if (activePdfJobs >= 2) {
    json(response, 503, { error: '다른 PDF를 생성 중입니다. 잠시 후 다시 시도해 주세요.' });
    return;
  }
  activePdfJobs++;
  try {
    const current = { ...editor, body: draft.body, editorToken: undefined };
    let editors = [current];
    if (mode !== 'current') {
      const rows = await pool.query(
        'SELECT question_number AS question, body FROM candidate_drafts ' +
        'WHERE candidate_number = ? AND candidate_name = ? AND birth_date = ? AND question_number BETWEEN 1 AND ?',
        [...candidateValues(session.candidate), editor.questionTitles.length]
      );
      const bodies = new Map(rows.map(row => [Number(row.question), row.body]));
      editors = editor.questionTitles.map((_, index) => {
        const question = index + 1;
        return question === editor.question ? current : { ...current, question, body: bodies.get(question) ?? '' };
      });
    }
    const overLimit = editor.maxCharacters !== null && editors.find(({ body }) =>
      layout(body, editor.columns, editor.maxCharacters).usedCells > editor.maxCharacters);
    if (overLimit) {
      json(response, 400, { error: `${overLimit.question}번 문항이 최대 사용 칸 수를 초과했습니다. 원고를 줄인 뒤 다운로드해 주세요.` });
      return;
    }
    const { bytes, filename, contentType } = await createPdfDownload(editors, mode);
    const encodedName = encodeURIComponent(filename).replace(/['()*]/g, character =>
      '%' + character.charCodeAt(0).toString(16).toUpperCase());
    response.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
    });
    response.end(bytes);
  } catch (error) {
    console.error('PDF 생성 실패', error.name);
    json(response, 500, { error: 'PDF를 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
  } finally {
    activePdfJobs--;
  }
}

async function handleApi(request, response, path, local) {
  if (path === '/api/login') {
    await login(request, response);
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
    json(response, 200, editor ?? { ...await loadEditor(), canEditSettings: local });
  } else if (request.method === 'PUT') {
    if (session) await saveDraft(request, response, session, question);
    else if (local) await saveSettings(request, response);
    else {
      json(response, 403, { error: '설정은 서버 PC의 로컬 주소에서 변경할 수 있습니다.' });
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

async function handleRequest(request, response, local) {
  const path = request.url?.split('?')[0];
  const isApi = ['/api/settings', '/api/draft', '/api/login', '/api/pdf'].includes(path);
  try {
    if (isApi) {
      await handleApi(request, response, path, local);
      return;
    }
    if (path === '/logout' && request.method === 'POST') {
      if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) {
        response.writeHead(403).end();
        return;
      }
      sessions.delete(sessionToken(request));
      setSessionCookie(response, '', 0);
      redirect(response, '/login');
      return;
    }
    if (['GET', 'HEAD'].includes(request.method)) {
      if (path === '/' || path === '/manuscript/') {
        redirect(response, currentSession(request) ? '/manuscript' : '/login');
        return;
      }
      if (path === '/manuscript' && !currentSession(request)) {
        redirect(response, '/login');
        return;
      }
    }
    if ((path === '/admin' || path === '/admin/') && ['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(308, { Location: '/setting' }).end();
      return;
    }
    const file = files.get(path);
    if (!file || !['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(404).end();
      return;
    }
    const body = await readFile(new URL('./dist/' + file[0], import.meta.url));
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
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
    if (!authorities.has(request.headers.host?.toLowerCase()) ||
        (!local && !lanClients.check(request.socket.remoteAddress ?? ''))) {
      response.writeHead(403, { 'Cache-Control': 'no-store' }).end();
      request.resume();
      return;
    }
    void handleRequest(request, response, local);
  });
  server.on('error', error => {
    console.error(`원고지 접속 주소를 열지 못했습니다 (${host}:${port}).`, error.code ?? error.name);
    if (local) {
      process.exitCode = 1;
      void pool.end();
    }
  });
  server.listen(port, host, () => {
    console.log(`원고지 연습장 · http://${authority}`);
    if (local && lanHost) listen(lanHost, false);
  });
}

listen('127.0.0.1', true);
