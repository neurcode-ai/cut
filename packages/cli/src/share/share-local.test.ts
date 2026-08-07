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
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { after, test } from 'node:test';
import {
  SHARE_LIMITS,
  readShareArchive,
  scanFields,
  type ShareDocumentDraft,
} from '@neurcode-ai/share-format';
import { runAirlock } from './airlock';
import { captureEvidence } from './evidence';
import { readShareSelections } from './git-reader';
import { createLocalShare } from './create';

const fixtureRoots: string[] = [];

function testRoot(): string {
  const configured = process.env.NEURCODE_SHARE_TEST_TMP;
  const parent = resolve(configured || join(process.cwd(), 'tmp/share-v0-tests'));
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'repo-'));
  fixtureRoots.push(root);
  return root;
}

after(() => {
  for (const root of fixtureRoots) rmSync(root, { force: true, recursive: true });
});

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixtureRepository(): string {
  const root = testRoot();
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'share-test@neurcode.local']);
  git(root, ['config', 'user.name', 'Cut Test']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n.env*\n');
  writeFileSync(
    join(root, 'src/app.ts'),
    Array.from({ length: 80 }, (_, index) => `export const line${index + 1} = ${index + 1};\n`).join(''),
  );
  writeFileSync(join(root, 'src/worker.ts'), 'export const state = "clean";\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initial']);
  const credentialRemote = ['https://user', 'token@example.com:8443/acme/fixture.git'].join(':');
  git(root, ['remote', 'add', 'origin', credentialRemote]);
  return root;
}

test('selection is bounded, sanitized, contextual, and provenance-honest', () => {
  const root = fixtureRepository();
  const result = readShareSelections(root, {
    selections: ['src/app.ts:30-35', 'src/worker.ts'],
    staged: false,
    diff: false,
    forceInclude: [],
    stripContext: [],
  });
  assert.equal(result.repository.origin, 'example.com/acme/fixture');
  assert.equal(result.items[0].kind, 'excerpt');
  if (result.items[0].kind === 'excerpt') {
    assert.deepEqual(result.items[0].range, { start: 30, end: 35 });
    assert.deepEqual(
      { start: result.items[0].context?.start, end: result.items[0].context?.end },
      { start: 10, end: 55 },
    );
    assert.equal(result.items[0].provenance, 'git-object-matched');
    assert.ok(!result.items[0].pin.includes(root));
    assert.ok(!result.items[0].pin.includes('user:token'));
  }
  writeFileSync(join(root, 'src/worker.ts'), 'export const state = "dirty";\n');
  const dirty = readShareSelections(root, {
    selections: ['src/worker.ts'],
    staged: false,
    diff: false,
    forceInclude: [],
    stripContext: [],
  });
  assert.equal(dirty.items[0].provenance, 'worktree-captured');
  const stripped = readShareSelections(root, {
    selections: ['src/app.ts:30-35'],
    staged: false,
    diff: false,
    forceInclude: [],
    stripContext: ['i1'],
  });
  assert.equal(stripped.items[0].kind === 'excerpt' ? stripped.items[0].context : 'wrong-kind', undefined);
});

test('ignored and environment files require exact two-step inclusion', () => {
  const root = fixtureRepository();
  writeFileSync(join(root, 'ignored.txt'), 'safe fixture\n');
  writeFileSync(join(root, '.env.local'), 'SAFE_FIXTURE=true\n');
  const base = {
    staged: false,
    diff: false as const,
    stripContext: [] as string[],
  };
  assert.throws(() => readShareSelections(root, {
    ...base,
    selections: ['ignored.txt'],
    forceInclude: [],
  }), /force-include/);
  const directoryResult = readShareSelections(root, {
    ...base,
    selections: ['.'],
    forceInclude: ['ignored.txt'],
  });
  assert.ok(directoryResult.warnings.some((warning) => warning.includes('ignored.txt')));
  assert.ok(directoryResult.items.every((item) =>
    item.kind !== 'file' && item.kind !== 'excerpt'
      ? true
      : item.path !== 'ignored.txt' && item.path !== '.env.local'
  ));
  assert.equal(readShareSelections(root, {
    ...base,
    selections: ['ignored.txt', '.env.local'],
    forceInclude: ['ignored.txt', '.env.local'],
  }).items.length, 2);
});

