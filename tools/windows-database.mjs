import { readFile } from 'node:fs/promises';
import mariadb from 'mariadb';
import { appDatabaseOptions } from '../database.mjs';
import { createSetupPrompt } from './windows-prompt.mjs';

const permissionErrors = new Set([
  'ER_DBACCESS_DENIED_ERROR', 'ER_TABLEACCESS_DENIED_ERROR',
  'ER_COLUMNACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR',
]);
const schemaErrors = new Set(['ER_BAD_DB_ERROR', 'ER_NO_SUCH_TABLE', 'ER_BAD_FIELD_ERROR']);

async function checkSchema(connection, database) {
  const settings = `${database}.editor_state`;
  const drafts = `${database}.candidate_drafts`;
  try {
    const [state] = await connection.query(
      `SELECT title, columns_per_row, max_characters, candidate_number_digits, question_titles FROM ${settings} WHERE id = 1`);
    if (!state) return { missing: true };
    const columns = 'candidate_number, candidate_name, birth_date, question_number, body, revision, saved_at';
    await connection.query(`SELECT ${columns} FROM ${drafts} LIMIT 0`);
    await connection.query(`UPDATE ${settings} SET title = title WHERE 1 = 0`);
    await connection.query(`UPDATE ${drafts} SET body = body WHERE 1 = 0`);
    await connection.query(`INSERT INTO ${drafts} (${columns}) SELECT ${columns} FROM ${drafts} WHERE 1 = 0`);
    return {};
  } catch (error) {
    if (schemaErrors.has(error.code)) return { missing: true, error };
    if (permissionErrors.has(error.code)) return { permission: true, error };
    throw error;
  }
}

async function applyWithAdministrator(options, app, database, schema) {
  const [{ account }] = await app.query('SELECT CURRENT_USER() AS account');
  const separator = account.lastIndexOf('@');
  if (separator < 1) throw new Error('MariaDB 앱 계정의 접속 호스트를 확인할 수 없습니다.');
  const grantTarget = [account.slice(0, separator), account.slice(separator + 1)];
  console.log('DB를 준비하려면 MariaDB 관리자 계정이 필요합니다. 이 계정 정보는 저장하지 않습니다.');
  const { ask, close } = createSetupPrompt();
  let user, password;
  try {
    user = await ask('MariaDB 관리자 계정 [root]: ') || 'root';
    password = await ask('MariaDB 관리자 비밀번호: ', true);
  } finally {
    close();
  }
  const admin = await mariadb.createConnection({ ...options, user, password });
  try {
    await admin.query(schema);
    const status = await checkSchema(app, database);
    if (status.permission) {
      await admin.query(`GRANT SELECT, UPDATE ON ${database}.editor_state TO ?@?`, grantTarget);
      await admin.query(`GRANT SELECT, INSERT, UPDATE ON ${database}.candidate_drafts TO ?@?`, grantTarget);
    }
  } finally {
    await admin.end();
  }
}

async function prepareDatabase(env) {
  const { database: name, ...options } = appDatabaseOptions(env);
  options.multipleStatements = true;
  // Connect before selecting a database so a fresh server can be initialized.
  let app = await mariadb.createConnection(options);
  try {
    const database = app.escapeId(name);
    const initial = await checkSchema(app, database);
    if (!initial.error && !initial.missing) {
      console.log('Manuscript DB 준비 상태를 확인했습니다.');
      return;
    }
    const schema = (await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'))
      .replaceAll('`Manuscript`', () => database);
    let schemaPermissionDenied = false;
    try {
      await app.query(schema);
    } catch (error) {
      if (!permissionErrors.has(error.code)) throw error;
      schemaPermissionDenied = true;
    }
    let status = await checkSchema(app, database);
    if (status.permission || (status.missing && schemaPermissionDenied)) {
      await applyWithAdministrator(options, app, database, schema);
      await app.end();
      app = null;
      app = await mariadb.createConnection(options);
      status = await checkSchema(app, database);
    }
    if (status.error) throw status.error;
    if (status.missing) throw new Error('원고지의 초기 설정을 만들지 못했습니다.');
    console.log('Manuscript DB 초기 설정을 완료했습니다.');
  } finally {
    await app?.end();
  }
}

try {
  await prepareDatabase(process.env);
} catch (error) {
  const message = error.name === 'AbortError' ? 'DB 준비를 취소했습니다.' : error.sqlMessage ?? error.message;
  console.error('Manuscript DB 준비 실패', error.code ?? '', message);
  process.exitCode = 1;
}
