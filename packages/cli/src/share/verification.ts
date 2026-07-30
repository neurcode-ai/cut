import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import {
  SHARE_LIMITS,
  canonicalize,
  sanitizeRepoRelativePath,
  type FileItem,
  type ShareBundle,
  type ShareItem,
} from '@neurcode-ai/share-format';
import { discoverShareRepository, type RepositorySnapshot } from './git-reader';

export const VERIFICATION_STATUSES = [
  'current',
  'moved',
  'drifted',
  'deleted',
  'ambiguous',
  'unverifiable',
] as const;

export type VerificationStatus = typeof VERIFICATION_STATUSES[number];
export type VerificationTargetKind = 'worktree' | 'staged' | 'revision';

export interface ParsedCitationPin {
  origin: string;
  revision: string;
  path: string;
  range?: { start: number; end: number };
  blob: string;
}

export interface VerificationTarget {
  kind: VerificationTargetKind;
  revision: string;
  dirty: boolean;
  staged: boolean;
  repository: string;
}

export interface VerificationItemResult {
  itemId: string;
  itemKind: ShareItem['kind'];
  citationPath?: string;
  citationRange?: { start: number; end: number };
  status: VerificationStatus;
  reason: string;
  resolvedPath?: string;
  resolvedRange?: { start: number; end: number };
  method?: 'cited-range' | 'same-file-exact' | 'git-rename-exact';
}

export interface VerificationReceiptMaterial {
  schemaVersion: 1;
  shareDigest: string;
  toolVersion: string;
  trust: 'locally_verified';
  comparison: VerificationTarget;
  repositoryMatch: 'matched' | 'mismatched' | 'unverifiable';
  counts: Record<VerificationStatus, number>;
  items: Array<{
    itemId: string;
    status: VerificationStatus;
    resolvedPath?: string;
    resolvedRange?: { start: number; end: number };
    method?: VerificationItemResult['method'];
  }>;
}

export interface VerificationReceipt extends VerificationReceiptMaterial {
  receiptDigest: string;
}

export interface VerificationReport {
  schemaVersion: 1;
  shareDigest: string;
  comparison: VerificationTarget;
  repositoryMatch: VerificationReceiptMaterial['repositoryMatch'];
  aggregate: 'current' | 'partially_outdated' | 'outdated' | 'unverifiable';
  counts: Record<VerificationStatus, number>;
  dirtyStateDisclosure: string;
  entirelyLocal: boolean;
  items: VerificationItemResult[];
  receipt: VerificationReceipt;
}

interface ResolvedTarget {
  descriptor: VerificationTarget;
  repository: RepositorySnapshot;
  commit?: string;
  deadline: number;
  fileCache: Map<string, TargetFile>;
  baseCache: Map<string, string | null>;
  renameCache: Map<string, { paths: string[]; boundedFailure: boolean }>;
}

interface TargetFile {
  state: 'exists' | 'missing' | 'unverifiable';
  content?: Buffer;
  reason?: string;
}

const HASH = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40,64}$/i;
const MAX_GIT_OUTPUT = 8 * 1024 * 1024;
const GIT_TIMEOUT_MS = 2_000;
const VERIFICATION_BUDGET_MS = 5_000;

function git(
  root: string,
  args: string[],
  maxBuffer = MAX_GIT_OUTPUT,
  timeout = GIT_TIMEOUT_MS,
): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout,
    maxBuffer,
  }).trim();
}

function tryGit(root: string, args: string[], timeout = GIT_TIMEOUT_MS): string | null {
  try {
    return git(root, args, MAX_GIT_OUTPUT, timeout);
  } catch {
    return null;
  }
}

function resolveCommit(root: string, revision: string, timeout = GIT_TIMEOUT_MS): string | null {
  if (!revision || revision.startsWith('-') || revision.includes('\0')) return null;
  const value = tryGit(root, ['rev-parse', '--verify', `${revision}^{commit}`], timeout);
  return value && COMMIT.test(value) ? value : null;
}

