#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { filesUnder, repositoryPath } from './lib.mjs';

const findings = [];
const patterns = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, 'private key'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AWS access-key identifier'],
  [/\bgh[oprsu]_[A-Za-z0-9_]{20,}\b/g, 'GitHub token'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'Slack token'],
  [/\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g, 'payment key'],
  [/\b(?:postgres|postgresql):\/\/[^/\s:@]+:[^@\s/]+@/g, 'database credential URL'],
  [/\bshr_[A-Za-z0-9_-]{20,26}\b/g, 'hosted Share identifier'],
  [/#(?:cap|token)=[A-Za-z0-9_-]{20,}/g, 'Share access secret'],
  [/jaunjalsujit@gmail\.com/gi, 'personal email'],
  [/\/Users\/[^/\s]+/g, 'absolute home path'],
  [/\/home\/[^/\s]+/g, 'absolute home path'],
];

for (const absolute of filesUnder()) {
  const path = repositoryPath(absolute);
  const text = readFileSync(absolute, 'utf8');
  for (const [pattern, label] of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) findings.push(`${path}: ${label}`);
  }
}

if (findings.length) {
  process.stderr.write(`${findings.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('Privacy and credential scan green.\n');
