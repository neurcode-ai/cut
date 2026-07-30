import { dirname, extname, posix } from 'node:path';

export const TARGET_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

const RESOLUTION_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

export interface DetectedSymbol {
  name: string;
  start: number;
  end: number;
  exported: boolean;
  kind: 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable' | 'default' | 'commonjs' | 're-export' | 'test';
}

export interface StaticImport {
  specifier: string;
  names: Array<{ imported: string; local: string }>;
  line: number;
  reExport: boolean;
  sideEffectOnly: boolean;
}

export function isTargetCodePath(path: string): boolean {
  return TARGET_EXTENSIONS.has(extname(path).toLowerCase());
}

export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return /(?:^|\/)(?:__tests__|tests?|test|fixtures?)\//.test(lower)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(lower);
}

export function isConfigurationPath(path: string): boolean {
  const lower = path.toLowerCase();
  const base = posix.basename(lower);
  return lower.startsWith('.github/workflows/')
    || /(?:^|\/)(?:config|configs)\//.test(lower)
    || /(?:^|\/)migrations?\//.test(lower)
    || /(?:^|\/)(?:package|tsconfig|jsconfig|eslint|prettier|vite|vitest|webpack|rollup|babel|jest|ava|turbo|nx)[^/]*\.(?:json|[cm]?[jt]s|ya?ml)$/.test(lower)
    || ['package.json', 'tsconfig.json', 'jsconfig.json'].includes(base);
}

export function isMigrationPath(path: string): boolean {
  return /(?:^|\/)migrations?\//i.test(path) || /\.sql$/i.test(path);
}

export function deniedPathReason(path: string): string | null {
  const lower = path.toLowerCase();
  const parts = lower.split('/');
  const base = parts.at(-1) ?? '';
  if (parts.some((part) => [
    '.git',
    'node_modules',
    'dist',
    'build',
    'coverage',
    '.next',
    '.nuxt',
    'vendor',
    'vendors',
    'third_party',
    'target',
    '__snapshots__',
  ].includes(part))) return 'generated, vendored, or built directory';
  if (/\.snap$/i.test(base) || /\.min\.[^.]+$/i.test(base) || /\.generated\./i.test(base)) {
    return 'generated, snapshot, or minified file';
  }
  if (/^(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?)$/i.test(base)) {
    return 'lockfile';
  }
  if (/^\.env(?:\.|$)/i.test(base)) return 'environment file';
  if (parts.some((part) => ['.aws', '.ssh', '.gnupg', '.azure', '.kube', '.docker'].includes(part))) {
    return 'credential-store path';
  }
  if (
    ['.netrc', '_netrc', '.npmrc', '.pypirc', 'credentials', 'credentials.json', 'service-account.json',
      'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa'].includes(base)
    || /\.(?:key|pem|p12|pfx)$/i.test(base)
  ) return 'credential-like file';
  return null;
}

function linesOf(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.length ? lines : [''];
}

