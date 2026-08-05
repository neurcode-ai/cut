import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { SHARE_LIMITS, sanitizeRepoRelativePath } from '@neurcode-ai/share-format';
import { discoverShareRepository, readShareSelections } from './git-reader';

export interface ComposerRepositoryData {
  repository: ReturnType<typeof discoverShareRepository>;
  files: Array<{ path: string; bytes: number; changed: boolean; staged: boolean }>;
  currentChanges: string[];
  stagedChanges: string[];
  recentCommits: Array<{
    sha: string;
    shortSha: string;
    parent: string | null;
    subject: string;
    range: string | null;
    files: string[];
  }>;
}

function git(root: string, args: string[], maxBuffer = 32 * 1024 * 1024): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer,
  });
}

function nulPaths(root: string, args: string[]): string[] {
  const output = git(root, args);
  return output.split('\0').filter(Boolean).map((path) => sanitizeRepoRelativePath(root, path));
}

function sensitivePath(path: string): boolean {
  const lower = path.toLowerCase();
  const parts = lower.split('/');
  const base = parts.at(-1) ?? '';
  return /^\.env(?:\.|$)/i.test(base)
    || parts.some((part) => ['.git', '.aws', '.ssh', '.gnupg', '.azure', '.kube', '.docker'].includes(part))
    || ['.netrc', '_netrc', '.npmrc', '.pypirc', 'credentials', 'credentials.json', 'service-account.json',
      'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'].includes(base)
    || /\.(?:key|pem|p12|pfx)$/i.test(base);
}

function safeVisibleFile(root: string, path: string): { path: string; bytes: number } | null {
  if (sensitivePath(path)) return null;
  try {
    const absolute = resolve(root, path);
    if (lstatSync(absolute).isSymbolicLink()) return null;
    const real = realpathSync(absolute);
    sanitizeRepoRelativePath(root, real);
    const info = statSync(real);
    if (!info.isFile() || info.size > SHARE_LIMITS.maxTextBlobBytes) return null;
    return { path, bytes: info.size };
  } catch {
    return null;
  }
}

export function readComposerRepository(cwd: string): ComposerRepositoryData {
  const repository = discoverShareRepository(cwd);
  const currentChanges = nulPaths(repository.root, [
    'diff', '--name-only', '-z', '--no-ext-diff', '--no-textconv', 'HEAD',
  ]).filter((path) => !sensitivePath(path));
  const stagedChanges = nulPaths(repository.root, [
    'diff', '--cached', '--name-only', '-z', '--no-ext-diff', '--no-textconv',
  ]).filter((path) => !sensitivePath(path));
  const current = new Set(currentChanges);
  const staged = new Set(stagedChanges);
  const listed = nulPaths(repository.root, [
    'ls-files', '-z', '--cached', '--others', '--exclude-standard',
  ]);
  const files = listed
    .slice(0, 10_000)
    .map((path) => safeVisibleFile(repository.root, path))
    .filter((entry): entry is { path: string; bytes: number } => Boolean(entry))
    .slice(0, 5_000)
    .map((entry) => ({
      ...entry,
      changed: current.has(entry.path),
      staged: staged.has(entry.path),
    }));

  const commitRecords = git(repository.root, [
    'log', '-8', '--format=%H%x00%P%x00%s%x00',
  ]).split('\0');
  const recentCommits: ComposerRepositoryData['recentCommits'] = [];
  for (let index = 0; index + 2 < commitRecords.length; index += 3) {
    const sha = commitRecords[index]?.trim();
    const parents = commitRecords[index + 1]?.trim().split(/\s+/).filter(Boolean) ?? [];
    const subject = commitRecords[index + 2]?.trim().slice(0, 240) ?? '';
    if (!/^[a-f0-9]{40,64}$/i.test(sha)) continue;
    const parent = parents[0] ?? null;
    const changed = parent
      ? nulPaths(repository.root, ['diff', '--name-only', '-z', parent, sha]).filter((path) => !sensitivePath(path))
      : [];
    recentCommits.push({
      sha,
      shortSha: sha.slice(0, 8),
      parent,
      subject,
      range: parent ? `${parent}..${sha}` : null,
      files: changed.slice(0, 200),
    });
  }
  return { repository, files, currentChanges, stagedChanges, recentCommits };
}

export function readComposerFile(cwd: string, requestedPath: string): {
  path: string;
  language?: string;
  provenance: string;
  bytes: number;
  content: string;
  lines: string[];
} {
  if (
    typeof requestedPath !== 'string'
    || requestedPath.length > 4_096
    || sensitivePath(requestedPath)
    || requestedPath.startsWith('-')
  ) {
    throw new Error('This path is not available to the Cut Composer.');
  }
  const selection = readShareSelections(cwd, {
    selections: [requestedPath],
    staged: false,
    diff: false,
    forceInclude: [],
    stripContext: [],
  });
  const item = selection.items[0];
  if (!item || item.kind !== 'file') throw new Error('The selected path is not a regular text file.');
  const content = selection.blobs.get(item.blob)?.toString('utf8');
  if (content === undefined) throw new Error('The selected file content is unavailable.');
  return {
    path: item.path,
    language: item.language,
    provenance: item.provenance,
    bytes: item.bytes,
    content,
    lines: content.split('\n'),
  };
}

export function composerGitDirectory(cwd: string): string {
  const repository = discoverShareRepository(cwd);
  const gitDir = git(repository.root, ['rev-parse', '--git-dir']).trim();
  const absolute = resolve(repository.root, gitDir);
  return realpathSync(absolute);
}
