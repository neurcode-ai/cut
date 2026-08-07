import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import {
  SHARE_LIMITS,
  sanitizeRepoRelativePath,
} from '@neurcode-ai/share-format';
import {
  discoverShareRepository,
  exclusionReason,
  looksBinary,
  type RepositorySnapshot,
} from './git-reader';

const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_PATHSPEC_BYTES = 64 * 1024;

export interface ProposedGitWorkingSet {
  captureMode: 'zero-argument';
  repository: RepositorySnapshot;
  scope: string;
  selections: string[];
  diffPaths: string[];
  exclusions: string[];
  sourceBytes: number;
  diffBytes: number;
  initialItemCount: number;
}

interface ChangeRecord {
  status: string;
  paths: string[];
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function gitBuffer(root: string, args: string[]): Buffer {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
  });
}

function nulValues(root: string, args: string[]): string[] {
  const values = gitBuffer(root, args).toString('utf8').split('\0');
  if (values.at(-1) === '') values.pop();
  return values;
}

function changeRecords(root: string, scope: string): ChangeRecord[] {
  const values = nulValues(root, [
    'diff', '--name-status', '-z', '--find-renames', '--no-ext-diff', '--no-textconv',
    'HEAD', '--', scope || '.',
  ]);
  const records: ChangeRecord[] = [];
  let cursor = 0;
  while (cursor < values.length) {
    let status = values[cursor++];
    const paths: string[] = [];
    const tab = status.indexOf('\t');
    if (tab >= 0) {
      paths.push(status.slice(tab + 1));
      status = status.slice(0, tab);
    } else {
      const first = values[cursor++];
      if (first) paths.push(first);
    }
    if (!/^[A-Z][0-9]*$/.test(status) || paths.length !== 1) {
      throw new Error('Git returned an invalid working-set change record.');
    }
    if (status[0] === 'R' || status[0] === 'C') {
      const second = values[cursor++];
      if (!second) throw new Error('Git returned an incomplete working-set rename record.');
      paths.push(second);
    }
    records.push({
      status,
      paths: paths.map((path) => sanitizeRepoRelativePath(root, path)),
    });
  }
  return records;
}

function repositoryScope(root: string, cwd: string): string {
  const resolvedRoot = realpathSync(root);
  const resolvedCwd = realpathSync(cwd);
  const value = relative(resolvedRoot, resolvedCwd);
  if (value === '') return '';
  if (value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error('The zero-argument working set must stay inside the current Git repository.');
  }
  return value.split(sep).join('/');
}

function safeSource(
  repository: RepositorySnapshot,
  path: string,
): { bytes: number; exclusion?: string } {
  const reason = exclusionReason(path);
  if (reason) return { bytes: 0, exclusion: reason };
  if (/[\u0000-\u001f\u007f]/.test(path)) {
    return { bytes: 0, exclusion: 'control characters in paths are not supported' };
  }
  const absolute = resolve(repository.root, path);
  try {
    const link = lstatSync(absolute);
    if (link.isSymbolicLink()) return { bytes: 0, exclusion: 'symbolic links are not captured' };
    if (link.isDirectory()) return { bytes: 0, exclusion: 'submodule boundary is represented only by Git diff metadata' };
    if (!link.isFile()) return { bytes: 0, exclusion: 'only regular files are captured' };
    const resolved = realpathSync(absolute);
    sanitizeRepoRelativePath(repository.root, resolved);
    const info = statSync(resolved);
    if (info.size === 0) return { bytes: 0, exclusion: 'empty files are represented only by the diff when tracked' };
    if (info.size > SHARE_LIMITS.maxTextBlobBytes) {
      return { bytes: 0, exclusion: `file exceeds the ${SHARE_LIMITS.maxTextBlobBytes}-byte text limit` };
    }
    const content = readFileSync(resolved);
    if (looksBinary(content)) return { bytes: 0, exclusion: 'binary files are represented only by Git diff metadata when tracked' };
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      return { bytes: 0, exclusion: 'non-UTF-8 files are represented only by Git diff metadata when tracked' };
    }
    return { bytes: content.length };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { bytes: 0, exclusion: 'deleted file is represented by the Git diff' };
    return { bytes: 0, exclusion: 'file could not be inspected safely' };
  }
}