function safeDecodedPath(encoded: string): string {
  let decoded: string[];
  try {
    decoded = encoded.split('/').map((part) => decodeURIComponent(part));
  } catch {
    throw new Error('Citation pin path encoding is invalid.');
  }
  if (decoded.some((part) => part.includes('/') || part.includes('\\'))) {
    throw new Error('Citation pin path contains an encoded separator.');
  }
  const path = decoded.join('/');
  if (
    !path
    || path.startsWith('/')
    || path.includes('\\')
    || path.includes('\0')
    || /[\r\n]/.test(path)
    || path.split('/').some((part) => !part || part === '.' || part === '..' || part.includes('/'))
  ) {
    throw new Error('Citation pin path is unsafe.');
  }
  return path;
}

export function parseCitationPin(value: string): ParsedCitationPin {
  if (typeof value !== 'string' || value.length > 8_192 || /[\s\0]/.test(value)) {
    throw new Error('Citation pin is not a bounded string.');
  }
  const bang = value.lastIndexOf('!');
  if (bang < 1) throw new Error('Citation pin is missing its byte digest.');
  const blob = value.slice(bang + 1);
  if (!HASH.test(blob)) throw new Error('Citation pin byte digest is invalid.');
  const address = value.slice(0, bang);
  const at = address.indexOf('@');
  const colon = address.indexOf(':', at + 1);
  if (at < 1 || colon < at + 2 || address.indexOf('@', at + 1) >= 0) {
    throw new Error('Citation pin address is invalid.');
  }
  const origin = address.slice(0, at);
  const revision = address.slice(at + 1, colon);
  if (!/^(?:[a-z0-9.-]+\/[^@\s/]+\/[^@\s/]+|(?:local|remote)\/opaque-[a-f0-9]{16})$/i.test(origin)) {
    throw new Error('Citation pin origin is invalid.');
  }
  if (!/^(?:[a-f0-9]{40,64}|worktree|index)$/i.test(revision)) {
    throw new Error('Citation pin revision is invalid.');
  }
  const pathAndRange = address.slice(colon + 1);
  const rangeMatch = pathAndRange.match(/^(.*)#L([1-9]\d*)(?:-([1-9]\d*))?$/);
  const encodedPath = rangeMatch ? rangeMatch[1] : pathAndRange;
  const path = safeDecodedPath(encodedPath);
  let range: ParsedCitationPin['range'];
  if (rangeMatch) {
    const start = Number(rangeMatch[2]);
    const end = Number(rangeMatch[3] ?? rangeMatch[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
      throw new Error('Citation pin range is invalid.');
    }
    range = { start, end };
  } else if (pathAndRange.includes('#')) {
    throw new Error('Citation pin range is invalid.');
  }
  return { origin, revision, path, range, blob };
}

function bufferLines(content: Buffer): Array<{ start: number; end: number }> {
  const lines: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0a) {
      lines.push({ start, end: index + 1 });
      start = index + 1;
    }
  }
  if (start < content.length || content.length === 0) lines.push({ start, end: content.length });
  return lines;
}

function rangeBytes(
  content: Buffer,
  range: { start: number; end: number },
): Buffer | null {
  const lines = bufferLines(content);
  if (range.start > lines.length || range.end > lines.length) return null;
  return content.subarray(lines[range.start - 1].start, lines[range.end - 1].end);
}

function rangeForMatch(content: Buffer, offset: number, bytes: Buffer): { start: number; end: number } {
  let start = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content[index] === 0x0a) start += 1;
  }
  let lineCount = 0;
  for (const byte of bytes) if (byte === 0x0a) lineCount += 1;
  if (!bytes.length || bytes[bytes.length - 1] !== 0x0a) lineCount += 1;
  return { start, end: start + Math.max(1, lineCount) - 1 };
}

function exactLineMatches(content: Buffer, bytes: Buffer): Array<{ start: number; end: number }> {
  if (bytes.length === 0 || bytes.length > content.length) return [];
  const starts = [0];
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 0x0a && index + 1 < content.length) starts.push(index + 1);
  }
  const matches: Array<{ start: number; end: number }> = [];
  for (const offset of starts) {
    const end = offset + bytes.length;
    if (end > content.length || !content.subarray(offset, end).equals(bytes)) continue;
    const endAligned = end === content.length
      || bytes[bytes.length - 1] === 0x0a
      || content[end] === 0x0a;
    if (!endAligned) continue;
    matches.push(rangeForMatch(content, offset, bytes));
    if (matches.length >= 2) break;
  }
  return matches;
}

