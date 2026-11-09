import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { adminPasswordRange, hashAdminPassword, readWebAccess, validNewAdminPassword } from '../access.mjs';
import { createSetupPrompt } from './windows-prompt.mjs';

const envPath = '.env';
const validHash = value => /^[a-f0-9]{32}:[a-f0-9]{64}$/i.test(value ?? '');
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
  const { ask, close } = createSetupPrompt();

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
    close();
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
