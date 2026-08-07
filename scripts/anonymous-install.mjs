#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
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
const scratch = mkdtempSync(join(tmpdir(), 'neurcode-cut-anonymous-'));

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
    "require.resolve('@neurcode-ai/cut')",
    "require('@neurcode-ai/share-sdk')",
    "require('@neurcode-ai/share-viewer')",
    "require('@neurcode-ai/share-format')",
  ].join(';')], { cwd: consumer });
  const cli = join(consumer, 'node_modules', '@neurcode-ai', 'share', 'dist', 'index.js');
  const cutCli = join(consumer, 'node_modules', '@neurcode-ai', 'cut', 'dist', 'index.js');
  execFileSync('node', [cli, '--help'], { cwd: consumer, stdio: 'pipe' });
  execFileSync('node', [cutCli, '--help'], { cwd: consumer, stdio: 'pipe' });
  const cliVersion = execFileSync('node', [cli, '--version'], {
    cwd: consumer,
    encoding: 'utf8',
  }).trim();
  if (cliVersion !== '0.5.0') throw new Error(`Anonymous CLI version was ${cliVersion}, not 0.5.0.`);
  const cutVersion = execFileSync('node', [cutCli, '--version'], {
    cwd: consumer,
    encoding: 'utf8',
  }).trim();
  if (cutVersion !== '0.2.0') throw new Error(`Cut entry point reported ${cutVersion}, not 0.2.0.`);
  const consumerRequire = createRequire(join(consumer, 'smoke.cjs'));
  const format = consumerRequire('@neurcode-ai/share-format');

  const repository = join(scratch, 'repo');
  mkdirSync(join(repository, 'src'), { recursive: true });
  writeFileSync(join(repository, 'src', 'example.ts'), 'export const value = 42;\n');
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'Synthetic Test'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'synthetic@example.invalid'], { cwd: repository });
  execFileSync(
    'git',
    ['remote', 'add', 'origin', 'https://github.com/neurcode-fixtures/anonymous-install.git'],
    { cwd: repository },
  );
  execFileSync('git', ['add', 'src/example.ts'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'synthetic fixture'], { cwd: repository });
  execFileSync(
    'node',
    [cli, 'src/example.ts', '--yes', '--out', 'share.tar.gz', '--message', 'Synthetic cold install'],
    {
      cwd: repository,
      env: { ...process.env, SOURCE_DATE_EPOCH: '1767225600' },
      stdio: 'pipe',
    },
  );
  const archivePath = join(repository, 'share.tar.gz');
  const originalArchive = readFileSync(archivePath);
  const original = format.readShareArchive(originalArchive);
  if (!String(original?.cut?.manifest?.digest || '').startsWith('sha256:')) {
    throw new Error('Anonymous CLI archive did not contain a verified digest.');
  }
  const current = JSON.parse(execFileSync(
    'node',
    [cli, 'verify', archivePath, '--repo', repository, '--json'],
    { cwd: repository, encoding: 'utf8' },
  ));
  if (current.items?.[0]?.status !== 'current' || current.entirelyLocal !== true) {
    throw new Error('Exact-tarball local verification did not report current and entirely local.');
  }

  writeFileSync(join(repository, 'src', 'example.ts'), 'export const value = 84;\n');
  const drifted = JSON.parse(execFileSync(
    'node',
    [cli, 'verify', archivePath, '--repo', repository, '--json'],
    { cwd: repository, encoding: 'utf8' },
  ));
  if (drifted.items?.[0]?.status !== 'drifted') {
    throw new Error('Exact-tarball controlled transition did not report drifted.');
  }

  const refreshedPath = join(repository, 'refreshed.tar.gz');
  execFileSync('node', [
    cli,
    'refresh',
    archivePath,
    '--repo',
    repository,
    '--decision',
    'i1=use',
    '--replacement',
    'i1=src/example.ts',
    '--output',
    refreshedPath,
    '--yes',
  ], { cwd: repository, stdio: 'pipe' });
  const refreshed = format.readShareArchive(readFileSync(refreshedPath));
  if (refreshed.cut.manifest.revisionOf !== original.cut.manifest.digest) {
    throw new Error('Exact-tarball refresh did not preserve exact immutable lineage.');
  }
  if (!readFileSync(archivePath).equals(originalArchive)) {
    throw new Error('Exact-tarball refresh changed the original archive bytes.');
  }
  const refreshedCurrent = JSON.parse(execFileSync(
    'node',
    [cli, 'verify', refreshedPath, '--repo', repository, '--json'],
    { cwd: repository, encoding: 'utf8' },
  ));
  if (refreshedCurrent.items?.[0]?.status !== 'current') {
    throw new Error('Exact-tarball refreshed revision did not verify as current.');
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write('Anonymous cold installation green.\n');
