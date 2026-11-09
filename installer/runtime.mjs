import { createWriteStream } from 'node:fs';
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, fork } from 'node:child_process';
import { createServer } from 'node:net';
import { createInterface } from 'node:readline';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import mariadb from 'mariadb';
import { unzipSync, zipSync } from 'fflate';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const local = process.env.LOCALAPPDATA;
const testRoot = resolve(local, 'Manuscript-Test');
const data = resolve(process.env.MANUSCRIPT_TEST_DATA ?? join(local, 'Manuscript', 'data'));
if (process.env.MANUSCRIPT_TEST_DATA && !data.toLowerCase().startsWith(testRoot.toLowerCase() + sep)) {
  throw new Error('설치 테스트 데이터 경로를 확인하세요.');
}

const paths = {
  settings: join(data, 'settings.json'),
  lock: join(data, 'runtime.lock'),
  database: join(data, 'database'),
  config: join(data, 'server.ini'),
  client: join(data, 'backup.ini'),
};
const maria = name => join(root, 'runtime', 'mariadb', 'bin', name + '.exe');
const secret = () => randomBytes(32).toString('base64url');
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
let log;
let settings;
let db;
let app;
let lock;
const unexpectedExit = Promise.withResolvers();
const maxBackupBytes = 256 * 1024 * 1024;

function finished(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code));
  });
}

function childProcess(executable, args, options = {}) {
  const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...options });
  child.stdout?.on('data', buffer => writeLog(buffer));
  child.stderr?.on('data', buffer => writeLog(buffer));
  const done = finished(child);
  void done.catch(() => {});
  return { child, done };
}

function writeLog(buffer) {
  let message = buffer.toString();
  for (const value of [settings?.rootPassword, settings?.appPassword]) {
    if (value) message = message.replaceAll(value, '[redacted]');
  }
  log?.write(message);
}

async function run(executable, args) {
  const code = await childProcess(executable, args).done;
  if (code !== 0) throw new Error('설치 런타임 명령이 실패했습니다. 로그를 확인해 주세요.');
}

async function exists(path) {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function availablePort(preferred, allowFallback = true) {
  const listener = createServer();
  const bound = new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(preferred, '127.0.0.1', () => resolve(listener.address().port));
  });
  try {
    const port = await bound;
    await new Promise(resolve => listener.close(resolve));
    return port;
  } catch (error) {
    if (error.code === 'EADDRINUSE' && allowFallback) return availablePort(0, false);
    if (error.code === 'EADDRINUSE') throw new Error('전용 DB 포트가 사용 중입니다. 실행 중인 Manuscript를 종료해 주세요.');
    throw error;
  }
}

async function saveSettings() {
  const temporary = paths.settings + '.new';
  await writeFile(temporary, JSON.stringify(settings, null, 2));
  await rename(temporary, paths.settings);
}

async function acquireLock() {
  try {
    lock = await open(paths.lock, 'wx');
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(paths.lock, 'utf8'));
    if (!Number.isInteger(pid) || pid < 1) throw new Error('실행 상태 파일을 확인해 주세요.');
    try {
      process.kill(pid, 0);
      throw new Error('Manuscript가 이미 실행 중입니다.');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await rm(paths.lock);
    lock = await open(paths.lock, 'wx');
  }
  await lock.writeFile(String(process.pid));
}

function rootConnection(options = {}) {
  return mariadb.createConnection({
    host: '127.0.0.1', port: settings.dbPort, user: 'root', password: settings.rootPassword,
    connectTimeout: 750, ...options,
  });
}

async function waitForDatabase() {
  for (let attempt = 0; attempt < 60 && db.child.exitCode === null; attempt++) {
    try {
      const connection = await rootConnection({ multipleStatements: true });
      return connection;
    } catch { await delay(500); }
  }
  throw new Error('내장 MariaDB를 시작하지 못했습니다. 로그를 확인해 주세요.');
}

