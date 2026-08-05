import { execFileSync, spawnSync } from 'node:child_process';
import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { parseDiff } from '../diff-parser';
import {
  SHARE_LIMITS,
  makePin,
  sanitizeRepoRelativePath,
  sanitizedOrigin,
  sha256Bytes,
  type DiffItem,
  type ExcerptItem,
  type FileItem,
  type ProvenanceGrade,
  type ShareItem,
} from '@neurcode-ai/share-format';

export interface RepositorySnapshot {
  root: string;
  name: string;
  origin: string;
  head: string;
  branch: string;
  dirty: boolean;
}

export interface SelectionOptions {
  selections: string[];
  staged: boolean;
  diff: boolean | string;
  forceInclude: string[];
  stripContext: string[];
  allowEmpty?: boolean;
}

export interface SelectionResult {
  repository: RepositorySnapshot;
  items: ShareItem[];
  blobs: Map<string, Buffer>;
  warnings: string[];
}

interface ParsedSelection {
  original: string;
  path: string;
  direct: boolean;
  range?: { start: number; end: number };
}

export interface RepositoryDiscoveryOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  requireBoundedStatus?: boolean;
}

function git(
  root: string,
  args: string[],
  encoding: BufferEncoding = 'utf8',
  bounds: RepositoryDiscoveryOptions = {},
): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding,
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: bounds.timeoutMs ?? 10_000,
    maxBuffer: bounds.maxBuffer ?? 32 * 1024 * 1024,
  }).trim();
}

function gitBuffer(root: string, args: string[]): Buffer {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  });
}

function tryGit(root: string, args: string[], bounds: RepositoryDiscoveryOptions = {}): string | null {
  try {
    return git(root, args, 'utf8', bounds);
  } catch {
    return null;
  }
}

export function discoverShareRepository(
  cwd = process.cwd(),
  bounds: RepositoryDiscoveryOptions = {},
): RepositorySnapshot {
  const root = tryGit(cwd, ['rev-parse', '--show-toplevel'], bounds);
  if (!root) throw new Error('Cut by Neurcode must run inside a Git repository.');
  const head = tryGit(root, ['rev-parse', '--verify', 'HEAD'], bounds);
  if (!head || !/^[a-f0-9]{40,64}$/i.test(head)) {
    throw new Error('Cut by Neurcode requires a repository with at least one commit.');
  }
  const remote = tryGit(root, ['remote', 'get-url', 'origin'], bounds);
  const branch = tryGit(root, ['branch', '--show-current'], bounds) ?? '';
  let status: string | null;
  try {
    status = git(root, ['status', '--porcelain=v1', '--untracked-files=normal'], 'utf8', bounds);
  } catch {
    if (bounds.requireBoundedStatus) {
      throw new Error('Bounded Git status inspection could not complete reliably.');
    }
    status = null;
  }
  const dirty = Boolean(status);
  const normalizedRoot = realpathSync(root);
  return {
    root: normalizedRoot,
    name: normalizedRoot.split(/[\\/]/).filter(Boolean).pop() ?? 'repository',
    origin: sanitizedOrigin(remote, normalizedRoot),
    head,
    branch,
    dirty,
  };
}

function parseSelection(value: string): ParsedSelection {
  const match = value.match(/^(.*):(\d+)-(\d+)$/);
  if (!match) return { original: value, path: value, direct: true };
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (!match[1] || start < 1 || end < start) throw new Error(`Invalid line range: ${value}`);
  return { original: value, path: match[1], direct: true, range: { start, end } };
}

