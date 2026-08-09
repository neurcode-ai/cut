import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { TextDecoder } from 'node:util';
import {
  APPLYABLE_REPLY_LIMITS,
  SHARE_LIMITS,
  canonicalize,
  readApplyableReplyMetadata,
  validateApplyableReplyAgainstParent,
  validateApplyableRepositoryPath,
  type ApplyableReplyEdit,
  type ApplyableReplyMetadata,
  type ShareBundle,
} from '@neurcode-ai/share-format';
import { discoverShareRepository } from './git-reader';

const MAX_TRIES = 20;
const MAX_TRY_TREE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TRY_TREE_ENTRIES = 200_000;
const TRY_ID = /^try_\d{8}T\d{6}Z_[a-f0-9]{12}$/;
const TRY_RECORD = 'try.json';

interface PreparedChange {
  edit: ApplyableReplyEdit;
  repositoryRoot: string;
  absolutePath: string;
  originalFile: Buffer;
  resultFile: Buffer;
  mode: number;
}

interface TryRecord {
  schemaVersion: 1;
  tryId: string;
  createdAt: string;
  repositoryRoot: string;
  worktreePath: string;
  replyDigest: string;
  parentDigest: string;
}

function safeTerminal(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (character) =>
    `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`
  ).replace(/\r/g, '\\r');
}

function git(root: string, args: string[], timeout = 30_000, input?: string | Buffer): Buffer {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('GIT_')) delete environment[key];
  }
  const result = spawnSync('git', [
    '-C', root,
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    ...args,
  ], {
    encoding: 'buffer',
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout,
    input: typeof input === 'string' ? Buffer.from(input, 'utf8') : input,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...environment,
      GIT_TERMINAL_PROMPT: '0',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (result.status !== 0) {
    throw new Error(`Git could not complete the isolated Cut operation (${args[0]}).`);
  }
  return result.stdout;
}

function stateRoot(): string {
  const configured = process.env.NEURCODE_CUT_STATE_DIR;
  const target = resolve(configured || join(homedir(), '.local', 'share', 'neurcode-cut'));
  if (!isAbsolute(target) || target === resolve('/') || target === resolve(homedir())) {
    throw new Error('Cut state directory resolves to an unsafe broad path.');
  }
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const info = lstatSync(target);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('Cut state directory must be a private, real directory.');
  }
  return realpathSync(target);
}

function ownedChild(root: string, candidate: string): string {
  const absolute = resolve(candidate);
  const rel = relative(root, absolute);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error('Cut state path escaped its application-controlled directory.');
  }
  return absolute;
}

function triesRoot(): string {
  const root = join(stateRoot(), 'tries');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('Cut try directory must be a private, real directory.');
  }
  return realpathSync(root);
}

function recoveryRoot(): string {
  const root = join(stateRoot(), 'recovery');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const info = lstatSync(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('Cut recovery directory must be a private, real directory.');
  }
  return realpathSync(root);
}

function writePrivate(path: string, bytes: string | Buffer): void {
  const descriptor = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function lineChunks(text: string): string[] {
  const chunks = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (chunks[chunks.length - 1] === '') chunks.pop();
  return chunks;
}

function exactCasePath(root: string, path: string): string {
  const validated = validateApplyableRepositoryPath(path);
  let cursor = root;
  for (const part of validated.split('/')) {
    const entries = readdirSync(cursor);
    if (!entries.includes(part)) {
      if (entries.some((entry) => entry.toLocaleLowerCase('en-US') === part.toLocaleLowerCase('en-US'))) {
        throw new Error(`${path}: repository path differs only by case.`);
      }
      throw new Error(`${path}: repository path does not exist.`);
    }
    cursor = join(cursor, part);
    const info = lstatSync(cursor);
    if (info.isSymbolicLink()) throw new Error(`${path}: symbolic links are not supported.`);
    if (cursor !== resolve(root, path) && !info.isDirectory()) {
      throw new Error(`${path}: parent path is not a directory.`);
    }
  }
  const resolved = realpathSync(cursor);
  const rel = relative(root, resolved);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`${path}: resolved path escapes the repository.`);
  }
  return resolved;
}

