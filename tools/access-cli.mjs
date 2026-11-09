import { readFileSync } from 'node:fs';
import { hashAdminPassword } from '../access.mjs';

try {
  const command = process.argv[2];
  if (command === 'admin-hash') {
    const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    console.log(await hashAdminPassword(password));
  } else {
    throw new Error('사용법: access-cli.mjs admin-hash');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
