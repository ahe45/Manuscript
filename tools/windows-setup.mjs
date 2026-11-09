import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import { clearLine, cursorTo, moveCursor } from 'node:readline';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseEnv } from 'node:util';
import { adminPasswordRange, hashAdminPassword, readWebAccess, validNewAdminPassword } from '../access.mjs';

const envPath = '.env';
const validHash = value => /^[a-f0-9]{32}:[a-f0-9]{64}$/i.test(value ?? '');
const validSecret = value => (value?.length ?? 0) >= 32;
const validPort = value => /^\d+$/.test(value ?? '') && Number(value) >= 1 && Number(value) <= 65535;

function envLine(key, value) {
  for (const encoded of [value, `'${value}'`, `"${value}"`, '\x60' + value + '\x60']) {
    const line = `${key}=${encoded}`;
    const parsed = parseEnv(line);
    if (parsed[key] === value && Object.keys(parsed).length === 1) return line;
  }
  throw new Error(`${key}에 .env로 저장할 수 없는 문자가 있습니다.`);
}

async function promptForSettings(env, set) {
  if (validPort(env.DB_PORT) && env.DB_USER && env.DB_PASSWORD && validHash(env.ADMIN_PASSWORD_HASH)) return;
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('처음 설정할 때는 명령 프롬프트에서 start.bat을 직접 실행하세요.');

  let masked = false;
  const output = new Writable({
    write(chunk, encoding, done) {
      stdout.write(chunk, encoding, done);
    },
  });
  const write = output.write.bind(output);
  // Discard secret keystrokes before they can enter the output buffer.
  output.write = (...args) => masked || write(...args);
  output.columns = stdout.columns;
  const input = createInterface({ input: stdin, output, terminal: true, historySize: 0 });
  const cancel = new AbortController();
  input.once('close', () => cancel.abort());
  input.on('SIGINT', () => input.close());

  async function ask(label, secret = false) {
    if (!secret) return (await input.question(label, { signal: cancel.signal })).trim();
    stdout.write(label);
    masked = true;
    function showMask(_character, key) {
      if (input.closed || key?.name === 'return' || key?.name === 'enter') return;
      const count = [...input.line].length;
      const columns = Math.max(1, (stdout.columns ?? 80) - Buffer.byteLength(label) - 1);
      const visible = Math.min(count, columns);
      const caret = Math.min(visible, [...input.line.slice(0, input.cursor)].length);
      cursorTo(stdout, 0);
      clearLine(stdout, 0);
      stdout.write(label + '*'.repeat(visible));
      if (caret < visible) moveCursor(stdout, caret - visible, 0);
    }
    stdin.on('keypress', showMask);
    try {
      return await input.question('', { signal: cancel.signal });
    } finally {
      stdin.off('keypress', showMask);
      masked = false;
      stdout.write('\n');
    }
  }

  async function field(key, label, { fallback, valid = Boolean, secret = false } = {}) {
    if (valid(env[key])) return env[key];
    const prompt = fallback ? `${label} [${fallback}]: ` : `${label}: `;
    for (;;) {
      const value = (await ask(prompt, secret)) || fallback || '';
      if (valid(value)) {
        try {
          return set(key, value);
        } catch {
          console.log('.env에 저장할 수 있는 값으로 다시 입력하세요.');
          continue;
        }
      }
      console.log('입력값을 확인하고 다시 시도하세요.');
    }
  }

  try {
    console.log('Manuscript 서버 설정');
    await field('DB_PORT', 'DB 포트', { fallback: '3306', valid: validPort });
    await field('DB_USER', 'DB 계정', { fallback: 'manuscript_app' });
    await field('DB_PASSWORD', 'DB 비밀번호', { secret: true });

    if (!validHash(env.ADMIN_PASSWORD_HASH)) {
      for (;;) {
        const password = await ask(`관리자 비밀번호 (${adminPasswordRange}): `, true);
        if (!validNewAdminPassword(password)) {
          console.log(`관리자 비밀번호는 ${adminPasswordRange}로 입력하세요.`);
          continue;
        }
        if (password === await ask('관리자 비밀번호 확인: ', true)) {
          set('ADMIN_PASSWORD_HASH', await hashAdminPassword(password));
          break;
        }
        console.log('비밀번호가 서로 다릅니다.');
      }
    }
  } finally {
    input.close();
    stdin.pause();
    stdin.unref?.();
  }
}

async function configure() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node.js 24가 필요합니다.');
  const existing = existsSync(envPath);
  const original = existing ? readFileSync(envPath, 'utf8') : '';
  const env = parseEnv(original);
  const changes = new Map();
  function set(key, value) {
    envLine(key, value);
    env[key] = value;
    changes.set(key, value);
    return value;
  }

  if (env.APP_PROFILE !== 'web') set('APP_PROFILE', 'web');
  if (!env.PORT) set('PORT', '4174');
  if (!env.DB_HOST) set('DB_HOST', '127.0.0.1');
  if (!env.DB_NAME) set('DB_NAME', 'Manuscript');
  if (env.PUBLIC_ORIGIN?.replace(/\/$/, '') === 'https://manuscript.example.org') set('PUBLIC_ORIGIN', '');

  await promptForSettings(env, set);
  if (!validSecret(env.CANDIDATE_ACCESS_SECRET)) set('CANDIDATE_ACCESS_SECRET', randomBytes(32).toString('base64url'));
  readWebAccess(env);
  if (!changes.size) return;

  const lines = [...changes].map(([key, value]) => envLine(key, value)).join('\r\n');
  if (existing) {
    if (readFileSync(envPath, 'utf8') !== original) throw new Error('.env가 변경되었습니다. start.bat을 다시 실행하세요.');
    appendFileSync(envPath, `\r\n# Manuscript 서버 설정\r\n${lines}\r\n`);
  } else {
    writeFileSync(envPath, lines + '\r\n', { flag: 'wx', mode: 0o600 });
  }
  console.log('.env 설정을 저장했습니다.');
}

try {
  await configure();
} catch (error) {
  console.error(error.name === 'AbortError' ? '서버 설정을 취소했습니다.' : error.message);
  process.exitCode = 1;
}