function assertNotGitLink(root: string, path: string): void {
  const stage = git(root, ['ls-files', '--stage', '--', path]).toString('utf8');
  for (const line of stage.split('\n')) {
    if (/^(?:120000|160000) /.test(line)) {
      throw new Error(`${path}: Git links and submodules are not supported.`);
    }
  }
}

function decodeText(bytes: Buffer, label: string): string {
  if (bytes.includes(0)) throw new Error(`${label}: binary content is not supported.`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label}: content is not valid UTF-8 text.`);
  }
}

function prepareChanges(root: string, metadata: ApplyableReplyMetadata): PreparedChange[] {
  const repository = discoverShareRepository(root, { requireBoundedStatus: true });
  if (repository.root !== realpathSync(root)) throw new Error('Repository root must be selected explicitly.');
  if (repository.origin !== metadata.repository.remote) {
    throw new Error('Applyable reply repository identity does not match this repository.');
  }
  if (repository.head !== metadata.repository.baseRevision) {
    throw new Error('Applyable reply base revision does not match the checked-out repository HEAD.');
  }

  return metadata.edits.map((edit): PreparedChange => {
    const absolutePath = exactCasePath(repository.root, edit.path);
    assertNotGitLink(repository.root, edit.path);
    const info = lstatSync(absolutePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${edit.path}: target is not a regular file.`);
    if (info.size > SHARE_LIMITS.maxTextBlobBytes) throw new Error(`${edit.path}: target exceeds the safe text size.`);
    const originalFile = readFileSync(absolutePath);
    const text = decodeText(originalFile, edit.path);
    let result: string;
    if (edit.kind === 'file') {
      if (text !== edit.original.text) throw new Error(`${edit.path}: exact full-file preimage does not match.`);
      result = edit.replacement.text;
    } else {
      const chunks = lineChunks(text);
      if (edit.range.end > chunks.length) throw new Error(`${edit.path}: selected range is outside the file.`);
      const before = chunks.slice(0, edit.range.start - 1).join('');
      const selected = chunks.slice(edit.range.start - 1, edit.range.end).join('');
      const after = chunks.slice(edit.range.end).join('');
      if (selected !== edit.original.text) throw new Error(`${edit.path}: exact range preimage does not match.`);
      if (!before.endsWith(edit.context.before) || !after.startsWith(edit.context.after)) {
        throw new Error(`${edit.path}: bounded parent context no longer matches.`);
      }
      result = `${before}${edit.replacement.text}${after}`;
    }
    const resultFile = Buffer.from(result, 'utf8');
    if (resultFile.length > SHARE_LIMITS.maxTextBlobBytes) {
      throw new Error(`${edit.path}: proposed result exceeds the safe text size.`);
    }
    return {
      edit,
      repositoryRoot: repository.root,
      absolutePath,
      originalFile,
      resultFile,
      mode: statSync(absolutePath).mode & 0o777,
    };
  });
}

function changesDigest(changes: PreparedChange[]): string {
  const material = changes.map((change) => ({
    path: change.edit.path,
    mode: change.mode,
    original: createHash('sha256').update(change.originalFile).digest('hex'),
    result: createHash('sha256').update(change.resultFile).digest('hex'),
  }));
  return createHash('sha256').update(canonicalize(material)).digest('hex');
}

function diffLines(prefix: '-' | '+', value: string): string[] {
  if (value.length === 0) return [];
  const chunks = lineChunks(value);
  return chunks.map((chunk) => {
    const hasNewline = chunk.endsWith('\n');
    const content = hasNewline ? chunk.slice(0, -1) : chunk;
    return `${prefix}${safeTerminal(content)}${hasNewline ? '' : '\n\\ No newline at end of selection'}`;
  });
}

export function renderApplyableDiff(metadata: ApplyableReplyMetadata): string {
  const lines: string[] = [];
  for (const edit of metadata.edits) {
    const oldLines = lineChunks(edit.original.text).length;
    const newLines = lineChunks(edit.replacement.text).length;
    lines.push(
      `diff --cut a/${safeTerminal(edit.path)} b/${safeTerminal(edit.path)}`,
      `--- a/${safeTerminal(edit.path)}`,
      `+++ b/${safeTerminal(edit.path)}`,
      `@@ -${edit.range.start},${oldLines} +${edit.range.start},${newLines} @@`,
      ...diffLines('-', edit.original.text),
      ...diffLines('+', edit.replacement.text),
    );
  }
  return `${lines.join('\n')}\n`;
}