function walkFiles(
  root: string,
  directory: string,
  add: (path: string, bytes: number) => void,
): void {
  const visit = (absolute: string): void => {
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(absolute, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links cannot be shared in V0: ${sanitizeRepoRelativePath(root, child)}`);
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue;
        const relative = sanitizeRepoRelativePath(root, child);
        if (exclusionReason(relative) || isIgnored(root, relative)) continue;
        visit(child);
      } else if (entry.isFile()) {
        const relative = sanitizeRepoRelativePath(root, child);
        add(relative, statSync(child).size);
      }
    }
  };
  visit(directory);
}

function isIgnored(root: string, path: string): boolean {
  const result = spawnSync('git', ['-C', root, 'check-ignore', '--quiet', '--no-index', '--', path], {
    stdio: 'ignore',
    timeout: 5_000,
  });
  return result.status === 0;
}

function exclusionReason(path: string): string | null {
  const lower = path.toLowerCase();
  const parts = lower.split('/');
  const base = parts[parts.length - 1];
  if (parts.includes('.git')) return 'Git internals are excluded';
  if (/^\.env(?:\.|$)/i.test(base)) return 'environment files are excluded';
  if (parts.some((part) => ['.aws', '.ssh', '.gnupg', '.azure', '.kube', '.docker'].includes(part))) {
    return 'credential-store paths are excluded';
  }
  if (
    ['.netrc', '_netrc', '.npmrc', '.pypirc', 'credentials', 'credentials.json', 'service-account.json',
      'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'].includes(base)
    || /\.(?:key|pem|p12|pfx)$/i.test(base)
  ) {
    return 'credential files are excluded';
  }
  return null;
}

function looksBinary(content: Buffer): boolean {
  if (content.includes(0)) return true;
  const sample = content.subarray(0, Math.min(content.length, 8192));
  if (sample.length === 0) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / sample.length > 0.08;
}

function lineChunks(text: string): string[] {
  const chunks = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (chunks[chunks.length - 1] === '') chunks.pop();
  return chunks;
}

function lineSlice(content: Buffer, start: number, end: number): Buffer {
  const chunks = lineChunks(content.toString('utf8'));
  if (start > chunks.length) throw new Error(`Line range starts after end of file (${chunks.length} lines).`);
  if (end > chunks.length) throw new Error(`Line range ends after end of file (${chunks.length} lines).`);
  return Buffer.from(chunks.slice(start - 1, end).join(''), 'utf8');
}

function languageFor(path: string): string | undefined {
  const languages: Record<string, string> = {
    '.c': 'c',
    '.cc': 'cpp',
    '.cpp': 'cpp',
    '.css': 'css',
    '.go': 'go',
    '.html': 'html',
    '.java': 'java',
    '.js': 'javascript',
    '.json': 'json',
    '.jsx': 'jsx',
    '.md': 'markdown',
    '.py': 'python',
    '.rb': 'ruby',
    '.rs': 'rust',
    '.sh': 'shell',
    '.sql': 'sql',
    '.ts': 'typescript',
    '.tsx': 'tsx',
    '.yaml': 'yaml',
    '.yml': 'yaml',
  };
  return languages[extname(path).toLowerCase()];
}

function committedBytes(root: string, path: string): Buffer | null {
  try {
    return gitBuffer(root, ['show', `HEAD:${path}`]);
  } catch {
    return null;
  }
}

function addBlob(blobs: Map<string, Buffer>, content: Buffer): string {
  const hash = sha256Bytes(content);
  blobs.set(hash, content);
  return hash;
}

function expandSelections(
  repository: RepositorySnapshot,
  values: string[],
): { parsed: ParsedSelection[]; explicitlyNamedFiles: Set<string> } {
  const parsed: ParsedSelection[] = [];
  const explicitlyNamedFiles = new Set<string>();
  const selectionKeys = new Set<string>();
  const sizedPaths = new Set<string>();
  let aggregateBytes = 0;
  const addSelection = (selection: ParsedSelection, bytes: number): void => {
    const key = `${selection.path}:${selection.range?.start ?? ''}-${selection.range?.end ?? ''}`;
    if (selectionKeys.has(key)) return;
    if (selectionKeys.size >= SHARE_LIMITS.maxItems) {
      throw new Error(`Cut selection exceeds the ${SHARE_LIMITS.maxItems}-item limit during directory traversal.`);
    }
    if (!sizedPaths.has(selection.path)) {
      if (bytes > SHARE_LIMITS.maxTextBlobBytes) {
        throw new Error(`${selection.path}: exceeds the ${SHARE_LIMITS.maxTextBlobBytes}-byte text limit.`);
      }
      if (aggregateBytes + bytes > SHARE_LIMITS.maxAggregateBlobBytes) {
        throw new Error(`Cut selection exceeds the ${SHARE_LIMITS.maxAggregateBlobBytes}-byte aggregate limit during directory traversal.`);
      }
      aggregateBytes += bytes;
      sizedPaths.add(selection.path);
    }
    selectionKeys.add(key);
    parsed.push(selection);
  };
  for (const value of values) {
    const selection = parseSelection(value);
    const candidateAbsolute = resolve(repository.root, selection.path);
    const relative = candidateAbsolute === resolve(repository.root)
      ? '.'
      : sanitizeRepoRelativePath(repository.root, selection.path);
    const absolute = resolve(repository.root, relative);
    let info;
    try {
      info = lstatSync(absolute);
    } catch {
      throw new Error(`Selection does not exist: ${selection.path}`);
    }
    if (info.isSymbolicLink()) throw new Error(`Symbolic links cannot be shared in V0: ${relative}`);
    if (info.isDirectory()) {
      if (selection.range) throw new Error(`A line range cannot target a directory: ${selection.original}`);
      if (relative !== '.' && (exclusionReason(relative) || isIgnored(repository.root, relative))) {
        throw new Error(`${relative}: excluded directory. Name each intended file directly and use per-file --force-include where required.`);
      }
      walkFiles(repository.root, absolute, (child, bytes) =>
        addSelection({ original: selection.original, path: child, direct: false }, bytes));
    } else if (info.isFile()) {
      explicitlyNamedFiles.add(relative);
      addSelection({ ...selection, path: relative }, info.size);
    } else {
      throw new Error(`Only regular files can be shared in V0: ${relative}`);
    }
  }
  return { parsed, explicitlyNamedFiles };
}

function resolveForceSet(repository: RepositorySnapshot, values: string[]): Set<string> {
  return new Set(values.map((value) => sanitizeRepoRelativePath(repository.root, value)));
}

function validateSelectableFile(
  repository: RepositorySnapshot,
  path: string,
  directlyNamed: boolean,
  forceSet: Set<string>,
  warnings: string[],
): Buffer | null {
  const forced = forceSet.has(path);
  const reason = exclusionReason(path) ?? (isIgnored(repository.root, path) ? 'Git-ignored paths are excluded' : null);
  if (reason && !directlyNamed) {
    warnings.push(`${path}: ${reason} (directory selection did not explicitly name this file)`);
    return null;
  }
  if (reason && !forced) {
    throw new Error(`${path}: ${reason}. Name the file directly and add --force-include ${path} to override.`);
  }
  if (forced && !directlyNamed) {
    throw new Error(`${path}: --force-include only applies when the same file is named directly.`);
  }
  const absolute = resolve(repository.root, path);
  const resolved = realpathSync(absolute);
  sanitizeRepoRelativePath(repository.root, resolved);
  const info = statSync(resolved);
  if (!info.isFile()) throw new Error(`${path}: not a regular file.`);
  if (info.size > SHARE_LIMITS.maxTextBlobBytes) {
    throw new Error(`${path}: exceeds the ${SHARE_LIMITS.maxTextBlobBytes}-byte text limit.`);
  }
  const content = readFileSync(resolved);
  if (looksBinary(content)) {
    throw new Error(`${path}: binary files are not supported by the local behavioral V0.`);
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error(`${path}: source is not valid UTF-8 text.`);
  }
  return content;
}

function buildFileItems(
  repository: RepositorySnapshot,
  options: SelectionOptions,
  blobs: Map<string, Buffer>,
): { items: ShareItem[]; warnings: string[] } {
  const { parsed, explicitlyNamedFiles } = expandSelections(repository, options.selections);
  const forceSet = resolveForceSet(repository, options.forceInclude);
  const stripSet = new Set(options.stripContext);
  const items: ShareItem[] = [];
  const warnings: string[] = [];

  for (const selection of parsed) {
    const directlyNamed = selection.direct && explicitlyNamedFiles.has(selection.path);
    const content = validateSelectableFile(repository, selection.path, directlyNamed, forceSet, warnings);
    if (!content) continue;
    const committed = committedBytes(repository.root, selection.path);
    const provenance: ProvenanceGrade = committed?.equals(content)
      ? 'git-object-matched'
      : 'worktree-captured';
    const revision = provenance === 'git-object-matched' ? repository.head : 'worktree';
    const mode = statSync(resolve(repository.root, selection.path)).mode & 0o777;
    const language = languageFor(selection.path);

    if (!selection.range) {
      const blob = addBlob(blobs, content);
      const item: FileItem = {
        id: '',
        kind: 'file',
        provenance,
        class: 'observed',
        bytes: content.length,
        path: selection.path,
        pin: makePin({
          origin: repository.origin,
          revision,
          path: selection.path,
          bytes: content,
        }),
        blob,
        mode,
        language,
      };
      items.push(item);
      continue;
    }

    const selected = lineSlice(content, selection.range.start, selection.range.end);
    const blob = addBlob(blobs, selected);
    const chunks = lineChunks(content.toString('utf8'));
    const contextStart = Math.max(1, selection.range.start - 20);
    const contextEnd = Math.min(chunks.length, selection.range.end + 20);
    const strip = stripSet.has(selection.path) || stripSet.has(selection.original);
    const contextBytes = strip ? null : lineSlice(content, contextStart, contextEnd);
    const contextBlob = contextBytes ? addBlob(blobs, contextBytes) : null;
    const item: ExcerptItem = {
      id: '',
      kind: 'excerpt',
      provenance,
      class: 'observed',
      bytes: selected.length,
      path: selection.path,
      pin: makePin({
        origin: repository.origin,
        revision,
        path: selection.path,
        range: selection.range,
        bytes: selected,
      }),
      blob,
      range: selection.range,
      context: contextBytes && contextBlob
        ? { blob: contextBlob, start: contextStart, end: contextEnd, bytes: contextBytes.length }
        : undefined,
      language,
    };
    items.push(item);
  }
  return { items, warnings };
}

function resolveCommit(repository: RepositorySnapshot, ref: string): string {
  if (!ref || ref.startsWith('-')) throw new Error(`Unsafe Git revision: ${ref}`);
  const resolved = tryGit(repository.root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!resolved || !/^[a-f0-9]{40,64}$/i.test(resolved)) throw new Error(`Git revision is not a commit: ${ref}`);
  return resolved;
}

function representedDiffPaths(root: string, args: string[]): string[] {
  const tokens = gitBuffer(root, args).toString('utf8').split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();
  const paths: string[] = [];
  let cursor = 0;
  while (cursor < tokens.length) {
    let status = tokens[cursor++];
    let firstPath: string | undefined;
    const tab = status.indexOf('\t');
    if (tab >= 0) {
      firstPath = status.slice(tab + 1);
      status = status.slice(0, tab);
    } else {
      firstPath = tokens[cursor++];
    }
    if (!/^[A-Z][0-9]*$/.test(status) || !firstPath) {
      throw new Error('Git returned an invalid name-status record for the requested diff.');
    }
    paths.push(sanitizeRepoRelativePath(root, firstPath));
    if (status[0] === 'R' || status[0] === 'C') {
      const secondPath = tokens[cursor++];
      if (!secondPath) throw new Error('Git returned an incomplete rename record for the requested diff.');
      paths.push(sanitizeRepoRelativePath(root, secondPath));
    }
  }
  return [...new Set(paths)].sort();
}

function assertDiffPathsAllowed(
  repository: RepositorySnapshot,
  nameStatusArgs: string[],
  forceSet: Set<string>,
): void {
  for (const path of representedDiffPaths(repository.root, nameStatusArgs)) {
    const reason = exclusionReason(path);
    if (reason && !forceSet.has(path)) {
      throw new Error(
        `${path}: ${reason} in the requested diff. Add exact --force-include ${path} only after reviewing that diff path.`,
      );
    }
  }
}

function buildDiffItem(
  repository: RepositorySnapshot,
  options: SelectionOptions,
  blobs: Map<string, Buffer>,
): DiffItem | null {
  if (!options.staged && options.diff === false) return null;
  if (options.staged && options.diff !== false) throw new Error('Use either --staged or --diff, not both.');

  let args: string[];
  let base: string;
  let head: string;
  let provenance: ProvenanceGrade;
  let nameStatusArgs: string[];
  if (options.staged) {
    args = ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index'];
    nameStatusArgs = ['diff', '--cached', '--name-status', '-z', '--find-renames'];
    base = `${repository.origin}@${repository.head}`;
    head = `${repository.origin}@index`;
    provenance = 'worktree-captured';
  } else if (typeof options.diff === 'string') {
    const range = options.diff.match(/^(.+)\.\.(.+)$/);
    if (!range) throw new Error('Commit-range diffs use --diff A..B.');
    const baseSha = resolveCommit(repository, range[1]);
    const headSha = resolveCommit(repository, range[2]);
    args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index', baseSha, headSha];
    nameStatusArgs = ['diff', '--name-status', '-z', '--find-renames', baseSha, headSha];
    base = `${repository.origin}@${baseSha}`;
    head = `${repository.origin}@${headSha}`;
    provenance = 'git-object-matched';
  } else {
    args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--full-index', 'HEAD'];
    nameStatusArgs = ['diff', '--name-status', '-z', '--find-renames', 'HEAD'];
    base = `${repository.origin}@${repository.head}`;
    head = `${repository.origin}@worktree`;
    provenance = 'worktree-captured';
  }

  assertDiffPathsAllowed(repository, nameStatusArgs, resolveForceSet(repository, options.forceInclude));
  const content = gitBuffer(repository.root, args);
  if (content.length === 0) throw new Error('The requested diff is empty.');
  if (content.length > SHARE_LIMITS.maxTextBlobBytes) {
    throw new Error(`Unified diff exceeds the ${SHARE_LIMITS.maxTextBlobBytes}-byte text limit.`);
  }
  if (looksBinary(content)) throw new Error('Binary diffs are not supported by the local behavioral V0.');
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error('Unified diff is not valid UTF-8 text.');
  }
  const parsed = parseDiff(content.toString('utf8'));
  const blob = addBlob(blobs, content);
  return {
    id: '',
    kind: 'diff',
    provenance,
    class: 'observed',
    bytes: content.length,
    blob,
    base,
    head,
    files: parsed.map((file) => ({
      path: file.path,
      changeType: file.changeType,
      added: file.addedLines,
      removed: file.removedLines,
    })),
    addedLines: parsed.reduce((total, file) => total + file.addedLines, 0),
    removedLines: parsed.reduce((total, file) => total + file.removedLines, 0),
  };
}

function collectReferencedBlobs(items: ShareItem[]): Set<string> {
  const result = new Set<string>();
  for (const item of items) {
    if (item.kind === 'file' || item.kind === 'diff') result.add(item.blob);
    if (item.kind === 'excerpt') {
      result.add(item.blob);
      if (item.context) result.add(item.context.blob);
    }
    if (item.kind === 'evidence') {
      if (item.stdout) result.add(item.stdout);
      if (item.stderr) result.add(item.stderr);
    }
  }
  return result;
}

export function pruneUnreferencedBlobs(items: ShareItem[], blobs: Map<string, Buffer>): void {
  const referenced = collectReferencedBlobs(items);
  for (const hash of blobs.keys()) {
    if (!referenced.has(hash)) blobs.delete(hash);
  }
}

export function readShareSelections(cwd: string, options: SelectionOptions): SelectionResult {
  const repository = discoverShareRepository(cwd);
  if (!options.allowEmpty && options.selections.length === 0 && !options.staged && options.diff === false) {
    throw new Error('Name at least one file/range, or use --staged or --diff.');
  }
  const blobs = new Map<string, Buffer>();
  const files = buildFileItems(repository, options, blobs);
  const items = files.items;
  const diff = buildDiffItem(repository, options, blobs);
  if (diff) items.push(diff);
  if (!options.allowEmpty && items.length === 0) throw new Error('A Cut must contain source or a diff.');
  if (items.length > SHARE_LIMITS.maxItems) {
    throw new Error(`Cut selection exceeds the ${SHARE_LIMITS.maxItems}-item limit.`);
  }
  items.forEach((item, index) => {
    item.id = `i${index + 1}`;
  });
  for (const target of options.stripContext) {
    if (!/^i\d+$/.test(target)) continue;
    const item = items.find((candidate) => candidate.id === target);
    if (item?.kind === 'excerpt') delete item.context;
  }
  pruneUnreferencedBlobs(items, blobs);
  return { repository, items, blobs, warnings: files.warnings };
}