test('bounded evidence preserves head and tail and marks omitted middle', async () => {
  const root = fixtureRepository();
  const evidence = await captureEvidence({
    command: `node -e 'process.stdout.write("HEAD-"+"x".repeat(400)+"-TAIL")'`,
    repoRoot: root,
    maxBytes: 160,
    timeoutMs: 5_000,
    stream: false,
  });
  assert.equal(evidence.exit, 0);
  assert.ok(evidence.stdout.length <= 160);
  assert.equal(evidence.stdoutTruncated, true);
  assert.match(evidence.stdout.toString(), /Cut by Neurcode omitted/);
  assert.match(evidence.stdout.toString(), /HEAD-/);
  assert.match(evidence.stdout.toString(), /-TAIL/);
});

test('bounded evidence terminates a command at the configured wall clock', async () => {
  const root = fixtureRepository();
  const started = Date.now();
  const evidence = await captureEvidence({
    command: `node -e 'setTimeout(() => {}, 10000)'`,
    repoRoot: root,
    timeoutMs: 50,
    stream: false,
  });
  assert.equal(evidence.timedOut, true);
  assert.equal(evidence.exit, 124);
  assert.ok(Date.now() - started < 2_000);
});

test('the complete diff scanner sees credentials in removed lines', () => {
  const root = fixtureRepository();
  const key = `AKIA${'B2'.repeat(8)}`;
  writeFileSync(join(root, 'src/removed.ts'), `export const oldKey = "${key}";\n`);
  git(root, ['add', 'src/removed.ts']);
  git(root, ['commit', '-qm', 'add old key fixture']);
  writeFileSync(join(root, 'src/removed.ts'), 'export const oldKey = null;\n');
  const result = readShareSelections(root, {
    selections: [],
    staged: false,
    diff: true,
    forceInclude: [],
    stripContext: [],
  });
  const diff = result.items.find((item) => item.kind === 'diff');
  assert.ok(diff && diff.kind === 'diff');
  const findings = scanFields([{
    scope: 'diff:complete',
    text: result.blobs.get(diff.blob)?.toString('utf8') ?? '',
  }]);
  assert.ok(findings.some((finding) => finding.kind === 'aws-access-key'));
});