function validUtf8(content: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

function targetFile(target: ResolvedTarget, path: string): TargetFile {
  const cached = target.fileCache.get(path);
  if (cached) return cached;
  const remember = (value: TargetFile): TargetFile => {
    target.fileCache.set(path, value);
    return value;
  };
  if (Date.now() >= target.deadline) {
    return remember({ state: 'unverifiable', reason: 'The bounded verification time budget was exhausted.' });
  }
  if (target.descriptor.kind === 'worktree') {
    try {
      const absolute = resolve(target.repository.root, path);
      const info = lstatSync(absolute);
      if (info.isSymbolicLink() || !info.isFile()) {
        return remember({ state: 'unverifiable', reason: 'The comparison path is not a regular non-link file.' });
      }
      const real = realpathSync(absolute);
      sanitizeRepoRelativePath(target.repository.root, real);
      const size = statSync(real).size;
      if (size > SHARE_LIMITS.maxTextBlobBytes) {
        return remember({ state: 'unverifiable', reason: 'The comparison file exceeds the bounded text-file limit.' });
      }
      const content = readFileSync(real);
      if (!validUtf8(content)) {
        return remember({ state: 'unverifiable', reason: 'The comparison file is not valid UTF-8 text.' });
      }
      return remember({ state: 'exists', content });
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return remember({ state: 'missing' });
      return remember({ state: 'unverifiable', reason: 'The comparison worktree path could not be read safely.' });
    }
  }

  const object = target.descriptor.kind === 'staged'
    ? `:${path}`
    : `${target.commit}:${path}`;
  const sizeTimeout = Math.min(GIT_TIMEOUT_MS, target.deadline - Date.now());
  if (sizeTimeout < 1) {
    return remember({ state: 'unverifiable', reason: 'The bounded verification time budget was exhausted.' });
  }
  const sizeResult = spawnSync('git', ['-C', target.repository.root, 'cat-file', '-s', object], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: sizeTimeout,
    maxBuffer: 64 * 1024,
  });
  if (sizeResult.error || sizeResult.status === null) {
    return remember({ state: 'unverifiable', reason: 'Bounded Git object inspection did not complete.' });
  }
  if (sizeResult.status !== 0) return remember({ state: 'missing' });
  const size = Number(sizeResult.stdout.trim());
  if (!Number.isSafeInteger(size) || size < 0 || size > SHARE_LIMITS.maxTextBlobBytes) {
    return remember({ state: 'unverifiable', reason: 'The comparison Git object exceeds the bounded text-file limit.' });
  }
  const showTimeout = Math.min(GIT_TIMEOUT_MS, target.deadline - Date.now());
  if (showTimeout < 1) {
    return remember({ state: 'unverifiable', reason: 'The bounded verification time budget was exhausted.' });
  }
  const result = spawnSync('git', ['-C', target.repository.root, 'show', object], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: showTimeout,
    maxBuffer: SHARE_LIMITS.maxTextBlobBytes + 1,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    return remember({ state: 'unverifiable', reason: 'The comparison Git object could not be read.' });
  }
  const content = result.stdout as Buffer;
  if (!validUtf8(content)) {
    return remember({ state: 'unverifiable', reason: 'The comparison Git object is not valid UTF-8 text.' });
  }
  return remember({ state: 'exists', content });
}

