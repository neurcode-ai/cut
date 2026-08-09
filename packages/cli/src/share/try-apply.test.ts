import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs, { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { after, test } from 'node:test';
import {
  APPLYABLE_REPLY_FORMAT,
  APPLYABLE_REPLY_ITEM_PATH,
  applyableTextDigest,
  finalizeShare,
  makePin,
  serializeApplyableReplyMetadata,
  sha256Bytes,
  type ApplyableReplyMetadata,
  type ShareBundle,
  type ShareDocumentDraft,
} from '@neurcode-ai/share-format';
import {
  applyCutReply,
  createCutTry,
  discardCutTry,
  inspectApplyableReply,
  listCutTries,
  renderApplyableDiff,
} from './try-apply';

const roots: string[] = [];
const originalStateDir = process.env.NEURCODE_CUT_STATE_DIR;

after(() => {
  if (originalStateDir === undefined) delete process.env.NEURCODE_CUT_STATE_DIR;
  else process.env.NEURCODE_CUT_STATE_DIR = originalStateDir;
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function withInteractiveInput<T>(
  answer: string,
  operation: () => Promise<T>,
  onOutput?: (output: string) => void,
): Promise<{ result: T; output: string }> {
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process, 'stdin')!;
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process, 'stdout')!;
  const input = new PassThrough() as PassThrough & { isTTY: boolean };
  const output = new PassThrough() as PassThrough & { isTTY: boolean };
  input.isTTY = true;
  output.isTTY = true;
  let rendered = '';
  output.on('data', (chunk) => {
    rendered += chunk.toString('utf8');
    onOutput?.(rendered);
  });
  Object.defineProperty(process, 'stdin', { configurable: true, value: input });
  Object.defineProperty(process, 'stdout', { configurable: true, value: output });
  input.end(`${answer}\n`);
  try {
    return { result: await operation(), output: rendered };
  } finally {
    Object.defineProperty(process, 'stdin', stdinDescriptor);
    Object.defineProperty(process, 'stdout', stdoutDescriptor);
    input.destroy();
    output.destroy();
  }
}

function fixture(options: {
  secondFile?: boolean;
  additionalFiles?: number;
  unrelatedFiles?: boolean;
  slowAtomicPaths?: boolean;
} = {}): {
  repo: string;
  parent: ShareBundle;
  reply: ShareBundle;
  metadata: ApplyableReplyMetadata;
} {
  const repo = temporaryRoot('cut-try-repo-');
  mkdirSync(join(repo, 'src'));
  const sourceFiles = [
    {
      path: 'src/app.ts',
      original: 'export const answer = 42;\n',
      replacement: 'export const answer = 43;\n',
    },
    ...Array.from({ length: options.additionalFiles ?? (options.secondFile ? 1 : 0) }, (_, index) => {
      const padding = options.slowAtomicPaths && index < 18 ? ` // ${'x'.repeat(48 * 1024)}` : '';
      return {
        path: index === 0 ? 'src/other.ts' : `src/extra-${index + 1}.ts`,
        original: `export const enabled${index + 1} = false;${padding}\n`,
        replacement: `export const enabled${index + 1} = true;${padding}\n`,
      };
    }),
  ];
  for (const file of sourceFiles) writeFileSync(join(repo, file.path), file.original);
  if (options.unrelatedFiles) {
    writeFileSync(join(repo, '.env'), 'TRACKED_SECRET=not-copied\n');
    writeFileSync(join(repo, '.gitignore'), 'ignored-secret.txt\n');
    writeFileSync(join(repo, 'unrelated.ts'), 'export const unrelated = true;\n');
  }
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@neurcode.local']);
  git(repo, ['config', 'user.name', 'Cut Test']);
  git(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
  git(repo, ['add', '.']);
  git(repo, ['commit', '-qm', 'fixture']);
  if (options.unrelatedFiles) writeFileSync(join(repo, 'ignored-secret.txt'), 'not copied\n');
  const head = git(repo, ['rev-parse', 'HEAD']);
  const preparedFiles = sourceFiles.map((file) => {
    const original = Buffer.from(file.original);
    return { ...file, original, originalHash: sha256Bytes(original) };
  });
  const parentDraft: ShareDocumentDraft = {
    manifest: {
      cut: 1,
      revisionOf: null,
      title: 'Parent',
      intent: 'Review',
      createdAt: '2026-08-10T00:00:00.000Z',
      origin: { remote: 'github.com/acme/app', head, branch: 'main', dirty: false },
      tool: { name: 'neurcode', version: '0.8.0' },
      security: { class: 'asserted', acknowledgedFindings: [], consent: 'yes' },
    },
    pack: {
      items: preparedFiles.map((file, index) => ({
        id: `i${index + 1}`,
        kind: 'file',
        provenance: 'git-object-matched',
        class: 'observed',
        bytes: file.original.length,
        path: file.path,
        pin: makePin({ origin: 'github.com/acme/app', revision: head, path: file.path, bytes: file.original }),
        blob: file.originalHash,
        mode: 0o644,
        language: 'typescript',
      })),
      blobs: preparedFiles.map((file) => ({ hash: file.originalHash, bytes: file.original.length })),
    },
    story: { frames: [] },
  };
  const parent: ShareBundle = {
    cut: finalizeShare(parentDraft),
    blobs: new Map(preparedFiles.map((file) => [file.originalHash, file.original])),
  };
  const metadata: ApplyableReplyMetadata = {
    format: APPLYABLE_REPLY_FORMAT,
    parent: {
      cutId: `shr_${'b'.repeat(20)}`,
      digest: parent.cut.manifest.digest,
      document: parent.cut,
    },
    repository: { remote: 'github.com/acme/app', baseRevision: head },
    author: { kind: 'authenticated-user', displayName: 'Reviewer' },
    provenance: {
      createdBy: 'neurcode-share-cloud',
      interaction: 'browser-suggested-edit',
      serverAttestation: `hmac-sha256:${'c'.repeat(64)}`,
    },
    edits: preparedFiles.map((file, index) => ({
      id: `e${index + 1}`,
      parentItemId: `i${index + 1}`,
      kind: 'file',
      path: file.path,
      provenance: 'git-object-matched',
      range: { start: 1, end: 1 },
      original: { text: file.original.toString('utf8'), digest: applyableTextDigest(file.original) },
      context: { before: '', after: '' },
      replacement: { text: file.replacement, digest: applyableTextDigest(file.replacement) },
      resultDigest: applyableTextDigest(file.replacement),
    })),
  };
  const metadataBytes = serializeApplyableReplyMetadata(metadata);
  const metadataHash = sha256Bytes(metadataBytes);
  const replyDraft: ShareDocumentDraft = {
    manifest: {
      ...parent.cut.manifest,
      digest: undefined,
      title: 'Suggested edit',
      intent: 'Apply this exact edit',
      createdAt: '2026-08-10T00:01:00.000Z',
    },
    pack: {
      items: [{
        id: 'i1',
        kind: 'file',
        provenance: 'uploaded',
        class: 'observed',
        bytes: metadataBytes.length,
        path: APPLYABLE_REPLY_ITEM_PATH,
        pin: makePin({
          origin: 'github.com/acme/app',
          revision: 'worktree',
          path: APPLYABLE_REPLY_ITEM_PATH,
          bytes: metadataBytes,
        }),
        blob: metadataHash,
        mode: 0o644,
        language: 'json',
      }],
      blobs: [{ hash: metadataHash, bytes: metadataBytes.length }],
    },
    story: { frames: [] },
  };
  return {
    repo,
    parent,
    metadata,
    reply: { cut: finalizeShare(replyDraft), blobs: new Map([[metadataHash, metadataBytes]]) },
  };
}

test('cut try verifies, changes only an isolated worktree, retains it, and discards explicitly', () => {
  const { repo, reply, metadata } = fixture({ unrelatedFiles: true });
  const state = temporaryRoot('cut-try-state-');
  chmodSync(state, 0o700);
  process.env.NEURCODE_CUT_STATE_DIR = state;
  const hookMarker = join(repo, 'hook-ran');
  const hook = join(repo, '.git', 'hooks', 'post-checkout');
  writeFileSync(hook, `#!/bin/sh\nprintf ran > '${hookMarker}'\n`);
  chmodSync(hook, 0o700);

  assert.deepEqual(inspectApplyableReply(reply), metadata);
  const record = createCutTry({ bundle: reply, metadata, repoPath: repo });
  assert.equal(readFileSync(join(repo, 'src', 'app.ts'), 'utf8'), 'export const answer = 42;\n');
  assert.equal(readFileSync(join(record.worktreePath, 'src', 'app.ts'), 'utf8'), 'export const answer = 43;\n');
  assert.equal(existsSync(join(record.worktreePath, '.env')), false);
  assert.equal(existsSync(join(record.worktreePath, '.gitignore')), false);
  assert.equal(existsSync(join(record.worktreePath, 'unrelated.ts')), false);
  assert.equal(existsSync(join(record.worktreePath, 'ignored-secret.txt')), false);
  assert.equal(existsSync(hookMarker), false);
  assert.equal(listCutTries().length, 1);
  discardCutTry(record.tryId);
  assert.equal(existsSync(record.worktreePath), false);
  assert.equal(listCutTries().length, 0);
});

test('cut try rejects drift and repository checkout filters without changing files or running hooks', () => {
  const drift = fixture();
  const state = temporaryRoot('cut-try-state-');
  chmodSync(state, 0o700);
  process.env.NEURCODE_CUT_STATE_DIR = state;
  writeFileSync(join(drift.repo, 'src', 'app.ts'), 'export const answer = 99;\n');
  assert.throws(
    () => createCutTry({ bundle: drift.reply, metadata: drift.metadata, repoPath: drift.repo }),
    /preimage/,
  );
  assert.equal(listCutTries().length, 0);

  const filtered = fixture();
  writeFileSync(join(filtered.repo, '.gitattributes'), '*.ts filter=hostile\n');
  git(filtered.repo, ['add', '.gitattributes']);
  git(filtered.repo, ['commit', '-qm', 'attributes']);
  filtered.metadata.repository.baseRevision = git(filtered.repo, ['rev-parse', 'HEAD']);
  assert.throws(
    () => createCutTry({ bundle: filtered.reply, metadata: filtered.metadata, repoPath: filtered.repo }),
    /checkout filters/,
  );
  assert.equal(readFileSync(join(filtered.repo, 'src', 'app.ts'), 'utf8'), 'export const answer = 42;\n');
});

test('cut apply refuses non-interactive use and terminal diff escapes control sequences', async () => {
  const { repo, reply, metadata } = fixture();
  metadata.edits[0].replacement.text = 'export const answer = "\u001b[31m\u202e";\n';
  metadata.edits[0].replacement.digest = applyableTextDigest(metadata.edits[0].replacement.text);
  metadata.edits[0].resultDigest = metadata.edits[0].replacement.digest;
  assert.ok(!renderApplyableDiff(metadata).includes('\u001b'));
  assert.ok(!renderApplyableDiff(metadata).includes('\u202e'));
  await assert.rejects(
    applyCutReply({ bundle: reply, metadata, repoPath: repo }),
    /interactive terminal/,
  );
  assert.equal(readFileSync(join(repo, 'src', 'app.ts'), 'utf8'), 'export const answer = 42;\n');
});

test('cut apply previews, requires the complete digest, preserves mode, and writes private recovery', async () => {
  const { repo, reply, metadata } = fixture();
  const state = temporaryRoot('cut-apply-state-');
  chmodSync(state, 0o700);
  process.env.NEURCODE_CUT_STATE_DIR = state;
  chmodSync(join(repo, 'src', 'app.ts'), 0o750);
  const hookMarker = join(repo, 'hook-ran');
  writeFileSync(join(repo, '.git', 'hooks', 'pre-commit'), `#!/bin/sh\nprintf ran > '${hookMarker}'\n`);
  chmodSync(join(repo, '.git', 'hooks', 'pre-commit'), 0o700);

  const applied = await withInteractiveInput(
    reply.cut.manifest.digest,
    () => applyCutReply({ bundle: reply, metadata, repoPath: repo }),
  );
  assert.match(applied.output, /diff --cut a\/src\/app\.ts/);
  assert.match(applied.output, /Type the complete reply digest/);
  assert.equal(readFileSync(join(repo, 'src', 'app.ts'), 'utf8'), 'export const answer = 43;\n');
  assert.equal(fs.statSync(join(repo, 'src', 'app.ts')).mode & 0o777, 0o750);
  assert.equal(existsSync(hookMarker), false);
  assert.equal(readFileSync(join(applied.result.recoveryPath, 'original', 'src', 'app.ts'), 'utf8'), 'export const answer = 42;\n');
  const recovery = JSON.parse(readFileSync(join(applied.result.recoveryPath, 'recovery.json'), 'utf8'));
  assert.equal(recovery.replyDigest, reply.cut.manifest.digest);
  assert.equal(recovery.files[0].path, 'src/app.ts');
  assert.equal(fs.statSync(applied.result.recoveryPath).mode & 0o077, 0);
});

test('cut apply rejects a wrong digest and post-preview drift without changing files', async () => {
  const wrong = fixture();
  await assert.rejects(
    withInteractiveInput(
      `sha256:${'0'.repeat(64)}`,
      () => applyCutReply({ bundle: wrong.reply, metadata: wrong.metadata, repoPath: wrong.repo }),
    ),
    /confirmation digest did not match/,
  );
  assert.equal(readFileSync(join(wrong.repo, 'src', 'app.ts'), 'utf8'), 'export const answer = 42;\n');

  const drift = fixture();
  let changed = false;
  await assert.rejects(
    withInteractiveInput(
      drift.reply.cut.manifest.digest,
      () => applyCutReply({ bundle: drift.reply, metadata: drift.metadata, repoPath: drift.repo }),
      (output) => {
        if (!changed && output.includes('Type the complete reply digest')) {
          changed = true;
          writeFileSync(join(drift.repo, 'src', 'app.ts'), 'export const externallyChanged = true;\n');
        }
      },
    ),
    /preimage|changed after confirmation/,
  );
  assert.equal(readFileSync(join(drift.repo, 'src', 'app.ts'), 'utf8'), 'export const externallyChanged = true;\n');
});

test('cut apply rolls back earlier paths when a later path changes mid-operation', async () => {
  const { repo, reply, metadata } = fixture({ additionalFiles: 19, slowAtomicPaths: true });
  const state = temporaryRoot('cut-apply-state-');
  chmodSync(state, 0o700);
  process.env.NEURCODE_CUT_STATE_DIR = state;
  const appPath = join(repo, 'src', 'app.ts');
  const otherPath = join(repo, 'src', 'extra-19.ts');
  const ready = join(state, 'watcher-ready');
  const watcher = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const [watchPath, targetPath, readyPath] = process.argv.slice(1);
    const directory = path.dirname(watchPath);
    fs.writeFileSync(readyPath, 'ready');
    while (true) {
      try {
        const staged = fs.readdirSync(directory).some((name) =>
          name.startsWith('.app.ts.neurcode-cut-') && name.endsWith('.tmp')
        );
        if (!staged) continue;
        fs.writeFileSync(targetPath, 'export const external = true;\\n');
        process.exit(0);
      } catch {}
    }
  `, appPath, otherPath, ready], { stdio: 'ignore' });
  const readyDeadline = Date.now() + 5_000;
  while (!existsSync(ready) && Date.now() < readyDeadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  assert.equal(existsSync(ready), true);
  try {
    await assert.rejects(
      withInteractiveInput(
        reply.cut.manifest.digest,
        () => applyCutReply({ bundle: reply, metadata, repoPath: repo }),
      ),
      /file changed during the apply transaction[\s\S]*Recovery material:/,
    );
  } finally {
    watcher.kill('SIGKILL');
  }
  assert.equal(readFileSync(appPath, 'utf8'), 'export const answer = 42;\n');
  assert.equal(readFileSync(otherPath, 'utf8'), 'export const external = true;\n');
  const recoveries = fs.readdirSync(join(state, 'recovery'));
  assert.equal(recoveries.length, 1);
  assert.equal(
    readFileSync(join(state, 'recovery', recoveries[0], 'original', 'src', 'app.ts'), 'utf8'),
    'export const answer = 42;\n',
  );
});