test('diff path default-deny covers tracked env, credential stores, private keys, renames, and deletions', () => {
  const baseOptions = {
    selections: [] as string[],
    forceInclude: [] as string[],
    stripContext: [] as string[],
  };

  const worktree = fixtureRepository();
  writeFileSync(join(worktree, '.env.production'), 'SAFE_FIXTURE=true\n');
  git(worktree, ['add', '-f', '.env.production']);
  git(worktree, ['commit', '-qm', 'track env fixture']);
  writeFileSync(join(worktree, '.env.production'), 'SAFE_FIXTURE=false\n');
  assert.throws(() => readShareSelections(worktree, {
    ...baseOptions,
    staged: false,
    diff: true,
  }), /\.env\.production: environment files are excluded in the requested diff/);
  assert.equal(readShareSelections(worktree, {
    ...baseOptions,
    staged: false,
    diff: true,
    forceInclude: ['.env.production'],
  }).items[0].kind, 'diff');

  const staged = fixtureRepository();
  mkdirSync(join(staged, '.aws'));
  writeFileSync(join(staged, '.aws/credentials'), '[default]\nfixture=true\n');
  git(staged, ['add', '-f', '.aws/credentials']);
  assert.throws(() => readShareSelections(staged, {
    ...baseOptions,
    staged: true,
    diff: false,
  }), /\.aws\/credentials: credential-store paths are excluded in the requested diff/);

  const ranged = fixtureRepository();
  mkdirSync(join(ranged, 'certs'));
  writeFileSync(join(ranged, 'certs/server.pem'), 'fixture certificate\n');
  git(ranged, ['add', 'certs/server.pem']);
  git(ranged, ['commit', '-qm', 'private path fixture']);
  const rangeBase = git(ranged, ['rev-parse', 'HEAD']);
  writeFileSync(join(ranged, 'certs/server.pem'), 'changed fixture certificate\n');
  git(ranged, ['add', 'certs/server.pem']);
  git(ranged, ['commit', '-qm', 'change private path fixture']);
  const rangeHead = git(ranged, ['rev-parse', 'HEAD']);
  assert.throws(() => readShareSelections(ranged, {
    ...baseOptions,
    staged: false,
    diff: `${rangeBase}..${rangeHead}`,
  }), /certs\/server\.pem: credential files are excluded in the requested diff/);

  const renamed = fixtureRepository();
  writeFileSync(join(renamed, 'safe-config'), 'fixture=true\n');
  git(renamed, ['add', 'safe-config']);
  git(renamed, ['commit', '-qm', 'safe rename source']);
  git(renamed, ['mv', 'safe-config', '.env.renamed']);
  assert.throws(() => readShareSelections(renamed, {
    ...baseOptions,
    staged: true,
    diff: false,
  }), /\.env\.renamed: environment files are excluded in the requested diff/);

  const renamedAway = fixtureRepository();
  writeFileSync(join(renamedAway, '.env.old'), 'fixture=true\n');
  git(renamedAway, ['add', '-f', '.env.old']);
  git(renamedAway, ['commit', '-qm', 'sensitive rename source']);
  git(renamedAway, ['mv', '.env.old', 'safe-config']);
  assert.throws(() => readShareSelections(renamedAway, {
    ...baseOptions,
    staged: true,
    diff: false,
  }), /\.env\.old: environment files are excluded in the requested diff/);

  const deleted = fixtureRepository();
  mkdirSync(join(deleted, '.ssh'));
  writeFileSync(join(deleted, '.ssh/id_rsa'), 'fixture private key path\n');
  git(deleted, ['add', '-f', '.ssh/id_rsa']);
  git(deleted, ['commit', '-qm', 'sensitive delete source']);
  rmSync(join(deleted, '.ssh/id_rsa'));
  assert.throws(() => readShareSelections(deleted, {
    ...baseOptions,
    staged: false,
    diff: true,
  }), /\.ssh\/id_rsa: credential-store paths are excluded in the requested diff/);
});

test('directory traversal stops at item and aggregate limits', () => {
  const many = fixtureRepository();
  mkdirSync(join(many, 'many'));
  for (let index = 0; index <= SHARE_LIMITS.maxItems; index += 1) {
    writeFileSync(join(many, 'many', `${String(index).padStart(4, '0')}.txt`), 'x\n');
  }
  assert.throws(() => readShareSelections(many, {
    selections: ['many'],
    staged: false,
    diff: false,
    forceInclude: [],
    stripContext: [],
  }), /item limit during directory traversal/);

  const aggregate = fixtureRepository();
  mkdirSync(join(aggregate, 'large'));
  for (let index = 0; index < 7; index += 1) {
    writeFileSync(
      join(aggregate, 'large', `${index}.txt`),
      Buffer.alloc(SHARE_LIMITS.maxTextBlobBytes, 0x41 + index),
    );
  }
  assert.throws(() => readShareSelections(aggregate, {
    selections: ['large'],
    staged: false,
    diff: false,
    forceInclude: [],
    stripContext: [],
  }), /aggregate limit during directory traversal/);
});

