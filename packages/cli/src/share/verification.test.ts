import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import {
  canonicalize,
  finalizeShare,
  makePin,
  readShareArchive,
  writeShareArchive,
  type ShareBundle,
  type ShareDocumentDraft,
} from '@neurcode-ai/share-format';
import { refreshShare } from './refresh';
import { readShareSelections } from './git-reader';
import { parseHostedShareLink } from './hosted';
import {
  normalizedVerificationJson,
  parseCitationPin,
  verifyShareBundle,
} from './verification';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

const fixtureRoots: string[] = [];

function repository(name = 'fixture'): string {
  const root = mkdtempSync(join(tmpdir(), 'neurcode-living-'));
  fixtureRoots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Neurcode Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'remote', 'add', 'origin', `https://github.com/neurcode-fixtures/${name}.git`);
  return root;
}

after(() => {
  for (const root of fixtureRoots) rmSync(root, { force: true, recursive: true });
});

function commitAll(root: string, message = 'fixture'): string {
  git(root, 'add', '--all');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function capture(root: string, selection: string): ShareBundle {
  const captured = readShareSelections(root, {
    selections: [selection],
    staged: false,
    diff: false,
    forceInclude: [],
    stripContext: [],
  });
  const draft: ShareDocumentDraft = {
    manifest: {
      cut: 1,
      revisionOf: null,
      title: 'Living fixture',
      intent: 'Verify exact cited bytes',
      createdAt: '2026-07-30T00:00:00.000Z',
      origin: {
        remote: captured.repository.origin,
        head: captured.repository.head,
        branch: captured.repository.branch,
        dirty: captured.repository.dirty,
      },
      tool: { name: 'neurcode', version: 'test' },
      security: { class: 'asserted', acknowledgedFindings: [], consent: 'yes' },
    },
    pack: {
      items: captured.items,
      blobs: [...captured.blobs].map(([hash, bytes]) => ({ hash, bytes: bytes.length })).sort((a, b) => a.hash.localeCompare(b.hash)),
    },
    story: { frames: [] },
  };
  return { cut: finalizeShare(draft), blobs: captured.blobs };
}

function verifyOnce(bundle: ShareBundle, root: string, options: { staged?: boolean; against?: string } = {}) {
  return verifyShareBundle({
    bundle,
    repoPath: root,
    staged: options.staged,
    against: options.against,
    toolVersion: 'test',
    entirelyLocal: true,
  });
}

function verify(bundle: ShareBundle, root: string, options: { staged?: boolean; against?: string } = {}) {
  const first = verifyOnce(bundle, root, options);
  const replay = verifyOnce(bundle, root, options);
  assert.equal(normalizedVerificationJson(first), normalizedVerificationJson(replay));
  return first;
}

test('classifies exact current, dirty worktree, staged, Unicode, and named revisions', () => {
  const root = repository('current');
  writeFileSync(join(root, 'source.ts'), 'const café = "☕";\n');
  const head = commitAll(root);
  const bundle = capture(root, 'source.ts');

  const current = verify(bundle, root);
  assert.equal(current.items[0].status, 'current');
  assert.equal(current.comparison.dirty, false);
  assert.equal(verify(bundle, root, { against: head }).items[0].status, 'current');

  writeFileSync(join(root, 'untracked.txt'), 'dirty\n');
  const dirty = verify(bundle, root);
  assert.equal(dirty.items[0].status, 'current');
  assert.equal(dirty.comparison.dirty, true);
  assert.match(dirty.dirtyStateDisclosure, /dirty worktree/);

  writeFileSync(join(root, 'source.ts'), 'const café = "tea";\n');
  git(root, 'add', 'source.ts');
  const staged = verify(bundle, root, { staged: true });
  assert.equal(staged.items[0].status, 'drifted');
  assert.equal(staged.comparison.staged, true);
});

test('classifies same-file movement, rename, drift, deletion, and ambiguity conservatively', () => {
  const movedRoot = repository('moved');
  writeFileSync(join(movedRoot, 'source.ts'), 'top\nexact citation\nbottom\n');
  commitAll(movedRoot);
  const movedBundle = capture(movedRoot, 'source.ts:2-2');
  writeFileSync(join(movedRoot, 'source.ts'), 'top\nbottom\nexact citation\n');
  const moved = verify(movedBundle, movedRoot);
  assert.equal(moved.items[0].status, 'moved');
  assert.deepEqual(moved.items[0].resolvedRange, { start: 3, end: 3 });

  writeFileSync(join(movedRoot, 'source.ts'), 'exact citation\nmiddle\nexact citation\n');
  assert.equal(verify(movedBundle, movedRoot).items[0].status, 'ambiguous');

  writeFileSync(join(movedRoot, 'source.ts'), 'top\nchanged materially\nbottom\n');
  assert.equal(verify(movedBundle, movedRoot).items[0].status, 'drifted');

  const renameRoot = repository('rename');
  writeFileSync(join(renameRoot, 'old.ts'), 'export const exact = 1;\n');
  commitAll(renameRoot);
  const renameBundle = capture(renameRoot, 'old.ts');
  git(renameRoot, 'mv', 'old.ts', 'new.ts');
  const renamed = verify(renameBundle, renameRoot);
  assert.equal(renamed.items[0].status, 'moved');
  assert.equal(renamed.items[0].resolvedPath, 'new.ts');

  const deleteRoot = repository('deleted');
  writeFileSync(join(deleteRoot, 'gone.ts'), 'gone\n');
  commitAll(deleteRoot);
  const deleteBundle = capture(deleteRoot, 'gone.ts');
  git(deleteRoot, 'rm', '-q', 'gone.ts');
  assert.equal(verify(deleteBundle, deleteRoot).items[0].status, 'deleted');
});

test('fails closed for repository mismatch, unresolvable base, invalid pin, and large target', () => {
  const root = repository('source');
  writeFileSync(join(root, 'a.ts'), 'small\n');
  commitAll(root);
  const bundle = capture(root, 'a.ts');

  const other = repository('other');
  writeFileSync(join(other, 'a.ts'), 'small\n');
  commitAll(other);
  const mismatch = verify(bundle, other);
  assert.equal(mismatch.repositoryMatch, 'mismatched');
  assert.equal(mismatch.items[0].status, 'unverifiable');

  const fakeBase = structuredClone(bundle.cut);
  const item = fakeBase.pack.items[0];
  assert.equal(item.kind, 'file');
  if (item.kind !== 'file') throw new Error('fixture');
  const bytes = bundle.blobs.get(item.blob)!;
  item.pin = makePin({
    origin: fakeBase.manifest.origin.remote,
    revision: 'f'.repeat(40),
    path: item.path,
    bytes,
  });
  const unresolved = {
    cut: finalizeShare({ ...fakeBase, manifest: { ...fakeBase.manifest, digest: undefined } }),
    blobs: bundle.blobs,
  };
  assert.equal(verify(unresolved, root).items[0].status, 'unverifiable');

  const invalid = structuredClone(bundle.cut);
  const invalidItem = invalid.pack.items[0];
  if (invalidItem.kind !== 'file') throw new Error('fixture');
  invalidItem.pin = `not-a-pin!${invalidItem.blob}`;
  const invalidBundle = {
    cut: finalizeShare({ ...invalid, manifest: { ...invalid.manifest, digest: undefined } }),
    blobs: bundle.blobs,
  };
  assert.equal(verify(invalidBundle, root).items[0].status, 'unverifiable');

  writeFileSync(join(root, 'a.ts'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  assert.equal(verify(bundle, root).items[0].status, 'unverifiable');
});

test('preserves byte identity across LF/CRLF and final-newline cases', () => {
  const root = repository('line-endings');
  writeFileSync(join(root, 'lines.txt'), 'one\r\ntwo\r\n');
  commitAll(root);
  const crlf = capture(root, 'lines.txt:2-2');
  writeFileSync(join(root, 'lines.txt'), 'one\ntwo\n');
  assert.equal(verify(crlf, root).items[0].status, 'drifted');

  const finalRoot = repository('final-newline');
  writeFileSync(join(finalRoot, 'last.txt'), 'last');
  commitAll(finalRoot);
  const noFinal = capture(finalRoot, 'last.txt');
  writeFileSync(join(finalRoot, 'last.txt'), 'last\n');
  assert.notEqual(verify(noFinal, finalRoot).items[0].status, 'current');
});

test('produces byte-identical normalized JSON and a tamper-evident receipt digest', () => {
  const root = repository('determinism');
  writeFileSync(join(root, 'stable.ts'), 'stable\n');
  commitAll(root);
  const bundle = capture(root, 'stable.ts');
  const first = normalizedVerificationJson(verify(bundle, root));
  const second = normalizedVerificationJson(verify(bundle, root));
  assert.equal(first, second);
  const parsed = JSON.parse(first);
  assert.match(parsed.receipt.receiptDigest, /^sha256:[a-f0-9]{64}$/);
  parsed.receipt.counts.current = 99;
  assert.notEqual(canonicalReceiptDigest(parsed.receipt), parsed.receipt.receiptDigest);
});

function canonicalReceiptDigest(receipt: any): string {
  const { receiptDigest: _ignored, ...material } = receipt;
  return `sha256:${createHash('sha256')
    .update(`neurcode-verification-receipt-v1\n${canonicalize(material)}`)
    .digest('hex')}`;
}

test('refresh preserves the original, links exact lineage, reviews moves and drift, and aborts safely', async () => {
  const root = repository('refresh');
  writeFileSync(join(root, 'source.ts'), 'alpha\nselected\nomega\n');
  commitAll(root);
  const original = capture(root, 'source.ts:2-2');
  const originalArchive = writeShareArchive(original);

  const currentOutput = join(root, 'current-refresh.tar.gz');
  const currentReport = verify(original, root);
  const current = await refreshShare({
    bundle: original,
    report: currentReport,
    repoPath: root,
    output: currentOutput,
    yes: true,
    toolVersion: 'test',
  });
  assert.equal(current.aborted, false);
  assert.equal(current.bundle?.cut.manifest.revisionOf, original.cut.manifest.digest);
  assert.notEqual(current.bundle?.cut.manifest.digest, original.cut.manifest.digest);
  assert.deepEqual(writeShareArchive(original), originalArchive);
  assert.equal(readShareArchive(readFileSync(currentOutput)).cut.manifest.revisionOf, original.cut.manifest.digest);
  const replay = await refreshShare({
    bundle: original,
    report: currentReport,
    repoPath: root,
    output: join(root, 'current-refresh-replay.tar.gz'),
    yes: true,
    toolVersion: 'test',
  });
  assert.equal(replay.bundle?.cut.manifest.digest, current.bundle?.cut.manifest.digest);

  writeFileSync(join(root, 'source.ts'), 'alpha\nomega\nselected\n');
  const movedReport = verify(original, root);
  const movedOutput = join(root, 'moved-refresh.tar.gz');
  const moved = await refreshShare({
    bundle: original,
    report: movedReport,
    repoPath: root,
    output: movedOutput,
    decisions: new Map([['i1', 'use']]),
    yes: true,
    toolVersion: 'test',
  });
  const movedItem = moved.bundle?.cut.pack.items[0];
  assert.equal(movedItem?.kind, 'excerpt');
  if (movedItem?.kind === 'excerpt') assert.deepEqual(movedItem.range, { start: 3, end: 3 });

  writeFileSync(join(root, 'source.ts'), 'alpha\nreviewed replacement\nomega\n');
  const driftOutput = join(root, 'drift-refresh.tar.gz');
  const drift = await refreshShare({
    bundle: original,
    report: verify(original, root),
    repoPath: root,
    output: driftOutput,
    decisions: new Map([['i1', 'use']]),
    replacements: new Map([['i1', 'source.ts:2-2']]),
    yes: true,
    toolVersion: 'test',
  });
  assert.equal(drift.bundle?.cut.manifest.revisionOf, original.cut.manifest.digest);

  const abortOutput = join(root, 'must-not-exist.tar.gz');
  const aborted = await refreshShare({
    bundle: original,
    report: verify(original, root),
    repoPath: root,
    output: abortOutput,
    decisions: new Map([['i1', 'abort']]),
    yes: true,
    toolVersion: 'test',
  });
  assert.equal(aborted.aborted, true);
  assert.equal(existsSync(abortOutput), false);
  assert.deepEqual(writeShareArchive(original), originalArchive);
});

test('citation pin parser rejects traversal, encoded separators, and unsafe revisions', () => {
  assert.throws(() => parseCitationPin('github.com/a/b@worktree:../x!sha256:' + 'a'.repeat(64)));
  assert.throws(() => parseCitationPin('github.com/a/b@worktree:a%2Fb!sha256:' + 'a'.repeat(64)));
  assert.throws(() => parseCitationPin('github.com/a/b@--help:a!sha256:' + 'a'.repeat(64)));
});

test('bounds hosted URL parsing and preserves an explicit immutable revision', () => {
  const shareId = `shr_${'a'.repeat(20)}`;
  assert.deepEqual(
    parseHostedShareLink(`https://share.neurcode.com/s/${shareId}?revision=7#cap=bounded`),
    { shareId, revisionNumber: 7, capability: 'bounded', agentLinkId: undefined, agentSecret: undefined },
  );
  assert.throws(() => parseHostedShareLink(`ftp://localhost/s/${shareId}`));
  assert.throws(() => parseHostedShareLink(`https://user:password@share.neurcode.com/s/${shareId}`));
  assert.throws(() => parseHostedShareLink(`https://share.neurcode.com/s/${shareId}?revision=0`));
});

test('keeps ordinary p50/p95 below target and a repository with many unrelated files bounded', (context) => {
  const root = repository('performance');
  writeFileSync(join(root, 'selected.ts'), 'export const selected = true;\n');
  for (let index = 0; index < 512; index += 1) {
    writeFileSync(join(root, `unrelated-${String(index).padStart(4, '0')}.txt`), `unrelated ${index}\n`);
  }
  commitAll(root);
  const bundle = capture(root, 'selected.ts');
  const samples: number[] = [];
  for (let index = 0; index < 25; index += 1) {
    const started = process.hrtime.bigint();
    assert.equal(verifyOnce(bundle, root).items[0].status, 'current');
    samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
  }
  samples.sort((left, right) => left - right);
  const percentile = (fraction: number) => samples[Math.ceil(samples.length * fraction) - 1];
  const p50 = percentile(0.5);
  const p95 = percentile(0.95);
  const boundedMaximum = samples.at(-1)!;
  context.diagnostic(
    `ordinary verification p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms; `
    + `512-unrelated-file maximum=${boundedMaximum.toFixed(2)}ms`,
  );
  assert.ok(p50 < 500, `p50 was ${p50.toFixed(2)}ms`);
  assert.ok(p95 < 2_000, `p95 was ${p95.toFixed(2)}ms`);
  assert.ok(boundedMaximum < 5_000, `bounded large-repository result took ${boundedMaximum.toFixed(2)}ms`);
});
