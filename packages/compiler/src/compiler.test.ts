import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  canonicalCompilePlan,
  compile,
  normalizeCompilePlan,
} from './index';

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'neurcode-compiler-test-'));
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'AGENTS.md'), 'Review authentication changes carefully.\n');
  writeFileSync(
    join(root, 'src/token.ts'),
    'export function verifyToken(value: string): boolean {\n  return value.length > 3\n}\n',
  );
  writeFileSync(
    join(root, 'src/session.ts'),
    "import { verifyToken } from './token.js'\n\n"
      + 'export function rotateSession(value: string): string {\n'
      + "  return verifyToken(value) ? `${value}-old` : 'invalid'\n"
      + '}\n',
  );
  writeFileSync(
    join(root, 'src/app.ts'),
    "import { rotateSession } from './session.js'\n\n"
      + 'export function handleSession(value: string): string {\n'
      + '  return rotateSession(value)\n'
      + '}\n',
  );
  writeFileSync(
    join(root, 'test/session.test.ts'),
    "import { rotateSession } from '../src/session.js'\n\n"
      + "describe('rotateSession', () => {\n"
      + "  test('rotates', () => rotateSession('valid'))\n"
      + '})\n',
  );
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Compiler Fixture']);
  git(root, ['config', 'user.email', 'compiler@example.invalid']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'base']);
  return root;
}

test('worktree compilation is bounded, explainable, and exactly replayable after normalization', () => {
  const root = fixture();
  try {
    writeFileSync(
      join(root, 'src/session.ts'),
      "import { verifyToken } from './token.js'\n\n"
        + 'export function rotateSession(value: string): string {\n'
        + "  return verifyToken(value) ? `${value}-rotated` : 'invalid'\n"
        + '}\n',
    );
    const input = {
      repositoryRoot: root,
      diff: { kind: 'worktree' as const },
      task: 'Review rotateSession security behavior',
    };
    const first = compile(input);
    const second = compile(input);
    assert.equal(first.interpretation.mode, 'matched');
    assert.ok(first.selections.some((selection) => selection.startsWith('src/session.ts:')));
    assert.ok(first.selections.some((selection) => selection.startsWith('src/token.ts:')));
    assert.ok(first.selections.some((selection) => selection.startsWith('src/app.ts:')));
    assert.ok(first.selections.some((selection) => selection.startsWith('test/session.test.ts:')));
    assert.ok(first.inclusions.every((inclusion) =>
      /^(?:Machine-derived:|Machine-derived \(weak\):|Unknown:)/.test(inclusion.reason)));
    assert.ok(first.obligations
      .filter((obligation) => obligation.kind === 'implementation')
      .every((obligation) => obligation.status === 'satisfied'));
    assert.ok(first.candidateCounts.total <= 120);
    assert.equal(
      canonicalCompilePlan(first, true),
      canonicalCompilePlan(second, true),
    );
    assert.deepEqual(
      (normalizeCompilePlan(first).timings as string[]).sort(),
      ['candidatesMs', 'gitMs', 'indexMs', 'obligationsMs', 'planMs', 'selectionMs', 'totalMs'].sort(),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staged and revision-range inputs use the same deterministic compiler', () => {
  const root = fixture();
  try {
    const base = git(root, ['rev-parse', 'HEAD']);
    writeFileSync(
      join(root, 'src/session.ts'),
      "import { verifyToken } from './token.js'\n\n"
        + 'export function rotateSession(value: string): string {\n'
        + "  return verifyToken(value.trim()) ? `${value}-rotated` : 'invalid'\n"
        + '}\n',
    );
    git(root, ['add', 'src/session.ts']);
    const staged = compile({
      repositoryRoot: root,
      diff: { kind: 'staged' },
      task: 'test rotateSession',
    });
    assert.equal(staged.diff.kind, 'staged');
    assert.ok(staged.selections.some((selection) => selection.startsWith('src/session.ts:')));

    git(root, ['commit', '-qm', 'change']);
    const head = git(root, ['rev-parse', 'HEAD']);
    const ranged = compile({
      repositoryRoot: root,
      diff: { kind: 'range', range: `${base}..${head}` },
      task: 'test rotateSession',
    });
    assert.equal(ranged.diff.base, base);
    assert.equal(ranged.diff.head, head);
    assert.deepEqual(ranged.selections, staged.selections);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('staged analysis fails closed when selected staged paths also have unstaged edits', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, 'src/session.ts'), 'export const stage = 1\n');
    git(root, ['add', 'src/session.ts']);
    writeFileSync(join(root, 'src/session.ts'), 'export const stage = 2\n');
    assert.throws(() => compile({
      repositoryRoot: root,
      diff: { kind: 'staged' },
    }), /no additional unstaged edits/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dynamic imports and generic hubs are reported without graph expansion', () => {
  const root = fixture();
  try {
    for (let index = 0; index < 21; index += 1) {
      writeFileSync(
        join(root, 'src', `consumer-${index}.ts`),
        "import { rotateSession } from './session.js'\n"
          + `export const consumer${index} = rotateSession('value')\n`,
      );
    }
    writeFileSync(
      join(root, 'src/session.ts'),
      "import { verifyToken } from './token.js'\n"
        + "export const optional = import('./optional.js')\n"
        + 'export function rotateSession(value: string): string {\n'
        + "  return verifyToken(value) ? `${value}-rotated` : 'invalid'\n"
        + '}\n',
    );
    writeFileSync(join(root, 'src/optional.ts'), 'export const optional = true\n');
    const plan = compile({
      repositoryRoot: root,
      diff: { kind: 'worktree' },
      task: 'Review rotateSession',
    });
    assert.ok(plan.ambiguities.some((ambiguity) => ambiguity.includes('dynamic import')));
    assert.ok(plan.exclusionSummary.some((summary) => /generic hub with \d+ importers/.test(summary)));
    assert.equal(plan.candidateCounts.consumer, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('package implementation declares no runtime dependencies', () => {
  const manifest = require('../package.json') as { dependencies?: Record<string, string> };
  assert.deepEqual(manifest.dependencies ?? {}, {});
});