function tempSibling(path: string): string {
  return join(dirname(path), `.${basename(path)}.neurcode-cut-${randomBytes(8).toString('hex')}.tmp`);
}

function writeResultTemp(change: PreparedChange): string {
  const temp = tempSibling(change.absolutePath);
  writePrivate(temp, change.resultFile);
  chmodSync(temp, change.mode);
  return temp;
}

function restoreFile(change: PreparedChange): void {
  const temp = tempSibling(change.absolutePath);
  writePrivate(temp, change.originalFile);
  chmodSync(temp, change.mode);
  renameSync(temp, change.absolutePath);
}

function applyChangesAtomically(changes: PreparedChange[]): void {
  const pending = new Map<PreparedChange, string>();
  const applied: PreparedChange[] = [];
  try {
    for (const change of changes) pending.set(change, writeResultTemp(change));
    for (const change of changes) {
      if (exactCasePath(change.repositoryRoot, change.edit.path) !== change.absolutePath) {
        throw new Error(`${change.edit.path}: path identity changed during the apply transaction.`);
      }
      const info = lstatSync(change.absolutePath);
      if (!info.isFile() || info.isSymbolicLink() || !readFileSync(change.absolutePath).equals(change.originalFile)) {
        throw new Error(`${change.edit.path}: file changed during the apply transaction.`);
      }
      renameSync(pending.get(change)!, change.absolutePath);
      pending.delete(change);
      applied.push(change);
    }
    for (const change of changes) {
      if (!readFileSync(change.absolutePath).equals(change.resultFile)) {
        throw new Error(`${change.edit.path}: result verification failed.`);
      }
    }
  } catch (error) {
    let rollbackFailed = false;
    for (const change of [...applied].reverse()) {
      try {
        const current = exactCasePath(change.repositoryRoot, change.edit.path);
        if (current !== change.absolutePath || !readFileSync(current).equals(change.resultFile)) {
          rollbackFailed = true;
          continue;
        }
        restoreFile(change);
      } catch { rollbackFailed = true; }
    }
    for (const temp of pending.values()) {
      try { unlinkSync(temp); } catch {}
    }
    if (rollbackFailed) {
      throw new Error('Apply failed and automatic rollback was incomplete. Use the recovery material.');
    }
    throw error;
  }
}

function createRecovery(changes: PreparedChange[], replyDigest: string): string {
  const id = `apply_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}_${randomBytes(6).toString('hex')}`;
  const root = ownedChild(recoveryRoot(), join(recoveryRoot(), id));
  mkdirSync(root, { mode: 0o700 });
  const files = changes.map((change) => {
    const target = ownedChild(root, join(root, 'original', change.edit.path));
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writePrivate(target, change.originalFile);
    return {
      path: change.edit.path,
      mode: change.mode,
      digest: `sha256:${createHash('sha256').update(change.originalFile).digest('hex')}`,
      storedAt: relative(root, target).split(sep).join('/'),
    };
  });
  writePrivate(join(root, 'recovery.json'), `${canonicalize({ schemaVersion: 1, replyDigest, files })}\n`);
  return root;
}

function treeBudget(root: string, revision: string): void {
  const output = git(root, ['ls-tree', '-rlz', revision]);
  const records = output.toString('utf8').split('\0').filter(Boolean);
  if (records.length > MAX_TRY_TREE_ENTRIES) throw new Error('Repository exceeds the isolated try entry limit.');
  let total = 0;
  for (const record of records) {
    const match = record.match(/^\d+ blob [a-f0-9]+\s+(\d+)\t/);
    if (match) total += Number(match[1]);
    if (total > MAX_TRY_TREE_BYTES) throw new Error('Repository exceeds the isolated try disk budget.');
  }
}

