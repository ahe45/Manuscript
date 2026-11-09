import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { readWebAccess } from '../access.mjs';

async function checkServer(env) {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node.js 24가 필요합니다.');
  if (!['web', 'local'].includes(env.APP_PROFILE)) throw new Error('.env의 APP_PROFILE을 web 또는 local로 설정하세요.');
  if (!env.DB_USER || !env.DB_PASSWORD) throw new Error('.env의 DB_USER와 DB_PASSWORD를 설정하세요.');
  readWebAccess(env);

  const port = Number(env.PORT ?? 4174);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('.env의 PORT를 확인하세요.');
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen({ host: '127.0.0.1', port }, () => listener.close(resolve));
  }).catch(error => {
    if (error.code === 'EADDRINUSE') throw new Error(`포트 ${port}가 사용 중입니다. 기존 서버를 종료한 뒤 다시 실행하세요.`);
    throw error;
  });
}

function run(command, args, failure) {
  const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(failure);
}

function prepareDependencies() {
  const stamp = 'node_modules/.manuscript-dependencies';
  const manifest = readFileSync('package.json');
  const dependencies = Object.keys(JSON.parse(manifest).dependencies);
  const fingerprint = createHash('sha256')
    .update(manifest).update(readFileSync('package-lock.json'))
    .update(`${process.platform}/${process.arch}/${process.versions.node}`).digest('hex');
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === fingerprint &&
      dependencies.every(name => existsSync(`node_modules/${name}/package.json`))) return;

  rmSync(stamp, { force: true });
  run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'npm.cmd ci --omit=dev --no-audit --no-fund'],
    'npm 의존성을 설치하지 못했습니다. Node.js와 npm, 네트워크 연결을 확인하세요.');
  writeFileSync(stamp, fingerprint);
}

try {
  const action = process.argv[2];
  if (action !== 'check' && action !== 'prepare') throw new Error('지원하지 않는 Windows 서버 작업입니다.');
  await checkServer(process.env);
  if (action === 'prepare') prepareDependencies();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
