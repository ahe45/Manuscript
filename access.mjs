import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const deriveKey = promisify(scrypt);

export function readWebAccess(env) {
  if (env.APP_PROFILE !== 'web') return null;
  const url = env.PUBLIC_ORIGIN ? URL.parse(env.PUBLIC_ORIGIN) : null;
  if (env.PUBLIC_ORIGIN && (url?.protocol !== 'https:' || url.href !== url.origin + '/')) {
    throw new Error('PUBLIC_ORIGIN에는 HTTPS 주소만 설정하세요.');
  }
  if (!/^[a-f0-9]{32}:[a-f0-9]{64}$/i.test(env.ADMIN_PASSWORD_HASH ?? '')) throw new Error('ADMIN_PASSWORD_HASH를 설정하세요.');
  return { origin: url?.origin, host: url?.host, adminHash: env.ADMIN_PASSWORD_HASH };
}

export function webRequestOrigin(access, headers) {
  if (headers['x-forwarded-proto'] !== 'https' || typeof headers.host !== 'string') return;
  const host = headers.host.toLowerCase();
  const url = URL.parse('https://' + host);
  if (!url || (host !== url.host && host !== url.hostname + ':443')) return;
  if (access.origin && url.origin !== access.origin) return;
  return url.origin;
}

export function candidateDetails(value) {
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

const minAdminPasswordLength = 4;
const maxAdminPasswordLength = 20;
export const adminPasswordRange = `${minAdminPasswordLength}~${maxAdminPasswordLength}자`;

export function validNewAdminPassword(password) {
  if (typeof password !== 'string') return false;
  const length = [...password].length;
  return length >= minAdminPasswordLength && length <= maxAdminPasswordLength;
}

export async function hashAdminPassword(password) {
  if (!validNewAdminPassword(password)) throw new Error(`관리자 비밀번호는 ${adminPasswordRange}로 설정하세요.`);
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt, 32);
  return salt.toString('hex') + ':' + key.toString('hex');
}

export async function checkAdminPassword(hash, password) {
  // Existing deployments may still use passwords created under the old limit.
  if (typeof password !== 'string' || !password || password.length > 256) return false;
  const [salt, key] = hash.split(':').map(value => Buffer.from(value, 'hex'));
  return timingSafeEqual(key, await deriveKey(password, salt, 32));
}

export function createLoginThrottle(windowMs = 10 * 60 * 1000, maxKeys = 10000) {
  const failures = new Map();
  return {
    blocked(key, limit, now = Date.now()) {
      const entry = failures.get(key);
      if (entry && entry.until <= now) failures.delete(key);
      return (failures.get(key)?.count ?? 0) >= limit;
    },
    fail(key, now = Date.now()) {
      const entry = failures.get(key);
      if (entry && entry.until > now) {
        entry.count++;
        return;
      }
      if (failures.size >= maxKeys) failures.delete(failures.keys().next().value);
      failures.set(key, { count: 1, until: now + windowMs });
    },
    clear(key) { failures.delete(key); },
  };
}
