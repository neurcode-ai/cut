import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';
import type { CompileDiff } from './model';

const COMMIT = /^[a-f0-9]{40,64}$/i;
const MAX_GIT_BUFFER = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export interface ChangedPath {
  status: 'A' | 'D' | 'M' | 'R' | 'C' | 'T' | 'U' | 'X' | 'B';
  path: string;
  oldPath?: string;
}

export interface ChangedHunk {
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface DiffSnapshot {
  repositoryRoot: string;
  kind: CompileDiff['kind'];
  base: string;
  head: string;
  text: string;
  changed: ChangedPath[];
  hunks: ChangedHunk[];
}

function runGit(
  root: string,
  args: string[],
  encoding: BufferEncoding | 'buffer' = 'utf8',
  timeout = 10_000,
): string | Buffer {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      encoding,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      maxBuffer: MAX_GIT_BUFFER,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Context compiler Git command failed (${args[0] ?? 'git'}): ${detail}`);
  }
}

function gitText(root: string, args: string[], timeout?: number): string {
  return String(runGit(root, args, 'utf8', timeout)).trim();
}

function gitBuffer(root: string, args: string[], timeout?: number): Buffer {
  return runGit(root, args, 'buffer', timeout) as Buffer;
}

export function discoverRepositoryRoot(requestedRoot: string): string {
  const root = gitText(requestedRoot, ['rev-parse', '--show-toplevel']);
  const real = realpathSync(root);
  const requestedReal = realpathSync(requestedRoot);
  if (requestedReal !== real && !requestedReal.startsWith(`${real}${sep}`)) {
    throw new Error('Context compiler repository root does not contain the requested working directory.');
  }
  return real;
}

export function safeRepositoryPath(root: string, value: string): string {
  if (
    !value
    || value.includes('\0')
    || value.includes('\\')
    || value.startsWith('/')
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Context compiler received an unsafe repository path: ${JSON.stringify(value)}`);
  }
  const absolute = resolve(root, value);
  const back = relative(root, absolute).split(sep).join('/');
  if (!back || back.startsWith('../') || isAbsolute(back)) {
    throw new Error(`Context compiler path escapes the repository: ${JSON.stringify(value)}`);
  }
  return back;
}

function parseNameStatus(root: string, bytes: Buffer): ChangedPath[] {
  const tokens = bytes.toString('utf8').split('\0');
  if (tokens.at(-1) === '') tokens.pop();
  const result: ChangedPath[] = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    const raw = tokens[cursor++];
    if (!/^[A-Z][0-9]*$/.test(raw)) {
      throw new Error('Context compiler could not parse Git name-status output.');
    }
    const status = raw[0] as ChangedPath['status'];
    const first = tokens[cursor++];
    if (!first) throw new Error('Context compiler received an incomplete Git path record.');
    if (status === 'R' || status === 'C') {
      const second = tokens[cursor++];
      if (!second) throw new Error('Context compiler received an incomplete Git rename record.');
      result.push({
        status,
        oldPath: safeRepositoryPath(root, first),
        path: safeRepositoryPath(root, second),
      });
    } else {
      result.push({ status, path: safeRepositoryPath(root, first) });
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path) || left.status.localeCompare(right.status));
}

function parseHunks(changed: ChangedPath[], diff: string): ChangedHunk[] {
  const hunks: ChangedHunk[] = [];
  const diffOrder: ChangedPath[] = [];
  let current: ChangedPath | undefined;
  let fileCursor = 0;
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      current = changed[fileCursor++];
      if (!current) throw new Error('Context compiler diff parser observed more file records than name-status.');
      diffOrder.push(current);
      continue;
    }
    if (!line.startsWith('@@')) continue;
    if (!current) throw new Error('Context compiler diff parser observed a hunk before a file record.');
    const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!match) throw new Error(`Context compiler could not parse a unified diff hunk header: ${line.slice(0, 200)}`);
    hunks.push({
      path: current.path,
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    });
  }
  if (fileCursor !== changed.length) {
    throw new Error('Context compiler diff parser file count does not match Git name-status.');
  }
  const expectedOrder = changed.map((entry) => entry.path);
  const actualOrder = diffOrder.map((entry) => entry.path);
  if (JSON.stringify(actualOrder) !== JSON.stringify(expectedOrder)) {
    throw new Error('Context compiler diff parser file ordering is internally inconsistent.');
  }
  return hunks;
}

function safeRevision(value: string): string {
  if (!value || value.length > 1_024 || value.startsWith('-') || /[\0\r\n]/.test(value)) {
    throw new Error(`Unsafe Git revision in context compiler diff: ${JSON.stringify(value)}`);
  }
  return value;
}