function renameCandidates(
  target: ResolvedTarget,
  base: string,
  oldPath: string,
): { paths: string[]; boundedFailure: boolean } {
  const cacheKey = `${base}\0${oldPath}`;
  const cached = target.renameCache.get(cacheKey);
  if (cached) return cached;
  const remember = (value: { paths: string[]; boundedFailure: boolean }) => {
    target.renameCache.set(cacheKey, value);
    return value;
  };
  const timeout = Math.min(GIT_TIMEOUT_MS, target.deadline - Date.now());
  if (timeout < 1) return remember({ paths: [], boundedFailure: true });
  const args = ['-C', target.repository.root, 'diff'];
  if (target.descriptor.kind === 'staged') args.push('--cached');
  args.push('--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv', base);
  if (target.descriptor.kind === 'revision') args.push(target.commit!);
  const result = spawnSync('git', args, {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
    maxBuffer: MAX_GIT_OUTPUT,
  });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    return remember({ paths: [], boundedFailure: true });
  }
  const tokens = (result.stdout as Buffer).toString('utf8').split('\0').filter(Boolean);
  const paths: string[] = [];
  let cursor = 0;
  let records = 0;
  try {
    while (cursor < tokens.length) {
      if (records >= 20_000) return remember({ paths: [], boundedFailure: true });
      records += 1;
      const status = tokens[cursor++];
      const first = tokens[cursor++];
      if (!status || !first) return remember({ paths: [], boundedFailure: true });
      if (status.startsWith('R') || status.startsWith('C')) {
        const second = tokens[cursor++];
        if (!second) return remember({ paths: [], boundedFailure: true });
        if (first === oldPath) paths.push(sanitizeRepoRelativePath(target.repository.root, second));
      }
    }
  } catch {
    return remember({ paths: [], boundedFailure: true });
  }
  return remember({ paths: [...new Set(paths)].sort(), boundedFailure: false });
}

function resolveTarget(
  repoPath: string,
  options: { against?: string; staged?: boolean },
): ResolvedTarget {
  if (options.against && options.staged) throw new Error('Use either --against or --staged, not both.');
  const deadline = Date.now() + VERIFICATION_BUDGET_MS;
  const repository = discoverShareRepository(repoPath, {
    timeoutMs: 750,
    maxBuffer: MAX_GIT_OUTPUT,
    requireBoundedStatus: true,
  });
  const common = {
    repository,
    deadline,
    fileCache: new Map<string, TargetFile>(),
    baseCache: new Map<string, string | null>(),
    renameCache: new Map<string, { paths: string[]; boundedFailure: boolean }>(),
  };
  if (options.against) {
    const timeout = Math.min(GIT_TIMEOUT_MS, deadline - Date.now());
    const commit = timeout > 0 ? resolveCommit(repository.root, options.against, timeout) : null;
    if (!commit) throw new Error(`Comparison revision is not a commit: ${options.against}`);
    return {
      ...common,
      commit,
      descriptor: {
        kind: 'revision',
        revision: commit,
        dirty: false,
        staged: false,
        repository: repository.origin,
      },
    };
  }
  if (options.staged) {
    const timeout = Math.min(GIT_TIMEOUT_MS, deadline - Date.now());
    const stagedOutput = timeout > 0
      ? tryGit(repository.root, ['diff', '--cached', '--name-only'], timeout)
      : null;
    if (stagedOutput === null) throw new Error('Bounded staged-state inspection could not complete reliably.');
    const staged = Boolean(stagedOutput);
    return {
      ...common,
      descriptor: {
        kind: 'staged',
        revision: `index@${repository.head}`,
        dirty: staged,
        staged: true,
        repository: repository.origin,
      },
    };
  }
  return {
    ...common,
    descriptor: {
      kind: 'worktree',
      revision: `worktree@${repository.head}`,
      dirty: repository.dirty,
      staged: false,
      repository: repository.origin,
    },
  };
}

function statusResult(
  item: ShareItem,
  status: VerificationStatus,
  reason: string,
  extra: Partial<VerificationItemResult> = {},
): VerificationItemResult {
  return {
    itemId: item.id,
    itemKind: item.kind,
    status,
    reason,
    ...extra,
  };
}

function validatePinForItem(
  item: FileItem | Extract<ShareItem, { kind: 'excerpt' }>,
): ParsedCitationPin {
  const pin = parseCitationPin(item.pin);
  if (
    pin.path !== item.path
    || pin.blob !== item.blob
    || (item.kind === 'file' && pin.range !== undefined)
    || (
      item.kind === 'excerpt'
      && (
        !pin.range
        || pin.range.start !== item.range.start
        || pin.range.end !== item.range.end
      )
    )
  ) {
    throw new Error('Citation pin does not match its Share item.');
  }
  return pin;
}

