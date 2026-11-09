import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { candidateDetails, hashAdminPassword, issueCandidateCode } from '../access.mjs';

try {
  const command = process.argv[2];
  if (command === 'secret') {
    console.log(randomBytes(32).toString('base64url'));
  } else if (command === 'admin-hash') {
    const password = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
    console.log(await hashAdminPassword(password));
  } else if (command === 'candidate-code') {
    const secret = process.env.CANDIDATE_ACCESS_SECRET;
    const candidate = candidateDetails(JSON.parse(readFileSync(0, 'utf8')));
    if (!secret || secret.length < 32 || !candidate) throw new Error('접속 코드 비밀키 또는 수험생 정보를 확인하세요.');
    console.log(issueCandidateCode(secret, candidate));
  } else {
    throw new Error('사용법: access-cli.mjs secret | admin-hash | candidate-code');
  }
} catch (error) {
  console.error(error instanceof SyntaxError ? '수험생 JSON 형식을 확인하세요.' : error.message);
  process.exitCode = 1;
}
