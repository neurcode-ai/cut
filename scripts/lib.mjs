import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
export const ignoredDirectories = new Set([
  '.git',
  '.artifacts',
  'dist',
  'node_modules',
  'reports',
  'tmp',
]);

export function filesUnder(directory = root) {
  const files = [];
  const visit = (current) => {
    for (const name of readdirSync(current).sort()) {
      if (ignoredDirectories.has(name)) continue;
      const absolute = join(current, name);
      const info = statSync(absolute);
      if (info.isDirectory()) visit(absolute);
      else if (info.isFile()) files.push(absolute);
    }
  };
  visit(directory);
  return files;
}

export function repositoryPath(absolute) {
  return relative(root, absolute).replaceAll('\\', '/');
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