test('--yes airlock prints every cut metadata field and omits Git author identity', async () => {
  const root = fixtureRepository();
  const selection = readShareSelections(root, {
    selections: ['src/worker.ts'],
    staged: false,
    diff: false,
    forceInclude: [],
    stripContext: [],
  });
  const draft: ShareDocumentDraft = {
    manifest: {
      cut: 1,
      revisionOf: null,
      title: 'Boundary title',
      intent: 'Boundary intent',
      createdAt: '2026-07-29T00:00:00.000Z',
      origin: {
        remote: selection.repository.origin,
        head: selection.repository.head,
        branch: selection.repository.branch,
        dirty: selection.repository.dirty,
      },
      tool: { name: 'neurcode', version: 'test' },
      security: { class: 'asserted', acknowledgedFindings: [], consent: 'yes' },
    },
    pack: {
      items: selection.items,
      blobs: [...selection.blobs].map(([hash, content]) => ({ hash, bytes: content.length })),
    },
    story: {
      frames: [{
        id: 'f1',
        cite: { item: 'i1' },
        role: 'question',
        note: 'Boundary note?',
        class: 'asserted',
      }],
    },
  };
  let printed = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      printed += chunk.toString();
      callback();
    },
  });
  const result = await runAirlock({
    state: {
      draft,
      blobs: selection.blobs,
      findings: [],
      destinations: ['/tmp/local-only.tar.gz'],
    },
    acknowledgedFindingIds: [],
    yes: true,
    dryRun: false,
    output,
    rescan: () => [],
  });
  assert.equal(result.proceed, true);
  assert.match(printed, /Complete cut\.json metadata boundary/);
  for (const field of [
    '"branch":"main"',
    '"createdAt":"2026-07-29T00:00:00.000Z"',
    '"dirty":false',
    '"head":',
    '"intent":"Boundary intent"',
    '"note":"Boundary note?"',
    '"remote":"example.com/acme/fixture"',
    '"title":"Boundary title"',
    '"tool":{"name":"neurcode","version":"test"}',
  ]) {
    assert.ok(printed.includes(field), `missing airlock metadata ${field}`);
  }
  assert.ok(!printed.includes('"author"'));
  assert.ok(!printed.includes('Cut Test'));
  assert.ok(!printed.includes('share-test@neurcode.local'));
});

test('local end-to-end creates a valid archive and no hosted side effects', async () => {
  const root = fixtureRepository();
  writeFileSync(join(root, 'src/worker.ts'), 'export const state = "dirty";\n');
  const output = join(root, 'out/share.tar.gz');
  const preview = join(root, 'out/preview.html');
  const priorEpoch = process.env.SOURCE_DATE_EPOCH;
  process.env.SOURCE_DATE_EPOCH = '1785283200';
  try {
    const result = await createLocalShare({
      selections: ['src/app.ts:30-35'],
      staged: false,
      diff: true,
      run: `node -e 'console.log("evidence-ok")'`,
      runTimeoutSeconds: 5,
      message: 'Check the local Cut',
      notes: ['src/app.ts=The selected range is the question.'],
      forceInclude: [],
      stripContext: [],
      acknowledgeFindings: [],
      out: output,
      preview,
      dryRun: false,
      yes: true,
      toolVersion: 'test',
      copy: false,
      cwd: root,
    });
    assert.ok(result.bundle);
    assert.ok(existsSync(output));
    assert.ok(existsSync(preview));
    const archive = readShareArchive(readFileSync(output));
    assert.equal(archive.cut.manifest.origin.remote, 'example.com/acme/fixture');
    assert.equal(archive.cut.pack.items.length, 3);
    assert.match(readFileSync(preview, 'utf8'), /Cut by Neurcode · local preview/);
    assert.ok(!readFileSync(preview, 'utf8').includes(root));
  } finally {
    if (priorEpoch === undefined) delete process.env.SOURCE_DATE_EPOCH;
    else process.env.SOURCE_DATE_EPOCH = priorEpoch;
  }
});

test('a planted credential blocks local creation before any output is written', async () => {
  const root = fixtureRepository();
  const secretFile = join(root, 'src/leak.ts');
  writeFileSync(secretFile, `export const key = "AKIA${'A1'.repeat(8)}";\n`);
  const output = join(root, 'blocked.tar.gz');
  await assert.rejects(
    createLocalShare({
      selections: ['src/leak.ts'],
      staged: false,
      diff: false,
      runTimeoutSeconds: 60,
      notes: [],
      forceInclude: [],
      stripContext: [],
      acknowledgeFindings: [],
      out: output,
      dryRun: false,
      yes: true,
      toolVersion: 'test',
      cwd: root,
    }),
    /Secret findings block/,
  );
  assert.equal(existsSync(output), false);

  const finding = scanFields([{
    scope: 'file:i1',
    text: readFileSync(secretFile, 'utf8'),
  }])[0];
  assert.ok(finding);
  const acknowledgedOutput = join(root, 'acknowledged.tar.gz');
  await createLocalShare({
    selections: ['src/leak.ts'],
    staged: false,
    diff: false,
    runTimeoutSeconds: 60,
    notes: [],
    forceInclude: [],
    stripContext: [],
    acknowledgeFindings: [finding.id],
    out: acknowledgedOutput,
    dryRun: false,
    yes: true,
    toolVersion: 'test',
    cwd: root,
  });
  const acknowledged = readShareArchive(readFileSync(acknowledgedOutput));
  assert.deepEqual(acknowledged.cut.manifest.security.acknowledgedFindings, [finding.id]);
});

