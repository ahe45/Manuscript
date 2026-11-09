import mariadb from 'mariadb';

export function createAppDatabase(env) {
  const port = Number(env.DB_PORT ?? 3306);
  if (!env.DB_USER || !env.DB_PASSWORD || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('DB_USER, DB_PASSWORD 및 DB_PORT 설정을 확인하세요.');
  }
  return mariadb.createPool({
    host: env.DB_HOST ?? '127.0.0.1',
    port,
    database: env.DB_NAME ?? 'Manuscript',
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    charset: 'utf8mb4',
    connectionLimit: 4,
    connectTimeout: 3000,
    acquireTimeout: 5000,
  });
}
