#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './lib.mjs';

const raw = execFileSync('pnpm', ['licenses', 'list', '--json'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
const inventory = JSON.parse(raw);
const denied = /(?:^|[^A-Z])(AGPL|GPL|LGPL|SSPL|BUSL|BSL|UNLICENSED|UNKNOWN)(?:[^A-Z]|$)/i;
const failures = [];

for (const [license, packages] of Object.entries(inventory)) {
  if (denied.test(license)) {
    failures.push(`${license}: ${Array.isArray(packages) ? packages.length : 0} package(s)`);
  }
}

mkdirSync(join(root, 'reports'), { recursive: true });
writeFileSync(
  join(root, 'reports', 'dependency-licenses.json'),
  `${JSON.stringify(inventory, null, 2)}\n`,
  { mode: 0o644 },
);
if (failures.length) {
  process.stderr.write(`Disallowed or unresolved dependency licenses:\n${failures.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Dependency license audit green: ${Object.keys(inventory).length} license expression(s).\n`);