test('a finding acknowledgement survives unrelated command-output length changes', async () => {
  const root = fixtureRepository();
  const key = `AKIA${'E5'.repeat(8)}`;
  const evidence = (prefix: string) => ({
    argv: ['synthetic-evidence'],
    exit: 0,
    stdout: Buffer.from(`${prefix}\ncredential ${key}\n`),
    stderr: Buffer.alloc(0),
    startedAt: '2026-08-07T00:00:00.000Z',
    durationMs: 1,
    cwd: '.',
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  const first = await createLocalShare({
    selections: ['src/worker.ts'], staged: false, diff: false,
    capturedEvidence: evidence('12 ms'), runTimeoutSeconds: 60,
    notes: [], forceInclude: [], stripContext: [], acknowledgeFindings: [],
    dryRun: true, yes: false, toolVersion: 'test', cwd: root,
  });
  const finding = first.reviewState?.findings.find((candidate) => candidate.kind === 'aws-access-key');
  assert.ok(finding);

  const output = join(root, 'stable-ack.tar.gz');
  const next = await createLocalShare({
    selections: ['src/worker.ts'], staged: false, diff: false,
    capturedEvidence: evidence('completed after 12.481 seconds with unrelated detail'), runTimeoutSeconds: 60,
    notes: [], forceInclude: [], stripContext: [], acknowledgeFindings: [finding.id],
    out: output, dryRun: false, yes: true, toolVersion: 'test', cwd: root,
  });
  assert.ok(next.bundle);
  assert.deepEqual(next.bundle.cut.manifest.security.acknowledgedFindings, [finding.id]);
});

test('generic high-entropy command evidence warns without hiding the disclosure inventory', async () => {
  const root = fixtureRepository();
  const output = join(root, 'warning-only.tar.gz');
  const chunks: string[] = [];
  const reviewOutput = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const result = await createLocalShare({
    selections: ['src/worker.ts'], staged: false, diff: false,
    capturedEvidence: {
      argv: ['synthetic-evidence'], exit: 0,
      stdout: Buffer.from('asset Q7mK2vN9pR4xT8zL3cW6bY1hF5sD0jUa.js\n'), stderr: Buffer.alloc(0),
      startedAt: '2026-08-07T00:00:00.000Z', durationMs: 1, cwd: '.', timedOut: false,
      stdoutTruncated: false, stderrTruncated: false,
    },
    runTimeoutSeconds: 60, notes: [], forceInclude: [], stripContext: [], acknowledgeFindings: [],
    out: output, dryRun: false, yes: true, toolVersion: 'test', cwd: root, reviewOutput,
  });
  const printed = chunks.join('');
  assert.ok(result.bundle);
  assert.match(printed, /WARNING\s+stdout:i2/);
  assert.match(printed, /Complete cut\.json metadata boundary/);
  assert.doesNotMatch(printed, /metadata boundary withheld/);
});

test('secret-shaped filenames, metadata, and captured output stay behind preflight', async () => {
  const root = fixtureRepository();
  const key = `AKIA${'C3'.repeat(8)}`;
  const namedSecret = join(root, 'src', `${key}.log`);
  writeFileSync(namedSecret, 'benign content\n');
  const namedOutput = join(root, 'named-secret.tar.gz');
  const evidenceOutput = join(root, 'evidence-secret.tar.gz');
  const cli = resolve(process.cwd(), 'dist/index.js');
  const named = spawnSync(process.execPath, [
    cli,
    'share',
    `src/${key}.log`,
    '--message', `metadata ${key}`,
    '--out', namedOutput,
    '--yes',
  ], { cwd: root, encoding: 'utf8' });
  const evidence = spawnSync(process.execPath, [
    cli,
    'share',
    'src/worker.ts',
    '--run', 'printf "$NEURCODE_SHARE_FAKE_CANARY"',
    '--run-timeout', '5',
    '--out', evidenceOutput,
    '--yes',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NEURCODE_SHARE_FAKE_CANARY: key },
  });
  const printed = `${named.stdout}${named.stderr}${evidence.stdout}${evidence.stderr}`;
  assert.equal(named.status, 1);
  assert.equal(evidence.status, 1);
  assert.equal(existsSync(namedOutput), false);
  assert.equal(existsSync(evidenceOutput), false);
  assert.ok(!printed.includes(key));
  assert.match(printed, /metadata boundary withheld while secret findings are blocking/);
});

test('--dry-run never executes an evidence command', async () => {
  const root = fixtureRepository();
  const marker = join(root, 'should-not-exist');
  await assert.rejects(createLocalShare({
    selections: ['src/app.ts'],
    staged: false,
    diff: false,
    run: `node -e 'require("fs").writeFileSync(${JSON.stringify(marker)}, "bad")'`,
    runTimeoutSeconds: 60,
    notes: [],
    forceInclude: [],
    stripContext: [],
    acknowledgeFindings: [],
    dryRun: true,
    yes: true,
    toolVersion: 'test',
    cwd: root,
  }), /does not execute --run/);
  assert.equal(existsSync(marker), false);
});

test('local export refuses to overwrite an existing file', async () => {
  const root = fixtureRepository();
  const output = join(root, 'existing.md');
  writeFileSync(output, 'preserve me\n');
  await assert.rejects(createLocalShare({
    selections: ['src/app.ts'],
    staged: false,
    diff: false,
    runTimeoutSeconds: 60,
    notes: [],
    forceInclude: [],
    stripContext: [],
    acknowledgeFindings: [],
    out: output,
    dryRun: false,
    yes: true,
    toolVersion: 'test',
    cwd: root,
  }), /Refusing to overwrite/);
  assert.equal(readFileSync(output, 'utf8'), 'preserve me\n');
});

test('--handoff honors headless flags instead of forcing the browser Composer', () => {
  const root = fixtureRepository();
  // Introduce a working-tree change so the handoff preset has a diff to capture.
  writeFileSync(join(root, 'src/worker.ts'), 'export const state = "handoff";\n');
  const cli = resolve(process.cwd(), 'dist/index.js');
  const headless = spawnSync(process.execPath, [
    cli,
    'share',
    '--handoff',
    '--no-browser',
    '--yes',
    '--stdout', 'md',
  ], { cwd: root, encoding: 'utf8', input: '' });
  const printed = `${headless.stdout}${headless.stderr}`;
  // The loopback Composer must not start; the current diff must be captured.
  assert.equal(headless.status, 0);
  assert.doesNotMatch(printed, /Cut Composer ·/);
  assert.match(headless.stdout, /format: neurcode-share-v1/);
  assert.match(headless.stdout, /# Continue this work/);
  assert.match(printed, /unified diff/);
});

test('terminal disclosure surfaces absolute-path warnings like the visual Composer', () => {
  const root = fixtureRepository();
  writeFileSync(
    join(root, 'src/worker.ts'),
    `export const secretPath = "${['', 'Users', 'synthetic-user', '.aws', 'credentials'].join('/')}";\n`,
  );
  const cli = resolve(process.cwd(), 'dist/index.js');
  const disclosed = spawnSync(process.execPath, [
    cli,
    'share',
    'src/worker.ts',
    '--message', 'absolute path advisory',
    '--yes',
    '--dry-run',
  ], { cwd: root, encoding: 'utf8', input: '' });
  const printed = `${disclosed.stdout}${disclosed.stderr}`;
  assert.match(printed, /Absolute paths: 1 warning\(s\)/);
  assert.ok(printed.includes(['', 'Users', 'synthetic-user', '.aws', 'credentials'].join('/')));
});