function verifyCitation(
  bundle: ShareBundle,
  item: FileItem | Extract<ShareItem, { kind: 'excerpt' }>,
  target: ResolvedTarget,
): VerificationItemResult {
  let pin: ParsedCitationPin;
  try {
    pin = validatePinForItem(item);
  } catch (error) {
    return statusResult(item, 'unverifiable', error instanceof Error ? error.message : 'Citation pin is invalid.', {
      citationPath: item.path,
      citationRange: item.kind === 'excerpt' ? item.range : undefined,
    });
  }
  const original = bundle.blobs.get(item.blob);
  if (!original || `sha256:${createHash('sha256').update(original).digest('hex')}` !== pin.blob) {
    return statusResult(item, 'unverifiable', 'The original cited bytes are unavailable or invalid.', {
      citationPath: pin.path,
      citationRange: pin.range,
    });
  }
  const baseRevision = pin.revision === 'worktree' || pin.revision === 'index'
    ? bundle.cut.manifest.origin.head
    : pin.revision;
  let base = target.baseCache.get(baseRevision);
  if (!target.baseCache.has(baseRevision)) {
    const timeout = Math.min(GIT_TIMEOUT_MS, target.deadline - Date.now());
    base = timeout > 0 ? resolveCommit(target.repository.root, baseRevision, timeout) : null;
    target.baseCache.set(baseRevision, base);
  }
  if (!base) {
    return statusResult(item, 'unverifiable', 'The citation base revision cannot be resolved in this repository.', {
      citationPath: pin.path,
      citationRange: pin.range,
    });
  }

  const file = targetFile(target, pin.path);
  if (file.state === 'unverifiable') {
    return statusResult(item, 'unverifiable', file.reason ?? 'The comparison file could not be verified.', {
      citationPath: pin.path,
      citationRange: pin.range,
    });
  }
  if (file.state === 'exists') {
    const exactAtCitation = item.kind === 'file'
      ? file.content!.equals(original)
      : rangeBytes(file.content!, pin.range!)?.equals(original) === true;
    if (exactAtCitation) {
      return statusResult(item, 'current', 'The exact cited bytes match at the cited path and range.', {
        citationPath: pin.path,
        citationRange: pin.range,
        resolvedPath: pin.path,
        resolvedRange: pin.range ?? rangeForMatch(file.content!, 0, original),
        method: 'cited-range',
      });
    }
    const matches = exactLineMatches(file.content!, original);
    if (matches.length > 1) {
      return statusResult(item, 'ambiguous', 'The exact cited bytes occur at multiple line ranges in the cited file.', {
        citationPath: pin.path,
        citationRange: pin.range,
        resolvedPath: pin.path,
      });
    }
    if (matches.length === 1) {
      return statusResult(item, 'moved', 'The exact cited bytes moved to one unique range in the cited file.', {
        citationPath: pin.path,
        citationRange: pin.range,
        resolvedPath: pin.path,
        resolvedRange: matches[0],
        method: 'same-file-exact',
      });
    }
    return statusResult(item, 'drifted', 'The cited path exists, but the exact cited bytes no longer match or occur uniquely.', {
      citationPath: pin.path,
      citationRange: pin.range,
      resolvedPath: pin.path,
    });
  }

  const renames = renameCandidates(target, base, pin.path);
  if (renames.boundedFailure) {
    return statusResult(item, 'unverifiable', 'Bounded Git rename resolution could not complete reliably.', {
      citationPath: pin.path,
      citationRange: pin.range,
    });
  }
  if (renames.paths.length > 1) {
    return statusResult(item, 'ambiguous', 'Git resolved multiple possible renamed paths.', {
      citationPath: pin.path,
      citationRange: pin.range,
    });
  }
  if (renames.paths.length === 0) {
    return statusResult(item, 'deleted', 'The cited path is absent and bounded Git rename resolution found no replacement.', {
      citationPath: pin.path,
      citationRange: pin.range,
    });
  }
  const renamedPath = renames.paths[0];
  const renamed = targetFile(target, renamedPath);
  if (renamed.state !== 'exists') {
    return statusResult(
      item,
      renamed.state === 'missing' ? 'deleted' : 'unverifiable',
      renamed.reason ?? 'The Git-resolved renamed path is not available.',
      { citationPath: pin.path, citationRange: pin.range, resolvedPath: renamedPath },
    );
  }
  const matches = exactLineMatches(renamed.content!, original);
  if (matches.length > 1) {
    return statusResult(item, 'ambiguous', 'The exact cited bytes occur at multiple ranges in the renamed file.', {
      citationPath: pin.path,
      citationRange: pin.range,
      resolvedPath: renamedPath,
    });
  }
  if (matches.length === 1) {
    return statusResult(item, 'moved', 'Git resolved a rename and the exact cited bytes have one unique range.', {
      citationPath: pin.path,
      citationRange: pin.range,
      resolvedPath: renamedPath,
      resolvedRange: matches[0],
      method: 'git-rename-exact',
    });
  }
  return statusResult(item, 'drifted', 'Git resolved a renamed path, but the exact cited bytes no longer occur uniquely.', {
    citationPath: pin.path,
    citationRange: pin.range,
    resolvedPath: renamedPath,
  });
}