async function startDatabase() {
  await availablePort(settings.dbPort, false);
  if (!await exists(paths.database)) {
    const temporary = join(data, 'database.new-' + randomBytes(6).toString('hex'));
    await run(maria('mariadb-install-db'), [
      '--datadir=' + temporary, '--password=' + settings.rootPassword, '--port=' + settings.dbPort,
    ]);
    await rename(temporary, paths.database);
  }
  const quoted = path => '"' + path.replaceAll('\\', '/') + '"';
  await writeFile(paths.config, [
    '[mysqld]', 'basedir=' + quoted(join(root, 'runtime/mariadb')), 'datadir=' + quoted(paths.database),
    'port=' + settings.dbPort, 'bind-address=127.0.0.1', 'character-set-server=utf8mb4',
    'collation-server=utf8mb4_unicode_ci', 'innodb-buffer-pool-size=64M', 'max-connections=20', '',
  ].join('\n'));
  db = childProcess(maria('mariadbd'), ['--defaults-file=' + paths.config, '--console']);
  const connection = await waitForDatabase();
  try {
    if (settings.schemaVersion !== release.version) {
      if (settings.schemaVersion) await backUpDatabase();
      await connection.query(await readFile(join(root, 'db/schema.sql'), 'utf8'));
      for (const host of ['localhost', '127.0.0.1']) {
        const account = "'manuscript_app'@'" + host + "'";
        await connection.query('CREATE USER IF NOT EXISTS ' + account + ' IDENTIFIED BY ?', [settings.appPassword]);
        await connection.query('GRANT SELECT, UPDATE ON Manuscript.editor_state TO ' + account);
        await connection.query('GRANT SELECT, INSERT, UPDATE ON Manuscript.candidate_drafts TO ' + account);
      }
      settings.schemaVersion = release.version;
      await saveSettings();
    }
  } finally {
    await connection.end();
  }
}

async function backUpDatabase() {
  const backups = join(data, 'backups');
  await mkdir(backups, { recursive: true });
  const createdAt = new Date().toISOString();
  const stamp = createdAt.replaceAll(':', '-');
  const destination = join(backups, 'Manuscript-' + stamp + '-' + randomBytes(3).toString('hex') + '.msbackup');
  const dump = destination + '.sql.partial';
  await writeClientConfig('root', settings.rootPassword);
  try {
    await run(maria('mariadb-dump'), ['--defaults-extra-file=' + paths.client,
      '--single-transaction', '--quick', '--hex-blob', '--skip-triggers', '--skip-add-locks',
      '--result-file=' + dump, 'Manuscript', 'editor_state', 'candidate_drafts']);
    if ((await stat(dump)).size > maxBackupBytes) throw new Error('백업 데이터가 허용 크기를 초과했습니다.');
    const sql = await readFile(dump);
    const metadata = {
      format: 1, application: 'Manuscript', createdAt, version: release.version, mariadb: release.mariadb,
      sha256: createHash('sha256').update(sql).digest('hex'),
    };
    await writeFile(destination + '.new', zipSync({
      'database.sql': sql, 'metadata.json': Buffer.from(JSON.stringify(metadata)),
    }, { level: 3 }));
    await rename(destination + '.new', destination);
    return destination;
  } finally {
    await rm(dump, { force: true });
    await rm(destination + '.new', { force: true });
    await rm(paths.client, { force: true });
  }
}

function writeClientConfig(user, password) {
  return writeFile(paths.client, `[client]\nhost=127.0.0.1\nport=${settings.dbPort}\nuser=${user}\npassword=${password}\nprotocol=tcp\n`);
}

