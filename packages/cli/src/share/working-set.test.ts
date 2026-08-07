import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SHARE_LIMITS } from '@neurcode-ai/share-format';
import { proposeGitWorkingSet } from './working-set';

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), 'cut-working-set-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.ts'), 'export const value = 1;\n');
  writeFileSync(join(root, '.gitignore'), 'dist/\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'working-set@neurcode.local']);
  git(root, ['config', 'user.name', 'Working Set Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initial']);
  return root;
}

test('clean repository has an empty deterministic proposal', () => {
  const root = repository();
  try {
    const proposal = proposeGitWorkingSet(root);
    assert.deepEqual(proposal.selections, []);
    assert.deepEqual(proposal.diffPaths, []);
    assert.equal(proposal.initialItemCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staged, worktree, mixed, and untracked changes form one HEAD-relative working set', () => {
  const root = repository();
  try {
    writeFileSync(join(root, 'src', 'app.ts'), 'export const value = 2;\n');
    git(root, ['add', 'src/app.ts']);
    let proposal = proposeGitWorkingSet(root);
    assert.deepEqual(proposal.selections, ['src/app.ts']);
    assert.deepEqual(proposal.diffPaths, ['src/app.ts']);

    writeFileSync(join(root, 'src', 'app.ts'), 'export const value = 3;\n');
    proposal = proposeGitWorkingSet(root);
    assert.deepEqual(proposal.selections, ['src/app.ts']);
    assert.deepEqual(proposal.diffPaths, ['src/app.ts']);

    writeFileSync(join(root, 'src', 'other.ts'), 'export const other = true;\n');
    proposal = proposeGitWorkingSet(root);
    assert.deepEqual(proposal.selections, ['src/app.ts', 'src/other.ts']);
    assert.deepEqual(proposal.diffPaths, ['src/app.ts']);
    assert.equal(proposal.initialItemCount, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ignored and sensitive paths are excluded without reading their contents', () => {
  const root = repository();
  try {
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'generated.js'), 'generated\n');
    writeFileSync(join(root, '.env.local'), 'SECRET=synthetic-only\n');
    writeFileSync(join(root, 'src', 'visible.ts'), 'export const visible = true;\n');
    const proposal = proposeGitWorkingSet(root);
    assert.deepEqual(proposal.selections, ['src/visible.ts']);
    assert.ok(proposal.exclusions.some((value) => value.includes('.env.local')));
    assert.ok(proposal.exclusions.some((value) => value.includes('Git-ignored')));
    assert.ok(!JSON.stringify(proposal).includes('synthetic-only'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the default scope is the current directory subtree', () => {
  const root = repository();
  try {
    mkdirSync(join(root, 'packages', 'one'), { recursive: true });
    mkdirSync(join(root, 'packages', 'two'), { recursive: true });
    writeFileSync(join(root, 'packages', 'one', 'inside.ts'), 'inside\n');
    writeFileSync(join(root, 'packages', 'two', 'outside.ts'), 'outside\n');
    const proposal = proposeGitWorkingSet(join(root, 'packages', 'one'));
    assert.equal(proposal.scope, 'packages/one');
    assert.deepEqual(proposal.selections, ['packages/one/inside.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('large working sets stop instead of silently truncating', () => {
  const root = repository();
  try {
    mkdirSync(join(root, 'many'));
    for (let index = 0; index <= SHARE_LIMITS.maxItems; index += 1) {
      writeFileSync(join(root, 'many', `file-${String(index).padStart(3, '0')}.ts`), `${index}\n`);
    }
    assert.throws(
      () => proposeGitWorkingSet(root),
      /501 changed or untracked paths.*nothing was truncated or uploaded/i,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('submodules do not get traversed and are represented only in the Git diff', () => {
  const root = repository();
  const child = repository();
  try {
    git(root, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', child, 'vendor/child']);
    git(root, ['commit', '-qm', 'add submodule']);
    writeFileSync(join(child, 'src', 'app.ts'), 'export const value = 2;\n');
    git(child, ['add', 'src/app.ts']);
    git(child, ['commit', '-qm', 'child update']);
    git(join(root, 'vendor', 'child'), ['pull', '-q']);
    const proposal = proposeGitWorkingSet(root);
    assert.deepEqual(proposal.selections, []);
    assert.deepEqual(proposal.diffPaths, ['vendor/child']);
    assert.ok(proposal.exclusions.some((value) => value.includes('submodule boundary')));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(child, { recursive: true, force: true });
  }
});

test('binary and oversized files are excluded as source while bounds remain fail-closed', () => {
  const root = repository();
  try {
    writeFileSync(join(root, 'asset.bin'), Buffer.from([0, 1, 2, 3]));
    writeFileSync(join(root, 'large.txt'), Buffer.alloc(SHARE_LIMITS.maxTextBlobBytes + 1, 0x61));
    const proposal = proposeGitWorkingSet(root);
    assert.deepEqual(proposal.selections, []);
    assert.ok(proposal.exclusions.some((value) => value.includes('asset.bin: binary')));
    assert.ok(proposal.exclusions.some((value) => value.includes('large.txt: file exceeds')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spaces and Unicode filenames are stable and codepoint sorted', () => {
  const root = repository();
  try {
    writeFileSync(join(root, 'src', 'space name.ts'), 'space\n');
    writeFileSync(join(root, 'src', 'éclair.ts'), 'unicode\n');
    const first = proposeGitWorkingSet(root);
    const second = proposeGitWorkingSet(root);
    assert.deepEqual(first.selections, ['src/space name.ts', 'src/éclair.ts']);
    assert.deepEqual(second, first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('no Git repository fails without scanning the surrounding filesystem', () => {
  const root = mkdtempSync(join(tmpdir(), 'cut-no-git-'));
  try {
    writeFileSync(join(root, 'private.txt'), 'not inspected\n');
    assert.throws(() => proposeGitWorkingSet(root), /Git repository/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