function emptyCounts(): Record<VerificationStatus, number> {
  return {
    current: 0,
    moved: 0,
    drifted: 0,
    deleted: 0,
    ambiguous: 0,
    unverifiable: 0,
  };
}

function aggregateFor(counts: Record<VerificationStatus, number>): VerificationReport['aggregate'] {
  const total = VERIFICATION_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  if (counts.unverifiable === total) return 'unverifiable';
  if (counts.current === total) return 'current';
  if (counts.current > 0 || counts.moved > 0) return 'partially_outdated';
  return 'outdated';
}

function receiptFor(
  shareDigest: string,
  toolVersion: string,
  target: VerificationTarget,
  repositoryMatch: VerificationReport['repositoryMatch'],
  counts: Record<VerificationStatus, number>,
  items: VerificationItemResult[],
): VerificationReceipt {
  const material: VerificationReceiptMaterial = {
    schemaVersion: 1,
    shareDigest,
    toolVersion,
    trust: 'locally_verified',
    comparison: target,
    repositoryMatch,
    counts,
    items: items.map((item) => ({
      itemId: item.itemId,
      status: item.status,
      resolvedPath: item.resolvedPath,
      resolvedRange: item.resolvedRange,
      method: item.method,
    })),
  };
  const receiptDigest = `sha256:${createHash('sha256')
    .update(`neurcode-verification-receipt-v1\n${canonicalize(material)}`, 'utf8')
    .digest('hex')}`;
  return { ...material, receiptDigest };
}

export function verifyShareBundle(input: {
  bundle: ShareBundle;
  repoPath: string;
  against?: string;
  staged?: boolean;
  toolVersion: string;
  entirelyLocal: boolean;
}): VerificationReport {
  const target = resolveTarget(input.repoPath, { against: input.against, staged: input.staged });
  const shareOrigin = input.bundle.cut.manifest.origin.remote;
  const repositoryMatch: VerificationReport['repositoryMatch'] = (
    shareOrigin.startsWith('local/opaque-') || shareOrigin.startsWith('remote/opaque-')
  )
    ? 'unverifiable'
    : shareOrigin === target.repository.origin
      ? 'matched'
      : 'mismatched';

  const items = input.bundle.cut.pack.items.map((item): VerificationItemResult => {
    if (repositoryMatch !== 'matched') {
      return statusResult(
        item,
        'unverifiable',
        repositoryMatch === 'mismatched'
          ? 'The comparison repository identity does not match the Share.'
          : 'The Share does not contain a verifiable repository identity.',
        {
          citationPath: item.kind === 'file' || item.kind === 'excerpt' ? item.path : undefined,
          citationRange: item.kind === 'excerpt' ? item.range : undefined,
        },
      );
    }
    if (item.kind !== 'file' && item.kind !== 'excerpt') {
      return statusResult(
        item,
        'unverifiable',
        `${item.kind} items do not carry a source citation pin in Share Format cut 1.`,
      );
    }
    return verifyCitation(input.bundle, item, target);
  });
  const counts = emptyCounts();
  for (const item of items) counts[item.status] += 1;
  const disclosure = target.descriptor.kind === 'revision'
    ? `clean committed comparison at ${target.descriptor.revision}`
    : target.descriptor.kind === 'staged'
      ? `${target.descriptor.dirty ? 'changed' : 'unchanged'} staged index against ${target.repository.head}`
      : `${target.descriptor.dirty ? 'dirty' : 'clean'} worktree at ${target.repository.head}`;
  return {
    schemaVersion: 1,
    shareDigest: input.bundle.cut.manifest.digest,
    comparison: target.descriptor,
    repositoryMatch,
    aggregate: aggregateFor(counts),
    counts,
    dirtyStateDisclosure: disclosure,
    entirelyLocal: input.entirelyLocal,
    items,
    receipt: receiptFor(
      input.bundle.cut.manifest.digest,
      input.toolVersion,
      target.descriptor,
      repositoryMatch,
      counts,
      items,
    ),
  };
}