function resolveCommit(root: string, value: string): string {
  const resolved = gitText(root, ['rev-parse', '--verify', `${safeRevision(value)}^{commit}`]);
  if (!COMMIT.test(resolved)) throw new Error(`Git revision is not a commit: ${value}`);
  return resolved;
}

export function readDiffSnapshot(requestedRoot: string, requested: CompileDiff): DiffSnapshot {
  const root = discoverRepositoryRoot(requestedRoot);
  const repositoryHead = resolveCommit(root, 'HEAD');
  let diffArgs: string[];
  let statusArgs: string[];
  let base: string;
  let head: string;

  if (requested.kind === 'staged') {
    diffArgs = ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index', '--unified=0'];
    statusArgs = ['diff', '--cached', '--name-status', '-z', '--find-renames'];
    base = repositoryHead;
    head = 'index';
  } else if (requested.kind === 'range') {
    const match = requested.range.match(/^(.+)\.\.(.+)$/);
    if (!match) throw new Error('Context compiler revision ranges must use A..B.');
    base = resolveCommit(root, match[1]);
    head = resolveCommit(root, match[2]);
    if (repositoryHead !== head) {
      throw new Error(`Context compiler range head must be checked out exactly (${head}).`);
    }
    const dirty = gitText(root, ['status', '--porcelain=v1', '--untracked-files=no']);
    if (dirty) throw new Error('Context compiler range analysis requires a clean tracked worktree at the range head.');
    diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index', '--unified=0', base, head];
    statusArgs = ['diff', '--name-status', '-z', '--find-renames', base, head];
  } else {
    diffArgs = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index', '--unified=0', 'HEAD'];
    statusArgs = ['diff', '--name-status', '-z', '--find-renames', 'HEAD'];
    base = repositoryHead;
    head = 'worktree';
  }

  const changed = parseNameStatus(root, gitBuffer(root, statusArgs));
  if (changed.length === 0) throw new Error('Context compiler diff is empty.');
  if (requested.kind === 'staged') {
    const unstaged = new Set(
      gitBuffer(root, ['diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv'])
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
        .map((path) => safeRepositoryPath(root, path)),
    );
    const overlap = changed.map((entry) => entry.path).filter((path) => unstaged.has(path));
    if (overlap.length) {
      throw new Error('Context compiler staged analysis requires staged paths to have no additional unstaged edits.');
    }
  }
  const text = gitBuffer(root, diffArgs).toString('utf8');
  if (!text) throw new Error('Context compiler diff is empty.');
  return {
    repositoryRoot: root,
    kind: requested.kind,
    base,
    head,
    text,
    changed,
    hunks: parseHunks(changed, text),
  };
}

export function listRepositoryPaths(root: string, includeUntracked: boolean): string[] {
  const args = includeUntracked
    ? ['ls-files', '-z', '--cached', '--others', '--exclude-standard']
    : ['ls-files', '-z', '--cached'];
  return gitBuffer(root, args)
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((path) => safeRepositoryPath(root, path))
    .sort((left, right) => left.localeCompare(right));
}

export function batchIgnoredPaths(root: string, paths: string[]): Set<string> {
  if (paths.length === 0) return new Set();
  const input = Buffer.from(`${paths.join('\0')}\0`, 'utf8');
  const result = spawnSync('git', ['-C', root, 'check-ignore', '--no-index', '-z', '--stdin'], {
    input,
    encoding: 'buffer',
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: MAX_GIT_BUFFER,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(`Context compiler batched git check-ignore failed: ${result.error?.message ?? result.stderr?.toString('utf8') ?? `status ${result.status}`}`);
  }
  return new Set(
    (result.stdout as Buffer)
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((path) => safeRepositoryPath(root, path)),
  );
}

export function readRepositoryText(root: string, path: string): string {
  const safe = safeRepositoryPath(root, path);
  const absolute = resolve(root, safe);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink()) throw new Error(`Context compiler will not read symbolic links: ${safe}`);
  const real = realpathSync(absolute);
  safeRepositoryPath(root, relative(root, real).split(sep).join('/'));
  const stat = statSync(real);
  if (!stat.isFile()) throw new Error(`Context compiler path is not a regular file: ${safe}`);
  if (stat.size > MAX_SOURCE_BYTES) throw new Error(`Context compiler source file exceeds ${MAX_SOURCE_BYTES} bytes: ${safe}`);
  const content = readFileSync(real);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error(`Context compiler source is not valid UTF-8: ${safe}`);
  }
}
