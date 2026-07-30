#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { root, sha256File } from './lib.mjs';

const artifactDirectory = join(root, '.artifacts');
rmSync(artifactDirectory, { recursive: true, force: true });
mkdirSync(artifactDirectory, { recursive: true });
execFileSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' });

const packages = [
  ['@neurcode-ai/share-format', 'packages/format'],
  ['@neurcode-ai/share-compiler', 'packages/compiler'],
  ['@neurcode-ai/share', 'packages/cli'],
  ['@neurcode-ai/share-viewer', 'packages/viewer'],
  ['@neurcode-ai/share-sdk', 'packages/sdk'],
];
const artifacts = [];

for (const [name, packageDirectory] of packages) {
  const output = execFileSync(
    'pnpm',
    ['--filter', name, 'pack', '--pack-destination', artifactDirectory],
    { cwd: root, encoding: 'utf8' },
  ).trim().split(/\r?\n/).at(-1);
  const tarball = output?.startsWith('/') ? output : join(root, output || '');
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' })
    .trim().split(/\r?\n/).filter(Boolean).sort();
  const unexpected = entries.filter((entry) => (
    /(?:^|\/)(?:src|tests?|node_modules)\//.test(entry)
    || /\.test\.[cm]?[jt]s$/.test(entry)
  ));
  if (unexpected.length) throw new Error(`${name} packed unexpected source: ${unexpected.join(', ')}`);

  const extract = mkdtempSync(join(tmpdir(), 'neurcode-share-pack-'));
  try {
    execFileSync('tar', ['-xzf', tarball, '-C', extract]);
    for (const entry of entries.filter((value) => value.startsWith('package/dist/') && !value.endsWith('/'))) {
      const relative = entry.slice('package/'.length);
      const packed = join(extract, entry);
      const local = join(root, packageDirectory, relative);
      if (sha256File(packed) !== sha256File(local)) {
        throw new Error(`${name} packed bytes differ from local build: ${relative}`);
      }
    }
    const readmeEntry = entries.find((entry) => /^package\/README\.md$/i.test(entry));
    if (!readmeEntry) throw new Error(`${name} package omits README.md`);
    if (sha256File(join(extract, readmeEntry)) !== sha256File(join(root, packageDirectory, 'README.md'))) {
      throw new Error(`${name} packed README differs from source`);
    }
  } finally {
    rmSync(extract, { recursive: true, force: true });
  }
  artifacts.push({
    name,
    file: basename(tarball),
    sha256: sha256File(tarball),
    bytes: readFileSync(tarball).byteLength,
    entries,
  });
}

writeFileSync(
  join(artifactDirectory, 'public-package-manifest.json'),
  `${JSON.stringify({ schemaVersion: 1, artifacts }, null, 2)}\n`,
  { mode: 0o644 },
);
process.stdout.write(`Packed parity green: ${artifacts.length} artifact(s).\n`);
