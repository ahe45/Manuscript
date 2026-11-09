import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const metadata = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const files = [
  'Manuscript.ico',
  'package.json', 'package-lock.json', 'server.mjs', 'database.mjs', 'access.mjs',
  'fonts.mjs', 'pdf.mjs', 'pdf-queue.mjs', 'README.md', 'REFACTORING_PLAN.md',
  'db/schema.sql', 'tools/access-cli.mjs',
  'deploy/README.md', 'deploy/manuscript.env.example',
  'deploy/manuscript.service', 'deploy/manuscript.nginx.conf',
  'installer/README.md',
];
for (const entry of await readdir(new URL('dist/', root), { withFileTypes: true })) {
  if (entry.isFile() && /\.(html|js|css)$/.test(entry.name)) files.push('dist/' + entry.name);
}
const output = new URL('deploy/output/Manuscript-' + metadata.version + '-Web/', root);
await Promise.all(files.map(async file => {
  const destination = new URL(file, output);
  await mkdir(new URL('.', destination), { recursive: true });
  await copyFile(new URL(file, root), destination);
}));
console.log(fileURLToPath(output));