function declaration(line: string): Omit<DetectedSymbol, 'start' | 'end'> | null {
  if (/^\s/.test(line)) return null;
  let match = line.match(/^(export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/);
  if (match) return { name: match[2], exported: Boolean(match[1]), kind: 'function' };
  match = line.match(/^(export\s+)?(?:declare\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
  if (match) return { name: match[2], exported: Boolean(match[1]), kind: 'class' };
  match = line.match(/^(export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/);
  if (match) return { name: match[2], exported: Boolean(match[1]), kind: 'interface' };
  match = line.match(/^(export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/);
  if (match) return { name: match[2], exported: Boolean(match[1]), kind: 'type' };
  match = line.match(/^(export\s+)?(?:declare\s+)?enum\s+([A-Za-z_$][\w$]*)/);
  if (match) return { name: match[2], exported: Boolean(match[1]), kind: 'enum' };
  match = line.match(/^(export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/);
  if (match) return { name: match[2], exported: Boolean(match[1]), kind: 'variable' };
  match = line.match(/^export\s+default(?:\s+(?:async\s+)?(?:function|class)\s*([A-Za-z_$][\w$]*)?)?/);
  if (match) return { name: match[1] || 'default', exported: true, kind: 'default' };
  if (/^module\.exports\s*=/.test(line)) return { name: 'module.exports', exported: true, kind: 'commonjs' };
  if (/^export\s*\{/.test(line)) return { name: 're-exports', exported: true, kind: 're-export' };
  match = line.match(/^(?:describe|suite|test|it)\s*\(\s*(['"`])(.+?)\1/);
  if (match) return { name: match[2].slice(0, 120), exported: false, kind: 'test' };
  return null;
}

export function detectSymbols(text: string): DetectedSymbol[] {
  const lines = linesOf(text);
  const starts: Array<Omit<DetectedSymbol, 'end'>> = [];
  lines.forEach((line, index) => {
    const found = declaration(line);
    if (found) starts.push({ ...found, start: index + 1 });
  });
  return starts.map((symbol, index) => ({
    ...symbol,
    end: Math.max(symbol.start, (starts[index + 1]?.start ?? lines.length + 1) - 1),
  }));
}

export function symbolsForRange(
  symbols: DetectedSymbol[],
  start: number,
  end: number,
): DetectedSymbol[] {
  return symbols.filter((symbol) => symbol.start <= end && symbol.end >= start);
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

function importedNames(clause: string): Array<{ imported: string; local: string }> {
  const names: Array<{ imported: string; local: string }> = [];
  const cleaned = clause.trim().replace(/^type\s+/, '');
  const defaultMatch = cleaned.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
  if (defaultMatch) names.push({ imported: 'default', local: defaultMatch[1] });
  const namespace = cleaned.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespace) names.push({ imported: '*', local: namespace[1] });
  const braces = cleaned.match(/\{([\s\S]*?)\}/);
  for (const raw of braces?.[1].split(',') ?? []) {
    const part = raw.trim().replace(/^type\s+/, '');
    if (!part) continue;
    const match = part.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
    if (match) names.push({ imported: match[1], local: match[2] ?? match[1] });
  }
  return names;
}

export function extractStaticImports(text: string): {
  imports: StaticImport[];
  dynamicRelativeSpecifiers: string[];
} {
  const imports: StaticImport[] = [];
  const occupied = new Set<string>();
  const fromPattern = /(?:^|\n)(?:import|export)\s+(?:type\s+)?([\s\S]{0,800}?)\s+from\s+(['"])([^'"\r\n]+)\2/g;
  for (const match of text.matchAll(fromPattern)) {
    const statement = match[0].trimStart();
    const specifier = match[3];
    const reExport = statement.startsWith('export');
    const key = `${match.index}:${specifier}`;
    occupied.add(key);
    imports.push({
      specifier,
      names: reExport
        ? importedNames(match[1]).map((entry) => ({ imported: entry.imported, local: entry.imported }))
        : importedNames(match[1]),
      line: lineAt(text, match.index ?? 0),
      reExport,
      sideEffectOnly: false,
    });
  }
  const sideEffectPattern = /(?:^|\n)import\s+(['"])([^'"\r\n]+)\1/g;
  for (const match of text.matchAll(sideEffectPattern)) {
    imports.push({
      specifier: match[2],
      names: [],
      line: lineAt(text, match.index ?? 0),
      reExport: false,
      sideEffectOnly: true,
    });
  }
  const requirePattern = /(?:^|\n)(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*(['"])([^'"\r\n]+)\2\s*\)/g;
  for (const match of text.matchAll(requirePattern)) {
    imports.push({
      specifier: match[3],
      names: [{ imported: '*', local: match[1] }],
      line: lineAt(text, match.index ?? 0),
      reExport: false,
      sideEffectOnly: false,
    });
  }
  const dynamicRelativeSpecifiers = [...text.matchAll(/import\(\s*(['"])(\.[^'"\r\n]+)\1\s*\)/g)]
    .map((match) => match[2])
    .sort();
  return {
    imports: imports.sort((left, right) =>
      left.line - right.line || left.specifier.localeCompare(right.specifier)),
    dynamicRelativeSpecifiers,
  };
}

export function resolveRelativeImport(
  importer: string,
  specifier: string,
  repositoryCodePaths: Set<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const joined = posix.normalize(posix.join(posix.dirname(importer), specifier));
  if (joined === '..' || joined.startsWith('../') || joined.startsWith('/')) return null;
  const extension = extname(joined).toLowerCase();
  const stems = new Set<string>([joined]);
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) stems.add(joined.slice(0, -extension.length));
  const candidates: string[] = [];
  for (const stem of stems) {
    candidates.push(stem);
    for (const candidateExtension of RESOLUTION_EXTENSIONS) candidates.push(`${stem}${candidateExtension}`);
    for (const candidateExtension of RESOLUTION_EXTENSIONS) candidates.push(`${stem}/index${candidateExtension}`);
  }
  return candidates.find((candidate) => repositoryCodePaths.has(candidate)) ?? null;
}

export function rangeText(text: string, start: number, end: number): string {
  return linesOf(text).slice(start - 1, end).join('\n');
}

export function selectionFor(path: string, start?: number, end?: number): string {
  return start === undefined || end === undefined ? path : `${path}:${start}-${end}`;
}

export function contextText(text: string, start?: number, end?: number): string[] {
  if (start === undefined || end === undefined) return [text];
  const lines = linesOf(text);
  const selected = lines.slice(start - 1, end).join('\n');
  const contextStart = Math.max(1, start - 20);
  const contextEnd = Math.min(lines.length, end + 20);
  const context = lines.slice(contextStart - 1, contextEnd).join('\n');
  return [selected, context];
}

export function directorySummary(path: string): string {
  const directory = dirname(path).split('\\').join('/');
  return directory === '.' ? './' : `${directory}/`;
}

export function identifierParts(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length >= 2);
}
