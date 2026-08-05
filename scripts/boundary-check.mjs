#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { filesUnder, repositoryPath, root } from './lib.mjs';

const failures = [];
const allFiles = filesUnder();
const globallyForbidden = [
  [/64\.227\.139\.243/g, 'production IP'],
  [/\/root\/neurcode/g, 'production server path'],
  [/\/Users\/sujitjaunjal/g, 'private workstation path'],
];
const sourceForbidden = [
  [/@clerk\//g, 'hosted Clerk implementation'],
  [/@aws-sdk\//g, 'hosted object-storage implementation'],
  [/(?:from|require\()\s*['"]pg['"]/g, 'PostgreSQL implementation'],
  [/\bfastify\b/g, 'hosted HTTP implementation'],
  [/\bDATABASE_URL\b/g, 'database configuration'],
  [/\bNEURCODE_SHARE_LOCAL_OBJECT_DIR\b/g, 'production object-store configuration'],
  [/@neurcode-ai\/(?:brain|governance-runtime|policy-engine|policy|cli-runtime)/g, 'legacy control-plane dependency'],
];

for (const absolute of allFiles) {
  const path = repositoryPath(absolute);
  const text = readFileSync(absolute, 'utf8');
  for (const [pattern, label] of globallyForbidden) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) failures.push(`${path}: contains ${label}`);
  }
  if (/^packages\/(?:format|cli|cut|viewer|sdk)\/src\//.test(path)) {
    for (const [pattern, label] of sourceForbidden) {
      pattern.lastIndex = 0;
      if (pattern.test(text)) failures.push(`${path}: contains ${label}`);
    }
  }
}

for (const packagePath of ['packages/format', 'packages/cli', 'packages/cut', 'packages/viewer', 'packages/sdk']) {
  const manifest = JSON.parse(readFileSync(join(root, packagePath, 'package.json'), 'utf8'));
  if (manifest.license !== 'Apache-2.0') failures.push(`${packagePath}: license is not Apache-2.0`);
  if (manifest.private === true) failures.push(`${packagePath}: publishable package is marked private`);
  if (!String(manifest.repository?.url || '').includes('github.com/neurcode-ai/cut')) {
    failures.push(`${packagePath}: repository metadata does not point to neurcode-ai/cut`);
  }
}

if (failures.length) {
  process.stderr.write(`${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Public boundary green: ${allFiles.length} audited file(s).\n`);