async function readBackup(path) {
  try {
    if ((await stat(path)).size > maxBackupBytes) throw new Error();
    const seen = new Set();
    const files = unzipSync(await readFile(path), { filter: ({ name, originalSize }) => {
      const limit = name === 'metadata.json' ? 4096 : name === 'database.sql' ? maxBackupBytes : 0;
      if (!limit || originalSize > limit || seen.has(name)) throw new Error();
      seen.add(name);
      return true;
    } });
    const meta = JSON.parse(Buffer.from(files['metadata.json']).toString('utf8'));
    const sql = files['database.sql'];
    if (meta.format !== 1 || meta.application !== 'Manuscript' || meta.mariadb !== release.mariadb ||
        !sql?.length || meta.sha256 !== createHash('sha256').update(sql).digest('hex')) throw new Error();
    const version = /^\d+\.\d+\.\d+$/;
    if (!version.test(meta.version) || meta.version.localeCompare(release.version, 'en', { numeric: true }) > 0) throw new Error();
    return sql;
  } catch {
    throw new Error('지원하지 않거나 손상된 Manuscript 백업 파일입니다.');
  }
}

async function restoreDatabase(sql) {
  const staging = 'manuscript_restore_' + randomBytes(8).toString('hex');
  const password = secret();
  const root = await rootConnection();
  const accounts = ['localhost', '127.0.0.1'].map(host => "'" + staging + "'@'" + host + "'");
  try {
    await root.query('CREATE DATABASE ' + staging + ' CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    for (const account of accounts) {
      await root.query('CREATE USER ' + account + ' IDENTIFIED BY ?', [password]);
      await root.query('GRANT ALL PRIVILEGES ON ' + staging + '.* TO ' + account);
    }
    await writeClientConfig(staging, password);
    const { child, done } = childProcess(maria('mariadb'), [
      '--defaults-extra-file=' + paths.client, '--binary-mode', '--local-infile=0', '--database=' + staging,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdin.end(sql);
    if (await done !== 0) throw new Error('백업 데이터를 읽지 못했습니다.');
    const [state] = await root.query('SELECT id FROM ' + staging + '.editor_state');
    if (state?.id !== 1) throw new Error('백업에 원고지 설정이 없습니다.');
    await root.beginTransaction();
    try {
      for (const [table, columns] of [
        ['editor_state', 'id, columns_per_row, max_characters, revision, title, candidate_number_digits, question_titles'],
        ['candidate_drafts', 'candidate_number, candidate_name, birth_date, question_number, body, revision, saved_at'],
      ]) {
        await root.query('DELETE FROM Manuscript.' + table);
        await root.query('INSERT INTO Manuscript.' + table + ' (' + columns + ') SELECT ' + columns + ' FROM ' + staging + '.' + table);
      }
      await root.commit();
    } catch (error) {
      await root.rollback();
      throw error;
    }
  } finally {
    await rm(paths.client, { force: true });
    await root.query('DROP DATABASE IF EXISTS ' + staging).catch(error => writeLog(error.message));
    for (const account of accounts) await root.query('DROP USER IF EXISTS ' + account).catch(error => writeLog(error.message));
    await root.end();
  }
}

async function startApp(port) {
  const child = fork(join(root, 'server.mjs'), [], {
    cwd: root, windowsHide: true, silent: true,
    env: {
      ...process.env, APP_PROFILE: 'offline', PORT: String(port),
      DB_HOST: '127.0.0.1', DB_PORT: String(settings.dbPort), DB_NAME: 'Manuscript',
      DB_USER: 'manuscript_app', DB_PASSWORD: settings.appPassword,
    },
  });
  child.stdout.on('data', writeLog);
  child.stderr.on('data', writeLog);
  app = { child, done: finished(child) };
  const exited = () => { if (app?.child === child) unexpectedExit.resolve(false); };
  void app.done.then(exited, exited);
  const url = 'http://127.0.0.1:' + port;
  for (let attempt = 0; attempt < 50 && child.exitCode === null; attempt++) {
    try {
      const response = await fetch(url + '/healthz', { signal: AbortSignal.timeout(750) });
      if (response.ok) return url;
    } catch {}
    await delay(400);
  }
  throw new Error('원고지 서버를 시작하지 못했습니다. 로그를 확인해 주세요.');
}

async function stopApp() {
  const current = app;
  app = undefined;
  if (!current) return;
  if (current.child.connected) current.child.send('shutdown', () => {});
  const deadline = setTimeout(() => current.child.kill(), 105000);
  try { await current.done; }
  finally { clearTimeout(deadline); }
}

async function stopChildren() {
  try {
    await stopApp();
  } finally {
    if (db && db.child.exitCode === null) {
      const connection = await rootConnection();
      try {
        await connection.query('SHUTDOWN');
      } catch (error) {
        if (error.code !== 'ER_CONNECTION_ALREADY_CLOSED' && error.code !== 'PROTOCOL_CONNECTION_LOST' && error.code !== 'ER_SOCKET_UNEXPECTED_CLOSE') throw error;
      } finally {
        await connection.end().catch(() => {});
      }
      await db.done;
    }
  }
}

const commands = createInterface({ input: process.stdin });
let maintenance;
const stop = new Promise(resolve => {
  commands.on('line', value => { if (value === 'stop') resolve(); });
  commands.once('close', resolve);
  process.once('SIGINT', resolve);
  process.once('SIGTERM', resolve);
});

try {
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', join(root, 'installer', 'data-permissions.ps1'), '-DataDirectory', data]);
  await acquireLock();
  log = createWriteStream(join(data, 'runtime.log'), { flags: 'a' });
  if (await exists(paths.settings)) {
    settings = JSON.parse(await readFile(paths.settings, 'utf8'));
    if (settings.engine !== release.mariadb) throw new Error('현재 데이터에 맞는 MariaDB 버전이 포함된 설치본을 사용해 주세요.');
  } else {
    settings = { engine: release.mariadb, dbPort: await availablePort(13317), rootPassword: secret(), appPassword: secret() };
    await saveSettings();
  }
  console.log('STATUS 내장 데이터베이스 시작 중…');
  await startDatabase();
  const port = await availablePort(4175);
  const url = await startApp(port);
  console.log('READY ' + url);
  commands.on('line', line => {
    if (maintenance || (line !== 'backup' && !line.startsWith('restore '))) return;
    maintenance = (async () => {
      let safetyBackup;
      try {
        if (line === 'backup') {
          console.log('STATUS 데이터를 백업하고 있습니다.');
          console.log('BACKUP ' + await backUpDatabase());
          return;
        }
        console.log('STATUS 백업 파일을 확인하고 있습니다.');
        const sql = await readBackup(Buffer.from(line.slice(8), 'base64').toString('utf8'));
        await stopApp();
        safetyBackup = await backUpDatabase();
        console.log('STATUS 답안을 복원하고 있습니다.');
        await restoreDatabase(sql);
        await startApp(port);
        console.log('RESTORED ' + safetyBackup);
      } catch (error) {
        writeLog(error.stack + '\n');
        try {
          if (!app) await startApp(port);
        } catch (startupError) {
          writeLog(startupError.stack + '\n');
          unexpectedExit.resolve(false);
        }
        console.log('FAILED ' + (line === 'backup' ? '백업을 완료하지 못했습니다. 로그를 확인해 주세요.' :
          safetyBackup ? '복원에 실패했습니다. 복원 전 백업을 보관했습니다.' : error.message));
      }
    })().finally(() => { maintenance = undefined; });
  });
  const stopped = await Promise.race([stop.then(() => true), unexpectedExit.promise, db.done.then(() => false)]);
  if (!stopped) throw new Error('실행 중인 서버가 종료되었습니다. 로그를 확인해 주세요.');
} catch (error) {
  console.log('ERROR ' + (error.code ?? error.message));
  writeLog(error.stack + '\n');
  process.exitCode = 1;
} finally {
  commands.close();
  process.stdin.pause();
  try {
    await maintenance;
    await stopChildren();
  } catch (error) {
    console.log('ERROR 서버를 정상 종료하지 못했습니다. 로그를 확인해 주세요.');
    writeLog(error.stack + '\n');
    process.exitCode = 1;
  }
  if (lock) {
    await lock.close();
    await rm(paths.lock, { force: true });
  }
  log?.end();
}
