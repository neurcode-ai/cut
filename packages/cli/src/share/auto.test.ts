import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { readShareArchive } from '@neurcode-ai/share-format';

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'neurcode-auto-cli-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'src/token.ts'), 'export const verifyToken = (value: string) => value.length > 3\n');
  writeFileSync(
    join(root, 'src/session.ts'),
    "import { verifyToken } from './token.js'\n"
      + 'export function rotateSession(value: string): string {\n'
      + "  return verifyToken(value) ? `${value}-old` : 'invalid'\n"
      + '}\n',
  );
  writeFileSync(
    join(root, 'test/session.test.ts'),
    "import { rotateSession } from '../src/session.js'\n"
      + "test('rotate', () => rotateSession('valid'))\n",
  );
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Auto Fixture']);
  git(root, ['config', 'user.email', 'auto@example.invalid']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  writeFileSync(
    join(root, 'src/session.ts'),
    "import { verifyToken } from './token.js'\n"
      + 'export function rotateSession(value: string): string {\n'
      + "  return verifyToken(value) ? `${value}-rotated` : 'invalid'\n"
      + '}\n',
  );
  return root;
}

test('hidden --auto compiles through existing capture, airlock, archive, and validator paths', () => {
  const root = fixture();
  try {
    const cli = resolve(process.cwd(), 'dist/index.js');
    const output = join(root, 'auto.tar.gz');
    const result = spawnSync(process.execPath, [
      cli,
      'share',
      '--auto',
      '--task', 'Review the rotateSession security fix',
      '--yes',
      '--out', output,
    ], {
      cwd: root,
      encoding: 'utf8',
      input: '',
    });
    const printed = `${result.stdout}${result.stderr}`;
    assert.equal(result.status, 0, printed);
    assert.ok(existsSync(output));
    assert.match(printed, /Selected by compiler/);
    assert.match(printed, /"candidateCounts"/);
    assert.match(printed, /Machine-derived/);
    const bundle = readShareArchive(readFileSync(output));
    assert.ok(bundle.cut.pack.items.some((item) => item.kind === 'diff'));
    const sourceItems = bundle.cut.pack.items.filter((item) =>
      item.kind === 'file' || item.kind === 'excerpt');
    assert.ok(sourceItems.length > 0);
    assert.equal(bundle.cut.story.frames.length, sourceItems.length);
    assert.ok(bundle.cut.story.frames.every((frame) =>
      /^(?:Machine-derived:|Machine-derived \(weak\):|Unknown:)/.test(frame.note)));
    assert.equal(bundle.cut.manifest.cut, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('--task cannot silently activate automatic selection', () => {
  const root = fixture();
  try {
    const cli = resolve(process.cwd(), 'dist/index.js');
    const result = spawnSync(process.execPath, [
      cli,
      'share',
      '--task', 'Review rotateSession',
      '--yes',
      '--dry-run',
    ], { cwd: root, encoding: 'utf8', input: '' });
    assert.equal(result.status, 1);
    assert.match(`${result.stdout}${result.stderr}`, /only with the experimental --auto/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