export function proposeGitWorkingSet(cwd = process.cwd()): ProposedGitWorkingSet {
  const repository = discoverShareRepository(cwd, { requireBoundedStatus: true });
  const scope = repositoryScope(repository.root, cwd);
  const records = changeRecords(repository.root, scope);
  const untracked = nulValues(repository.root, [
    'ls-files', '-z', '--others', '--exclude-standard', '--', scope || '.',
  ]).map((path) => sanitizeRepoRelativePath(repository.root, path));
  const candidates = [...new Set([
    ...records.flatMap((record) => record.paths),
    ...untracked,
  ])].sort(comparePath);

  if (candidates.length > SHARE_LIMITS.maxItems) {
    throw new Error(
      `The Git working set contains ${candidates.length} changed or untracked paths, exceeding the `
      + `${SHARE_LIMITS.maxItems}-item review bound. Select a smaller explicit set; nothing was truncated or uploaded.`,
    );
  }

  const exclusions: string[] = ['Git-ignored paths are excluded by construction.'];
  const selections: string[] = [];
  let sourceBytes = 0;
  for (const path of candidates) {
    const source = safeSource(repository, path);
    if (source.exclusion) {
      exclusions.push(`${path}: ${source.exclusion}`);
      continue;
    }
    selections.push(path);
    sourceBytes += source.bytes;
  }

  const diffPaths = records
    .filter((record) => {
      const denied = record.paths.find((path) => exclusionReason(path));
      if (denied) {
        exclusions.push(`${record.paths.join(' -> ')}: sensitive-path change excluded from the proposed diff`);
        return false;
      }
      return true;
    })
    .map((record) => record.paths.at(-1) as string)
    .sort(comparePath);
  const pathspecBytes = diffPaths.reduce((sum, path) => sum + Buffer.byteLength(path) + 1, 0);
  if (pathspecBytes > MAX_PATHSPEC_BYTES) {
    throw new Error(
      `The proposed diff pathspec exceeds the ${MAX_PATHSPEC_BYTES}-byte traversal bound. `
      + 'Select a smaller explicit set; nothing was truncated or uploaded.',
    );
  }

  const diff = diffPaths.length
    ? gitBuffer(repository.root, [
        'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index',
        'HEAD', '--', ...diffPaths,
      ])
    : Buffer.alloc(0);
  if (diff.length > SHARE_LIMITS.maxTextBlobBytes) {
    throw new Error(
      `The proposed unified diff is ${diff.length} bytes, exceeding the `
      + `${SHARE_LIMITS.maxTextBlobBytes}-byte diff bound. Select a smaller explicit set; nothing was truncated or uploaded.`,
    );
  }
  const initialItemCount = selections.length + (diff.length ? 1 : 0);
  if (initialItemCount > SHARE_LIMITS.maxItems) {
    throw new Error(
      `The proposed working set contains ${initialItemCount} items, exceeding the `
      + `${SHARE_LIMITS.maxItems}-item bound. Select a smaller explicit set; nothing was truncated or uploaded.`,
    );
  }
  if (sourceBytes + diff.length > SHARE_LIMITS.maxAggregateBlobBytes) {
    throw new Error(
      `The proposed working set is ${sourceBytes + diff.length} bytes, exceeding the `
      + `${SHARE_LIMITS.maxAggregateBlobBytes}-byte aggregate bound. Select a smaller explicit set; nothing was truncated or uploaded.`,
    );
  }

  return {
    captureMode: 'zero-argument',
    repository,
    scope,
    selections,
    diffPaths,
    exclusions: [...new Set(exclusions)],
    sourceBytes,
    diffBytes: diff.length,
    initialItemCount,
  };
}