function assertCheckoutCannotExecuteRepositoryCode(root: string, revision: string): void {
  const names = git(root, ['ls-tree', '-rz', '--name-only', revision]).toString('utf8').split('\0').filter(Boolean);
  for (const name of names) {
    if (basename(name) !== '.gitattributes') continue;
    const attributes = git(root, ['show', `${revision}:${name}`]).toString('utf8');
    if (/(?:^|\s)(?:filter|filter\.[^\s=]+)(?:=|\s|$)/mi.test(attributes)) {
      throw new Error('Repository-defined checkout filters are not supported by cut try.');
    }
  }
  const infoAttributes = join(root, '.git', 'info', 'attributes');
  if (existsSync(infoAttributes)) {
    const info = lstatSync(infoAttributes);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) {
      throw new Error('Repository info attributes are unsafe for cut try.');
    }
    if (/(?:^|\s)(?:filter|filter\.[^\s=]+)(?:=|\s|$)/mi.test(readFileSync(infoAttributes, 'utf8'))) {
      throw new Error('Repository-defined checkout filters are not supported by cut try.');
    }
  }
}

function writeTryRecord(path: string, record: TryRecord): void {
  writePrivate(path, `${canonicalize(record)}\n`);
}

function readTryRecord(path: string): TryRecord {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error('Cut try record is unsafe.');
  const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<TryRecord>;
  if (
    value.schemaVersion !== 1
    || typeof value.tryId !== 'string'
    || !TRY_ID.test(value.tryId)
    || typeof value.createdAt !== 'string'
    || typeof value.repositoryRoot !== 'string'
    || typeof value.worktreePath !== 'string'
    || typeof value.replyDigest !== 'string'
    || typeof value.parentDigest !== 'string'
  ) {
    throw new Error('Cut try record is invalid.');
  }
  return value as TryRecord;
}

export function inspectApplyableReply(bundle: ShareBundle, expectedParentCutId?: string): ApplyableReplyMetadata {
  const metadata = readApplyableReplyMetadata(bundle);
  if (!metadata) throw new Error('Cut is a normal reply and does not contain applyable edit metadata.');
  if (expectedParentCutId && metadata.parent.cutId !== expectedParentCutId) {
    throw new Error('Applyable reply parent relation does not match the hosted reply relation.');
  }
  return metadata;
}

export function listCutTries(): TryRecord[] {
  const root = triesRoot();
  const records: TryRecord[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !TRY_ID.test(entry.name)) continue;
    const recordPath = join(root, entry.name, TRY_RECORD);
    try {
      const record = readTryRecord(recordPath);
      if (record.tryId !== entry.name) continue;
      records.push(record);
    } catch {
      // Invalid records are neither trusted nor silently removed. The directory
      // remains available for explicit manual recovery.
    }
  }
  return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function renderCutTries(records: TryRecord[]): string {
  if (records.length === 0) return 'No retained Cut try worktrees.\n';
  return `${records.map((record) =>
    `${safeTerminal(record.tryId)}  ${safeTerminal(record.replyDigest)}  ${safeTerminal(record.worktreePath)}`
  ).join('\n')}\n`;
}

