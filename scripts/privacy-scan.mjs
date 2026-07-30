#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { filesUnder, repositoryPath } from './lib.mjs';

const findings = [];
const publicShareDocs = new Set(['README.md', 'docs/EXAMPLES.md']);
const documentedPublicShareHashes = new Set([
  '520ed9dc841b8ab6faba5f918eb833f428ed73663784134b3e50b792be71ff17',
  '9ac567ac4e6bbf57435bcb22f8d7afb5701e66abcc76fd82ae888f087ec04c14',
  'aaf449eba05183dc2c16cd39fe2829064ef76f6bae7c03753409aa02470fcc08',
]);
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
    for (const match of text.matchAll(pattern)) {
      const isDocumentedPublicShare = label === 'hosted Share identifier'
        && publicShareDocs.has(path)
        && documentedPublicShareHashes.has(
          createHash('sha256').update(match[0]).digest('hex'),
        );
      if (!isDocumentedPublicShare) {
        findings.push(`${path}: ${label}`);
        break;
      }
    }
  }
}

if (findings.length) {
  process.stderr.write(`${findings.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write('Privacy and credential scan green.\n');
