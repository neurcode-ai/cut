import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

const SAFE_HOST = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i;
const PATH_PREFIXES = new Set(['git', 'repos', 'repositories', 'scm']);
const FILESYSTEM_PREFIXES = new Set([
  'etc', 'home', 'mnt', 'opt', 'private', 'srv', 'tmp', 'users', 'var', 'volumes',
]);

function opaqueRemote(value: string): string {
  const digest = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
  return `remote/opaque-${digest}`;
}

function safeSegment(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (
    !decoded
    || decoded === '.'
    || decoded === '..'
    || /[\/\\\0\r\n\t?#@]/.test(decoded)
  ) {
    return null;
  }
  return encodeURIComponent(decoded);
}

function hostOwnerRepo(hostValue: string, pathname: string): string | null {
  const host = hostValue.toLowerCase().replace(/^\[|\]$/g, '');
  if (!SAFE_HOST.test(host) || host.includes('..')) return null;
  const raw = pathname.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!raw || /[?#\0\r\n]/.test(raw)) return null;
  const decodedParts: string[] = [];
  for (const part of raw.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!decoded || decoded === '.' || decoded === '..') return null;
    decodedParts.push(decoded);
  }
  if (decodedParts.some((part) => FILESYSTEM_PREFIXES.has(part.toLowerCase()))) return null;
  if (decodedParts.length === 3 && PATH_PREFIXES.has(decodedParts[0].toLowerCase())) {
    decodedParts.shift();
  }
  if (decodedParts.length !== 2) return null;
  decodedParts[1] = decodedParts[1].replace(/\.git$/i, '');
  const owner = safeSegment(decodedParts[0]);
  const repo = safeSegment(decodedParts[1]);
  return owner && repo ? `${host}/${owner}/${repo}` : null;
}

/**
 * Reduce a remote to host/owner/repo. Credentials, scheme, port, query,
 * fragment, and .git suffix never survive.
 */
export function sanitizeRemote(remote: string | null | undefined): string | null {
  const value = remote?.trim();
  if (!value) return null;

  const scp = value.match(/^(?:[^@/:\s]+@)?([^:/\s]+):([^?#]+)$/);
  if (scp && !value.includes('://') && !/^[A-Za-z]:[\\/]/.test(value)) {
    return hostOwnerRepo(scp[1], scp[2]) ?? opaqueRemote(value);
  }

  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) {
      return opaqueRemote(value);
    }
    return hostOwnerRepo(url.hostname, url.pathname) ?? opaqueRemote(value);
  } catch {
    return opaqueRemote(value);
  }
}

export function sanitizedOrigin(remote: string | null | undefined, repoRoot: string): string {
  const sanitized = sanitizeRemote(remote);
  if (sanitized) return sanitized;
  const repositoryName = basename(resolve(repoRoot));
  const digest = createHash('sha256').update(repositoryName, 'utf8').digest('hex').slice(0, 16);
  return `local/opaque-${digest}`;
}

export function sanitizeRepoRelativePath(repoRoot: string, candidate: string): string {
  const root = resolve(repoRoot);
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(root, absolute);
  if (!rel || rel === '.') {
    throw new Error('A Share item must name a file, not the repository root.');
  }
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Selection escapes the repository boundary: ${candidate}`);
  }
  const normalized = rel.split(sep).join('/');
  if (normalized.includes('\0') || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error(`Unsafe repository-relative path: ${candidate}`);
  }
  return normalized;
}

export function sanitizeEvidenceCwd(repoRoot: string, cwd: string): string {
  const root = resolve(repoRoot);
  const absolute = resolve(cwd);
  const rel = relative(root, absolute);
  if (rel === '') return '.';
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error('Evidence must run inside the repository boundary.');
  }
  return rel.split(sep).join('/');
}
