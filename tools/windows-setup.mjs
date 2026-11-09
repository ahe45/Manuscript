import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { BlockList, isIPv4 } from 'node:net';
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { parseEnv } from 'node:util';
import { hashAdminPassword, readWebAccess } from '../access.mjs';

const envPath = '.env';
const profiles = ['web', 'local'];
const sampleOrigin = 'https://manuscript.example.org';
const validHash = value => /^[a-f0-9]{32}:[a-f0-9]{64}$/i.test(value ?? '');
const validSecret = value => (value?.length ?? 0) >= 32;
const validPort = value => /^\d+$/.test(value ?? '') && Number(value) >= 1 && Number(value) <= 65535;
const validOrigin = value => {
  if (!value || value.replace(/\/$/, '') === sampleOrigin) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.href === url.origin + '/';
  } catch {
    return false;
  }
};

function envLine(key, value) {
  for (const encoded of [value, `'${value}'`, `"${value}"`, '\x60' + value + '\x60']) {
    const line = `${key}=${encoded}`;
    const parsed = parseEnv(line);
    if (parsed[key] === value && Object.keys(parsed).length === 1) return line;
  }
  throw new Error(`${key}에 .env로 저장할 수 없는 문자가 있습니다.`);
}

function isConfigured(env) {
  return profiles.includes(env.APP_PROFILE) && env.DB_USER && env.DB_PASSWORD &&
    (env.APP_PROFILE === 'local' ||
      (validOrigin(env.PUBLIC_ORIGIN) && validHash(env.ADMIN_PASSWORD_HASH) && validSecret(env.CANDIDATE_ACCESS_SECRET)));
}

async function configure() {
  const existing = existsSync(envPath);
  const original = existing ? readFileSync(envPath, 'utf8') : '';
  const env = parseEnv(original);
  if (isConfigured(env)) return;
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node.js 24가 필요합니다.');
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('처음 설정할 때는 명령 프롬프트에서 start.bat을 직접 실행하세요.');

  const changes = new Map();
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
    try {
      return await input.question('', { signal: cancel.signal });
    } finally {
      masked = false;
      stdout.write('\n');
    }
  }

  function set(key, value) {
    envLine(key, value);
    env[key] = value;
    changes.set(key, value);
    return value;
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
    if (!profiles.includes(env.APP_PROFILE)) {
      let choice;
      do {
        choice = (await ask('운영 방식 (1: HTTPS 웹, 2: 내부망 HTTP) [1]: ')) || '1';
      } while (choice !== '1' && choice !== '2');
      set('APP_PROFILE', choice === '1' ? 'web' : 'local');
    }
    await field('PORT', '서버 포트', { fallback: '4174', valid: validPort });
    await field('DB_HOST', 'DB 호스트', { fallback: '127.0.0.1' });
    await field('DB_PORT', 'DB 포트', { fallback: '3306', valid: validPort });
    await field('DB_NAME', 'DB 이름', { fallback: 'Manuscript' });
    await field('DB_USER', 'DB 계정', { fallback: 'manuscript_app' });
    await field('DB_PASSWORD', 'DB 비밀번호', { secret: true });

    if (env.APP_PROFILE === 'web') {
      await field('PUBLIC_ORIGIN', '실제 접속 HTTPS 주소', { valid: validOrigin });
      if (!validHash(env.ADMIN_PASSWORD_HASH)) {
        for (;;) {
          const password = await ask('관리자 비밀번호 (12~256자): ', true);
          if (password.length < 12 || password.length > 256) {
            console.log('관리자 비밀번호는 12~256자로 입력하세요.');
            continue;
          }
          if (password === await ask('관리자 비밀번호 확인: ', true)) {
            set('ADMIN_PASSWORD_HASH', await hashAdminPassword(password));
            break;
          }
          console.log('비밀번호가 서로 다릅니다.');
        }
      }
      if (!validSecret(env.CANDIDATE_ACCESS_SECRET)) set('CANDIDATE_ACCESS_SECRET', randomBytes(32).toString('base64url'));
      readWebAccess(env);
    } else {
      const privateAddresses = new BlockList();
      privateAddresses.addSubnet('10.0.0.0', 8);
      privateAddresses.addSubnet('172.16.0.0', 12);
      privateAddresses.addSubnet('192.168.0.0', 16);
      const isPrivate = value => isIPv4(value) && privateAddresses.check(value);
      const host = await field('LAN_HOST', '서버 내부망 IPv4 주소 (서버 PC에서만 접속하려면 Enter)',
        { valid: value => value === '' || isPrivate(value) });
      if (host) {
        await field('LAN_SUBNET', '허용 내부망 CIDR', {
          fallback: host.split('.').slice(0, 3).join('.') + '.0/24',
          valid: value => {
            const [network, prefix, extra] = (value ?? '').split('/');
            if (extra !== undefined || !isPrivate(network) || !/^(1[6-9]|2\d|3[0-2])$/.test(prefix ?? '')) return false;
            const subnet = new BlockList();
            subnet.addSubnet(network, Number(prefix));
            return subnet.check(host);
          },
        });
      } else {
        set('LAN_SUBNET', '');
      }
    }

    if (!validSecret(env.CANDIDATE_KEY_SECRET)) {
      await field('CANDIDATE_KEY_SECRET', '이전 해시 원고의 기존 키 (새 DB는 Enter)',
        { secret: true, valid: value => value === '' || validSecret(value) });
    }
  } finally {
    input.close();
    stdin.pause();
    stdin.unref?.();
  }

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
