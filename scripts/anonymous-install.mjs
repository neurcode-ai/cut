#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './lib.mjs';

const artifacts = join(root, '.artifacts');
if (!existsSync(join(artifacts, 'public-package-manifest.json'))) {
  execFileSync('node', ['scripts/package-parity.mjs'], { cwd: root, stdio: 'inherit' });
}
const manifest = JSON.parse(readFileSync(join(artifacts, 'public-package-manifest.json'), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'neurcode-share-anonymous-'));

try {
  const consumer = join(scratch, 'consumer');
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), '{"name":"anonymous-consumer","private":true}\n');
  const tarballs = manifest.artifacts.map((artifact) => join(artifacts, artifact.file));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], {
    cwd: consumer,
    stdio: 'pipe',
  });
  execFileSync('node', ['-e', [
    "require('@neurcode-ai/share-sdk')",
    "require('@neurcode-ai/share-viewer')",
    "require('@neurcode-ai/share-format')",
    "require('@neurcode-ai/share-compiler')",
  ].join(';')], { cwd: consumer });
  const cli = join(consumer, 'node_modules', '@neurcode-ai', 'share', 'dist', 'index.js');
  execFileSync('node', [cli, '--help'], { cwd: consumer, stdio: 'pipe' });

  const repository = join(scratch, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  writeFileSync(join(repository, 'src', 'example.ts'), 'export const value = 42;\n');
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Synthetic Test'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'synthetic@example.invalid'], { cwd: repository });
  execFileSync('git', ['add', 'src/example.ts'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'synthetic fixture'], { cwd: repository });
  execFileSync(
    'node',
    [cli, 'src/example.ts', '--yes', '--out', 'share.json', '--message', 'Synthetic cold install'],
    {
      cwd: repository,
      env: { ...process.env, SOURCE_DATE_EPOCH: '1767225600' },
      stdio: 'pipe',
    },
  );
  const output = JSON.parse(readFileSync(join(repository, 'share.json'), 'utf8'));
  if (!String(output?.cut?.manifest?.digest || '').startsWith('sha256:')) {
    throw new Error('Anonymous CLI output did not contain a verified digest.');
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write('Anonymous cold installation green.\n');