export function normalizedVerificationJson(report: VerificationReport): string {
  return `${canonicalize(report)}\n`;
}

export function humanVerification(report: VerificationReport): string {
  const symbols: Record<VerificationStatus, string> = {
    current: '✓',
    moved: '↪',
    drifted: '!',
    deleted: '×',
    ambiguous: '?',
    unverifiable: '?',
  };
  const labels: Record<VerificationStatus, string> = {
    current: 'current',
    moved: 'moved',
    drifted: 'drifted',
    deleted: 'deleted',
    ambiguous: 'ambiguous',
    unverifiable: 'unverifiable',
  };
  const lines = [
    'Share verification',
    '',
    `Digest: ${report.shareDigest}`,
    `Compared against: ${report.dirtyStateDisclosure}`,
    `Repository: ${report.repositoryMatch}`,
    `Entirely local: ${report.entirelyLocal ? 'yes' : 'no (the Share archive was fetched)'}`,
    '',
  ];
  for (const item of report.items) {
    const from = item.citationPath
      ? `${item.citationPath}${item.citationRange ? `:${item.citationRange.start}-${item.citationRange.end}` : ''}`
      : item.itemKind;
    const to = item.resolvedPath && (
      item.resolvedPath !== item.citationPath
      || item.resolvedRange?.start !== item.citationRange?.start
      || item.resolvedRange?.end !== item.citationRange?.end
    )
      ? ` → ${item.resolvedPath}${item.resolvedRange ? `:${item.resolvedRange.start}-${item.resolvedRange.end}` : ''}`
      : '';
    lines.push(`${symbols[item.status]} ${item.itemId} ${labels[item.status]} · ${from}${to}`);
    if (item.status !== 'current') lines.push(`  ${item.reason}`);
  }
  lines.push(
    '',
    ...VERIFICATION_STATUSES
      .filter((status) => report.counts[status] > 0)
      .map((status) => `${symbols[status]} ${report.counts[status]} ${labels[status]}`),
    '',
    report.aggregate === 'current'
      ? 'This Share matches the selected repository state.'
      : report.aggregate === 'unverifiable'
        ? 'This Share could not be verified against the selected repository state.'
        : report.aggregate === 'partially_outdated'
          ? 'This Share is partially outdated.'
          : 'This Share is outdated.',
    'Verification compares cited bytes only; it does not prove code correctness.',
  );
  return `${lines.join('\n')}\n`;
}

export function comparisonBytes(input: {
  repoPath: string;
  against?: string;
  staged?: boolean;
  path: string;
  range?: { start: number; end: number };
}): { bytes: Buffer; target: VerificationTarget; repository: RepositorySnapshot } {
  const target = resolveTarget(input.repoPath, { against: input.against, staged: input.staged });
  const file = targetFile(target, input.path);
  if (file.state !== 'exists' || !file.content) {
    throw new Error(file.reason ?? `Reviewed replacement does not exist: ${input.path}`);
  }
  const bytes = input.range ? rangeBytes(file.content, input.range) : file.content;
  if (!bytes) throw new Error(`Reviewed replacement range is outside ${input.path}.`);
  return { bytes: Buffer.from(bytes), target: target.descriptor, repository: target.repository };
}