export function discardCutTry(tryId: string): void {
  if (!TRY_ID.test(tryId)) throw new Error('Cut try ID is invalid.');
  const root = triesRoot();
  const directory = ownedChild(root, join(root, tryId));
  const record = readTryRecord(join(directory, TRY_RECORD));
  if (record.tryId !== tryId) throw new Error('Cut try record does not match its directory.');
  const worktree = ownedChild(directory, record.worktreePath);
  if (realpathSync(record.repositoryRoot) !== record.repositoryRoot || resolve(record.worktreePath) !== worktree) {
    throw new Error('Cut try ownership record is no longer trustworthy.');
  }
  if (realpathSync(worktree) !== worktree || !lstatSync(join(worktree, '.git')).isDirectory()) {
    throw new Error('Cut try sandbox is no longer trustworthy.');
  }
  const sandboxRoot = git(worktree, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  if (realpathSync(sandboxRoot) !== worktree) throw new Error('Cut try sandbox root changed.');
  rmSync(worktree, { recursive: true, force: false });
  rmSync(directory, { recursive: true, force: false });
}

export function createCutTry(input: {
  bundle: ShareBundle;
  metadata: ApplyableReplyMetadata;
  repoPath: string;
}): TryRecord {
  const repository = discoverShareRepository(resolve(input.repoPath), { requireBoundedStatus: true });
  const initial = prepareChanges(repository.root, input.metadata);
  treeBudget(repository.root, input.metadata.repository.baseRevision);
  assertCheckoutCannotExecuteRepositoryCode(repository.root, input.metadata.repository.baseRevision);
  const root = triesRoot();
  if (listCutTries().length >= MAX_TRIES) {
    throw new Error(`Cut retains at most ${MAX_TRIES} try worktrees. Discard one before trying another.`);
  }
  const now = new Date();
  const tryId = `try_${now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}_${randomBytes(6).toString('hex')}`;
  const directory = ownedChild(root, join(root, tryId));
  const worktreePath = ownedChild(directory, join(directory, 'worktree'));
  mkdirSync(directory, { mode: 0o700 });
  const record: TryRecord = {
    schemaVersion: 1,
    tryId,
    createdAt: now.toISOString(),
    repositoryRoot: repository.root,
    worktreePath,
    replyDigest: input.bundle.cut.manifest.digest,
    parentDigest: input.metadata.parent.digest,
  };
  let sandboxCreated = false;
  try {
    git(repository.root, ['clone', '--shared', '--no-checkout', repository.root, worktreePath], 120_000);
    sandboxCreated = true;
    chmodSync(worktreePath, 0o700);
    git(worktreePath, ['remote', 'set-url', 'origin', `https://${input.metadata.repository.remote}.git`]);
    const sparsePatterns = input.metadata.edits
      .map((edit) => `/${edit.path.replace(/([\[\]])/g, '\\$1')}`)
      .join('\n');
    git(worktreePath, ['sparse-checkout', 'set', '--no-cone', '--stdin'], 30_000, `${sparsePatterns}\n`);
    git(worktreePath, ['checkout', '--detach', input.metadata.repository.baseRevision], 120_000);
    const isolated = prepareChanges(worktreePath, input.metadata);
    applyChangesAtomically(isolated);
    writeTryRecord(join(directory, TRY_RECORD), record);
    return record;
  } catch (error) {
    if (sandboxCreated && existsSync(worktreePath)) {
      try { rmSync(worktreePath, { recursive: true, force: false }); } catch {}
    }
    if (existsSync(directory)) rmSync(directory, { recursive: true, force: false });
    throw error;
  }
}

export async function applyCutReply(input: {
  bundle: ShareBundle;
  metadata: ApplyableReplyMetadata;
  repoPath: string;
}): Promise<{ recoveryPath: string; changedPaths: string[] }> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('cut apply requires an interactive terminal; there is no force or non-interactive bypass.');
  }
  const root = discoverShareRepository(resolve(input.repoPath), { requireBoundedStatus: true }).root;
  const before = prepareChanges(root, input.metadata);
  process.stdout.write(`Applyable reply ${input.bundle.cut.manifest.digest}\n`);
  process.stdout.write(`Parent ${input.metadata.parent.cutId} · ${input.metadata.parent.digest}\n\n`);
  process.stdout.write(renderApplyableDiff(input.metadata));
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  let answer = '';
  try {
    answer = await readline.question(`\nType the complete reply digest to apply these ${before.length} path(s): `);
  } finally {
    readline.close();
  }
  if (answer.trim() !== input.bundle.cut.manifest.digest) throw new Error('Apply confirmation digest did not match; nothing changed.');

  const after = prepareChanges(root, input.metadata);
  if (changesDigest(after) !== changesDigest(before)) {
    throw new Error('Affected files changed after confirmation; nothing was applied.');
  }
  const recoveryPath = createRecovery(after, input.bundle.cut.manifest.digest);
  try {
    applyChangesAtomically(after);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Apply failed.';
    throw new Error(`${message}\nRecovery material: ${recoveryPath}`);
  }
  return { recoveryPath, changedPaths: after.map((change) => change.edit.path) };
}

export function validateApplyableParent(
  metadata: ApplyableReplyMetadata,
  parent: ShareBundle,
  parentCutId: string,
): void {
  validateApplyableReplyAgainstParent(metadata, parent, parentCutId);
}
