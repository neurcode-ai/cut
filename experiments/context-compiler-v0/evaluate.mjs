#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const EXPERIMENT_ROOT = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(EXPERIMENT_ROOT, '..', '..');
const CORPUS_PATH = join(EXPERIMENT_ROOT, 'corpus.json');
const DEFAULT_RESULT_PATH = join(EXPERIMENT_ROOT, 'results.json');
const BASE_REPOSITORY_COMMIT = 'e140fd00cbcf59b6cace5632ecb29d46d0151a42';
const TARGET_PATTERN = /\.[cm]?[jt]sx?$/i;
const LOCK_PATTERN = /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?)$/i;
const GENERATED_PATTERN = /(?:^|\/)__snapshots__\/|\.snap$|\.generated\.|\.min\.[^.]+$/i;
const require = createRequire(import.meta.url);
const {
  canonicalCompilePlan,
  compile,
  estimateTokens,
} = require(join(WORKSPACE_ROOT, 'packages/compiler/dist/index.js'));
const {
  readShareArchive,
  scanFields,
} = require(join(WORKSPACE_ROOT, 'packages/format/dist/index.js'));

process.umask(0o077);

function fail(message) {
  throw new Error(message);
}

function git(root, args, options = {}) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: options.encoding ?? 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout ?? 120_000,
    maxBuffer: 128 * 1024 * 1024,
  });
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function median(values) {
  return nearestRank(values, 0.5);
}

function canonical(value) {
  const stable = (entry) => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, stable(child)]),
      );
    }
    return entry;
  };
  return `${JSON.stringify(stable(value), null, 2)}\n`;
}

function atomicWrite(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, canonical(value), { mode: 0o600 });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function assertCorpusRoot(root, repositories) {
  if (!root) fail('Set NEURCODE_EVAL_CORPUS_ROOT to the bounded temporary corpus directory.');
  const real = realpathSync(root);
  const temporaryRoots = [...new Set([realpathSync(tmpdir()), realpathSync('/tmp')])];
  if (
    basename(real) !== 'neurcode-context-compiler-corpus-v0-20260730'
    || !temporaryRoots.some((temporaryRoot) => real.startsWith(`${temporaryRoot}${sep}`))
  ) {
    fail('Refusing a corpus directory outside the preregistered temporary target.');
  }
  for (const repository of repositories) {
    const checkout = join(real, repository.id);
    if (!existsSync(join(checkout, '.git')) || !lstatSync(join(checkout, '.git')).isDirectory()) {
      fail(`Temporary corpus checkout is missing for ${repository.id}.`);
    }
  }
  return real;
}

function directoryBytes(path) {
  const output = execFileSync('du', ['-sk', path], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  return Number.parseInt(output.split(/\s+/)[0], 10) * 1024;
}

function checkoutTask(repositoryRoot, head) {
  const result = spawnSync('git', ['-C', repositoryRoot, 'checkout', '--force', '--detach', head], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    fail(`Could not materialize frozen task head ${head}: ${result.error?.message ?? result.stderr}`);
  }
  const actual = git(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  if (actual !== head) fail(`Frozen task checkout resolved to ${actual}, expected ${head}.`);
  const dirty = git(repositoryRoot, ['status', '--porcelain=v1', '--untracked-files=no']).trim();
  if (dirty) fail(`Frozen task checkout ${head} is not clean.`);
}

function changedFileBuffer(repositoryRoot, head, path) {
  return git(repositoryRoot, ['show', `${head}:${path}`], { encoding: 'buffer' });
}

function uniqueMetrics(entries) {
  const unique = new Map();
  for (const entry of entries) {
    const content = Buffer.isBuffer(entry) ? entry : Buffer.from(entry);
    unique.set(sha256(content), content);
  }
  return {
    bytes: [...unique.values()].reduce((sum, content) => sum + content.length, 0),
    estimatedTokens: [...unique.values()].reduce(
      (sum, content) => sum + estimateTokens(content.toString('utf8')),
      0,
    ),
    uniqueBlobs: unique.size,
  };
}

function declaration(line) {
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

function detectedSymbols(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const starts = [];
  lines.forEach((line, index) => {
    const found = declaration(line);
    if (found) starts.push({ ...found, start: index + 1 });
  });
  return starts.map((symbol, index) => ({
    ...symbol,
    end: Math.max(symbol.start, (starts[index + 1]?.start ?? lines.length + 1) - 1),
  }));
}

function hunksForPath(repositoryRoot, base, head, path) {
  const diff = git(repositoryRoot, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--unified=0',
    base,
    head,
    '--',
    path,
  ]);
  return [...diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((match) => ({
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    }));
}

function evidencePath(path) {
  const lower = path.toLowerCase();
  return /(?:^|\/)(?:__tests__|tests?|fixtures?)\//.test(lower)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(lower)
    || lower.startsWith('.github/workflows/')
    || /(?:^|\/)(?:config|configs|migrations?)\//.test(lower)
    || /(?:^|\/)(?:package|tsconfig|jsconfig|eslint|prettier|vite|vitest|webpack|rollup|babel|jest|ava|turbo|nx)[^/]*\.(?:json|[cm]?[jt]s|ya?ml)$/.test(lower);
}

function selectionCovers(inclusions, obligation) {
  return inclusions.some((inclusion) => {
    if (inclusion.path !== obligation.path) return false;
    if (obligation.coverage === 'path') return true;
    if (inclusion.start === undefined || inclusion.end === undefined) return true;
    return inclusion.start <= obligation.start && inclusion.end >= obligation.end;
  });
}

function provisionalOracle(repositoryRoot, task) {
  const obligations = [];
  const uncertainties = [];
  const symbolsByPath = new Map();
  const changed = new Set(task.changedPaths.map((entry) => entry.path));

  for (const changedPath of task.changedPaths) {
    if (!TARGET_PATTERN.test(changedPath.path)) continue;
    if (changedPath.status === 'D') {
      uncertainties.push({ kind: 'deleted-post-image', path: changedPath.path });
      continue;
    }
    const text = changedFileBuffer(repositoryRoot, task.head, changedPath.path).toString('utf8');
    const symbols = detectedSymbols(text);
    symbolsByPath.set(changedPath.path, symbols);
    const hunks = hunksForPath(repositoryRoot, task.base, task.head, changedPath.path);
    for (const [index, hunk] of hunks.entries()) {
      const start = Math.max(1, hunk.newStart);
      const end = Math.max(start, hunk.newStart + Math.max(1, hunk.newLines) - 1);
      const enclosing = symbols.filter((symbol) => symbol.start <= end && symbol.end >= start);
      if (enclosing.length === 0) {
        const lineCount = Math.max(1, text.split('\n').length - (text.endsWith('\n') ? 1 : 0));
        obligations.push({
          id: `implementation:${changedPath.path}:${index + 1}:whole-file`,
          kind: 'implementation',
          path: changedPath.path,
          start: 1,
          end: lineCount,
          coverage: 'range',
        });
      } else {
        for (const symbol of enclosing) {
          obligations.push({
            id: `implementation:${changedPath.path}:${index + 1}:${symbol.name}`,
            kind: 'implementation',
            path: changedPath.path,
            start: symbol.start,
            end: symbol.end,
            coverage: 'range',
          });
          if (symbol.exported) {
            obligations.push({
              id: `public-interface:${changedPath.path}:${symbol.name}`,
              kind: 'public-interface',
              path: changedPath.path,
              start: symbol.start,
              end: symbol.end,
              coverage: 'range',
            });
          }
        }
      }
    }
  }

  for (const reference of task.reviewReferences) {
    obligations.push({
      id: `review-path:${reference.path}`,
      kind: 'review-reference',
      path: reference.path,
      coverage: 'path',
      diffCovered: changed.has(reference.path),
    });
    for (const path of reference.additionalPaths) {
      obligations.push({
        id: `review-path:${path}`,
        kind: 'review-reference',
        path,
        coverage: 'path',
        diffCovered: changed.has(path),
      });
    }
    for (const name of reference.symbols) {
      if (!TARGET_PATTERN.test(reference.path) || !existsSync(join(repositoryRoot, reference.path))) {
        uncertainties.push({ kind: 'review-symbol-no-post-image', path: reference.path });
        continue;
      }
      let symbols = symbolsByPath.get(reference.path);
      if (!symbols) {
        const text = changedFileBuffer(repositoryRoot, task.head, reference.path).toString('utf8');
        symbols = detectedSymbols(text);
        symbolsByPath.set(reference.path, symbols);
      }
      const symbol = symbols.find((entry) => entry.name === name);
      if (!symbol) {
        uncertainties.push({ kind: 'review-symbol-boundary-unresolved', path: reference.path });
        continue;
      }
      obligations.push({
        id: `review-symbol:${reference.path}:${name}`,
        kind: 'review-reference',
        path: reference.path,
        start: symbol.start,
        end: symbol.end,
        coverage: 'range',
      });
    }
  }

  for (const entry of task.changedPaths) {
    if (!evidencePath(entry.path) || LOCK_PATTERN.test(entry.path) || GENERATED_PATTERN.test(entry.path)) continue;
    const target = TARGET_PATTERN.test(entry.path);
    obligations.push({
      id: `accepted-evidence:${entry.path}`,
      kind: entry.path.toLowerCase().includes('migration') ? 'data-migration' : 'test-or-configuration',
      path: entry.path,
      coverage: 'path',
      diffCovered: !target || entry.status === 'D',
    });
  }

  if (task.family === 'security-adjacent') {
    const firstTarget = task.changedPaths.find((entry) => entry.status !== 'D' && TARGET_PATTERN.test(entry.path));
    if (firstTarget) {
      obligations.push({
        id: `security-sensitive:${firstTarget.path}`,
        kind: 'security-sensitive',
        path: firstTarget.path,
        coverage: 'path',
      });
    }
  }

  obligations.push({
    id: 'operational-evidence',
    kind: 'operational-evidence',
    coverage: 'evidence',
  });

  const deduplicated = new Map(obligations.map((obligation) => [obligation.id, obligation]));
  return { obligations: [...deduplicated.values()], uncertainties };
}

function scoreOracle(oracle, plan) {
  const scored = oracle.obligations.map((obligation) => {
    const covered = obligation.coverage === 'evidence'
      ? false
      : Boolean(obligation.diffCovered) || selectionCovers(plan?.inclusions ?? [], obligation);
    return { ...obligation, covered };
  });
  const implementation = scored.filter((entry) => entry.kind === 'implementation');
  const missingKinds = {};
  for (const obligation of scored.filter((entry) => !entry.covered)) {
    missingKinds[obligation.kind] = (missingKinds[obligation.kind] ?? 0) + 1;
  }
  return {
    total: scored.length,
    covered: scored.filter((entry) => entry.covered).length,
    recall: scored.length ? scored.filter((entry) => entry.covered).length / scored.length : 1,
    uncertain: oracle.uncertainties.length,
    uncertaintyKinds: countBy(oracle.uncertainties, (entry) => entry.kind),
    missingKinds,
    implementation: {
      total: implementation.length,
      covered: implementation.filter((entry) => entry.covered).length,
      coverage: implementation.length
        ? implementation.filter((entry) => entry.covered).length / implementation.length
        : 1,
    },
    scored,
  };
}

function oracleSummary(scored) {
  return {
    total: scored.total,
    covered: scored.covered,
    recall: round(scored.recall),
    uncertain: scored.uncertain,
    uncertaintyKinds: scored.uncertaintyKinds,
    missingKinds: scored.missingKinds,
    implementation: {
      total: scored.implementation.total,
      covered: scored.implementation.covered,
      coverage: round(scored.implementation.coverage),
    },
  };
}

function countBy(entries, keyFor) {
  const counts = {};
  for (const entry of entries) {
    const key = keyFor(entry);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function ambiguityCategory(value) {
  if (value.includes('dynamic import')) return 'dynamic-import';
  if (value.includes('relative import')) return 'unresolved-relative-import';
  if (value.includes('deleted target-language')) return 'deleted-post-image';
  if (value.includes('target-language files')) return 'repository-index-bound';
  if (value.includes('could not be parsed')) return 'optional-parse';
  return 'other';
}

function scanEntryMetrics(entries) {
  const fields = entries.map((entry, index) => ({
    scope: `artifact:${index + 1}`,
    text: Buffer.isBuffer(entry) ? entry.toString('utf8') : String(entry),
  }));
  return scanFields(fields).length;
}

function runCliArchive(repositoryRoot, taskText, range, temporaryRoot) {
  const archivePath = join(temporaryRoot, `${sha256(`${range}\0${taskText}`).slice(0, 16)}.tar.gz`);
  const cli = join(WORKSPACE_ROOT, 'packages/cli/dist/index.js');
  const result = spawnSync(process.execPath, [
    cli,
    'share',
    '--auto',
    `--diff=${range}`,
    '--task',
    taskText,
    '--yes',
    '--out',
    archivePath,
  ], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    input: '',
    timeout: 180_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const printed = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.error || result.status !== 0 || !existsSync(archivePath)) {
    const category = /secret|finding/i.test(printed)
      ? 'secret-scan-blocked'
      : /budget/i.test(printed)
        ? 'budget-failure'
        : /wall-clock|time/i.test(printed)
          ? 'timeout'
          : 'cli-or-validation-failure';
    if (existsSync(archivePath)) rmSync(archivePath);
    return {
      success: false,
      category,
      airlockPlanShown: printed.includes('Selected by compiler'),
    };
  }
  const mode = statSync(archivePath).mode & 0o777;
  const archive = readFileSync(archivePath);
  let bundle;
  try {
    bundle = readShareArchive(archive);
  } finally {
    rmSync(archivePath);
  }
  const sourceItems = bundle.cut.pack.items.filter((item) => item.kind === 'file' || item.kind === 'excerpt');
  const diffItems = bundle.cut.pack.items.filter((item) => item.kind === 'diff');
  const blobValues = [...bundle.blobs.values()];
  const metrics = uniqueMetrics(blobValues);
  return {
    success: true,
    category: null,
    archiveMode: mode.toString(8).padStart(3, '0'),
    airlockPlanShown: printed.includes('Selected by compiler'),
    cut: bundle.cut.manifest.cut,
    itemCount: bundle.cut.pack.items.length,
    sourceFiles: new Set(sourceItems.map((item) => item.path)).size,
    fileItems: sourceItems.filter((item) => item.kind === 'file').length,
    excerpts: sourceItems.filter((item) => item.kind === 'excerpt').length,
    diffFiles: new Set(diffItems.flatMap((item) => item.files.map((file) => file.path))).size,
    storyFrames: bundle.cut.story.frames.length,
    machineReasonFrames: bundle.cut.story.frames.filter((frame) =>
      /^(?:Machine-derived:|Machine-derived \(weak\):|Unknown:)/.test(frame.note)).length,
    validatorSuccess: true,
    archiveVerificationSuccess: true,
    sensitiveFindings: scanEntryMetrics(blobValues),
    ...metrics,
  };
}

function groupRobustness(tasks, field) {
  const groups = new Map();
  for (const task of tasks) {
    const key = task[field];
    const current = groups.get(key) ?? [];
    current.push(task);
    groups.set(key, current);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([key, entries]) => {
    const oracleTotal = entries.reduce((sum, entry) => sum + entry.oracle.total, 0);
    const oracleCovered = entries.reduce((sum, entry) => sum + entry.oracle.covered, 0);
    const implementationTotal = entries.reduce((sum, entry) => sum + entry.oracle.implementation.total, 0);
    const implementationCovered = entries.reduce((sum, entry) => sum + entry.oracle.implementation.covered, 0);
    return [key, {
      tasks: entries.length,
      requiredContextRecall: round(oracleTotal ? oracleCovered / oracleTotal : 1),
      changedHunkSymbolCoverage: round(implementationTotal ? implementationCovered / implementationTotal : 1),
      medianReduction: round(median(entries.map((entry) => entry.reduction).filter(Number.isFinite))),
      replayPasses: entries.filter((entry) => entry.replay.exact).length,
      validatorPasses: entries.filter((entry) => entry.armC.validatorSuccess).length,
    }];
  }));
}

function gate(name, target, actual, pass) {
  return { name, target, actual, pass: Boolean(pass) };
}

function cleanError(error, corpusRoot, temporaryRoot) {
  return String(error instanceof Error ? error.message : error)
    .split(corpusRoot).join('<corpus>')
    .split(WORKSPACE_ROOT).join('<workspace>')
    .split(temporaryRoot).join('<temporary>')
    .slice(0, 500);
}

function finalizeCleanup(resultPath, corpus, requestedRoot) {
  const corpusRoot = assertCorpusRoot(requestedRoot, corpus.repositories);
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  const bytesBeforeRemoval = directoryBytes(corpusRoot);
  rmSync(corpusRoot, { recursive: true, force: false });
  result.storage.cleanup = {
    temporaryClonesRemoved: !existsSync(corpusRoot),
    bytesRemoved: bytesBeforeRemoval,
    retainedThirdPartySourceBytes: 0,
  };
  result.sourceFreeArtifactScan = sourceFreeArtifactScan(result);
  atomicWrite(resultPath, result);
  process.stdout.write(`${result.verdict}\n`);
}

function sourceFreeArtifactScan(value) {
  const serialized = JSON.stringify(value);
  const absolutePaths = [
    /\/Users\//,
    /\/home\//,
    /\/tmp\//,
    /[A-Za-z]:\\Users\\/,
  ].some((pattern) => pattern.test(serialized));
  const sourcePayloadMarkers = [
    'diff --git ',
    'node_modules/',
  ].some((marker) => serialized.includes(marker));
  const findings = scanFields([{ scope: 'aggregate-evidence', text: serialized }]);
  return {
    pass: !absolutePaths && !sourcePayloadMarkers && findings.length === 0,
    absolutePaths: absolutePaths ? 1 : 0,
    sourcePayloadMarkers: sourcePayloadMarkers ? 1 : 0,
    sensitiveFindings: findings.length,
  };
}

function main() {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
  const resultPath = resolve(process.argv.find((argument) => argument.startsWith('--out='))?.slice(6) ?? DEFAULT_RESULT_PATH);
  const requestedCorpusRoot = process.env.NEURCODE_EVAL_CORPUS_ROOT;
  if (process.argv.includes('--finalize-cleanup')) {
    finalizeCleanup(resultPath, corpus, requestedCorpusRoot);
    return;
  }

  const corpusRoot = assertCorpusRoot(requestedCorpusRoot, corpus.repositories);
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'neurcode-context-compiler-evaluation-'));
  chmodSync(temporaryRoot, 0o700);
  const storageBefore = directoryBytes(corpusRoot);
  const firstObservedPath = join(EXPERIMENT_ROOT, 'first-observed-results.json');
  const initialCorpusBytes = existsSync(firstObservedPath)
    ? JSON.parse(readFileSync(firstObservedPath, 'utf8')).storage.temporaryCorpusBytesBeforeMaterialization
    : storageBefore;
  const tasks = [];
  try {
    for (const task of corpus.tasks) {
      const repositoryRoot = join(corpusRoot, task.repository);
      const taskText = `${task.title}\n${task.description}`.trim();
      const range = `${task.base}..${task.head}`;
      const row = {
        id: task.id,
        repository: task.repository,
        family: task.family,
        compile: { success: false, errorCategory: null },
        replay: { exact: false, normalizedPlanSha256: null },
        candidateCounts: null,
        selected: null,
        missingContext: null,
        oracle: {
          total: 0,
          covered: 0,
          recall: 0,
          uncertain: 0,
          uncertaintyKinds: {},
          missingKinds: {},
          implementation: { total: 0, covered: 0, coverage: 0 },
        },
        armA: null,
        armB: null,
        armC: { validatorSuccess: false, archiveVerificationSuccess: false },
        reduction: null,
        timingsMs: null,
      };
      try {
        checkoutTask(repositoryRoot, task.head);
        const diff = git(repositoryRoot, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--full-index',
          task.base,
          task.head,
        ]);
        const postImages = task.changedPaths
          .filter((entry) => entry.status !== 'D')
          .map((entry) => changedFileBuffer(repositoryRoot, task.head, entry.path));
        const armA = uniqueMetrics([diff]);
        const armB = uniqueMetrics([diff, ...postImages]);
        const oracle = provisionalOracle(repositoryRoot, task);
        row.armA = {
          ...armA,
          diffFiles: task.changedPaths.length,
          sourceFiles: 0,
          excerpts: 0,
          sensitiveFindings: scanEntryMetrics([diff]),
        };
        row.armB = {
          ...armB,
          diffFiles: task.changedPaths.length,
          sourceFiles: task.changedPaths.filter((entry) => entry.status !== 'D').length,
          excerpts: 0,
          sensitiveFindings: scanEntryMetrics([diff, ...postImages]),
        };
        row.oracle = oracleSummary(scoreOracle(oracle));
        const first = compile({
          repositoryRoot,
          diff: { kind: 'range', range },
          task: taskText,
        });
        const second = compile({
          repositoryRoot,
          diff: { kind: 'range', range },
          task: taskText,
        });
        const firstNormalized = canonicalCompilePlan(first, true);
        const secondNormalized = canonicalCompilePlan(second, true);
        const scored = scoreOracle(oracle, first);
        const coveredOracleIds = new Set(scored.scored.filter((entry) => entry.covered).map((entry) => entry.id));
        const overSelection = countBy(
          first.inclusions.filter((inclusion) =>
            !scored.scored.some((obligation) =>
              coveredOracleIds.has(obligation.id) && selectionCovers([inclusion], obligation))),
          (inclusion) => inclusion.channel,
        );
        const archive = runCliArchive(repositoryRoot, taskText, range, temporaryRoot);
        const expressible = first.selections.every((selection) =>
          /^[^:\0\\]+(?::[1-9]\d*-[1-9]\d*)?$/.test(selection));
        row.compile = { success: true, errorCategory: null };
        row.replay = {
          exact: firstNormalized === secondNormalized,
          normalizedPlanSha256: sha256(firstNormalized),
        };
        row.candidateCounts = first.candidateCounts;
        row.selected = {
          items: first.inclusions.length,
          files: new Set(first.inclusions.map((inclusion) => inclusion.path)).size,
          excerpts: first.inclusions.filter((inclusion) => inclusion.start !== undefined).length,
          estimatedTokens: first.estimatedSelectedTokens,
          expressible,
          overSelectionByChannel: overSelection,
        };
        row.missingContext = {
          planUnsatisfiedByKind: countBy(
            first.obligations.filter((obligation) => obligation.status === 'unsatisfied'),
            (obligation) => obligation.kind,
          ),
          ambiguityCategories: countBy(first.ambiguities, ambiguityCategory),
          truncatedChannels: first.truncation.channels,
        };
        row.oracle = oracleSummary(scored);
        row.armC = {
          ...archive,
          compilerEstimatedTokens: first.estimatedSelectedTokens,
          selectionExpressible: expressible,
          planMatchesArchiveSourceItemCount: archive.success
            ? first.inclusions.length === archive.fileItems + archive.excerpts
            : false,
        };
        row.reduction = archive.success ? round(armB.estimatedTokens / archive.estimatedTokens) : null;
        row.timingsMs = Object.fromEntries(
          Object.entries(first.timings).map(([phase, value]) => [phase, round(value)]),
        );
      } catch (error) {
        const message = cleanError(error, corpusRoot, temporaryRoot);
        row.compile = {
          success: false,
          errorCategory: /budget/i.test(message)
            ? 'budget-failure'
            : /wall-clock|time/i.test(message)
              ? 'timeout'
              : /Git command failed|checkout|revision/i.test(message)
                ? 'git-failure'
                : 'compiler-or-evaluator-failure',
        };
        row.failureDigest = sha256(message).slice(0, 16);
      }
      tasks.push(row);
      process.stdout.write(`${task.id}: ${row.compile.success ? 'measured' : row.compile.errorCategory}\n`);
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }

  const compiled = tasks.filter((task) => task.compile.success);
  const oracleTotal = tasks.reduce((sum, task) => sum + task.oracle.total, 0);
  const oracleCovered = tasks.reduce((sum, task) => sum + task.oracle.covered, 0);
  const implementationTotal = tasks.reduce((sum, task) => sum + task.oracle.implementation.total, 0);
  const implementationCovered = tasks.reduce((sum, task) => sum + task.oracle.implementation.covered, 0);
  const reductions = tasks.map((task) => task.reduction).filter(Number.isFinite);
  const totalLatencies = compiled.map((task) => task.timingsMs.totalMs);
  const phaseEntries = compiled.flatMap((task) =>
    Object.entries(task.timingsMs)
      .filter(([phase]) => phase !== 'totalMs')
      .map(([phase, milliseconds]) => ({ task: task.id, phase, milliseconds })));
  const maxPhase = phaseEntries.sort((left, right) =>
    right.milliseconds - left.milliseconds || left.task.localeCompare(right.task))[0] ?? null;
  const formatChangedFiles = git(WORKSPACE_ROOT, [
    'diff',
    '--name-only',
    BASE_REPOSITORY_COMMIT,
    '--',
    'packages/format',
  ]).trim().split('\n').filter(Boolean);
  const compilerManifest = JSON.parse(readFileSync(join(WORKSPACE_ROOT, 'packages/compiler/package.json'), 'utf8'));
  const runtimeDependencyCount = Object.keys(compilerManifest.dependencies ?? {}).length;
  const compilerSources = git(WORKSPACE_ROOT, ['ls-files', '--others', '--cached', '--exclude-standard', 'packages/compiler/src'])
    .trim().split('\n').filter(Boolean)
    .map((path) => readFileSync(join(WORKSPACE_ROOT, path), 'utf8'))
    .join('\n');
  const forbiddenRuntimeMechanisms = [
    /\bfetch\s*\(/,
    /\bOpenAI\b/i,
    /\bembedding/i,
    /\btree-sitter\b/i,
    /\btypescript\b.*createProgram/,
  ].filter((pattern) => pattern.test(compilerSources)).length;

  const actualRecall = oracleTotal ? oracleCovered / oracleTotal : 0;
  const actualImplementationCoverage = implementationTotal ? implementationCovered / implementationTotal : 0;
  const medianReduction = median(reductions);
  const p50 = nearestRank(totalLatencies, 0.5);
  const p95 = nearestRank(totalLatencies, 0.95);
  const sensitiveC = tasks.reduce((sum, task) => sum + (task.armC.sensitiveFindings ?? 0), 0);
  const scannerBlockedShares = tasks.filter((task) => task.armC.category === 'secret-scan-blocked').length;
  const generatedShares = tasks.filter((task) => task.armC.success);
  const expressiblePlans = compiled.filter((task) => task.selected?.expressible).length;
  const gates = [
    gate('changed-hunk enclosing-symbol coverage', '100%', round(actualImplementationCoverage), actualImplementationCoverage === 1),
    gate('provisional required-context recall', '>= 90%', round(actualRecall), actualRecall >= 0.9),
    gate('median token reduction versus arm B', '>= 3.0x across 15 tasks', {
      measuredTasks: reductions.length,
      median: round(medianReduction),
    }, reductions.length === tasks.length && medianReduction >= 3),
    gate('compilation p50', '< 2000 ms across 15 tasks', {
      measuredTasks: totalLatencies.length,
      milliseconds: round(p50),
    }, totalLatencies.length === tasks.length && p50 < 2_000),
    gate('compilation p95', '< 5000 ms across 15 tasks', {
      measuredTasks: totalLatencies.length,
      milliseconds: round(p95),
    }, totalLatencies.length === tasks.length && p95 < 5_000),
    gate('maximum individual phase', '<= 1000 ms across 15 tasks', {
      measuredTasks: totalLatencies.length,
      maximum: maxPhase ? round(maxPhase.milliseconds) : null,
    }, totalLatencies.length === tasks.length && Boolean(maxPhase) && maxPhase.milliseconds <= 1_000),
    gate('unreviewed sensitive upload', '0', {
      unreviewedUploads: 0,
      blockedLocalShares: scannerBlockedShares,
      findingsInVerifiedArchives: sensitiveC,
    }, sensitiveC === 0),
    gate('Share Format changes', '0 files and cut 1', {
      changedFiles: formatChangedFiles.length,
      generatedShares: generatedShares.length,
      allGeneratedSharesCut1: generatedShares.every((task) => task.armC.cut === 1),
    }, formatChangedFiles.length === 0 && generatedShares.every((task) => task.armC.cut === 1)),
    gate('CLI selection expressibility', '100% of emitted plans', `${expressiblePlans}/${compiled.length}`, expressiblePlans === compiled.length),
    gate('existing validator success', '15/15', tasks.filter((task) => task.armC.validatorSuccess).length, tasks.every((task) => task.armC.validatorSuccess)),
    gate('exact normalized replay', '15/15', tasks.filter((task) => task.replay.exact).length, tasks.every((task) => task.replay.exact)),
    gate('forbidden runtime dependency', '0', {
      packageDependencies: runtimeDependencyCount,
      forbiddenMechanisms: forbiddenRuntimeMechanisms,
    }, runtimeDependencyCount === 0 && forbiddenRuntimeMechanisms === 0),
  ];
  const allGatesPass = gates.every((entry) => entry.pass);
  const killCondition = actualRecall < 0.8
    || medianReduction < 2
    || sensitiveC > 0
    || p95 > 10_000
    || formatChangedFiles.length > 0
    || runtimeDependencyCount > 0
    || forbiddenRuntimeMechanisms > 0;
  const verdict = allGatesPass
    ? 'TECHNICAL_GO_HUMAN_PENDING'
    : killCondition
      ? 'KILL'
      : 'REVISE';

  const result = {
    schemaVersion: 1,
    experiment: 'context-compiler-v0',
    run: {
      sequence: Number.parseInt(process.env.NEURCODE_EVAL_RUN_SEQUENCE ?? '1', 10),
      corpusSealedBeforeCompiler: true,
      corpusSha256: sha256(readFileSync(CORPUS_PATH)),
      baseRepositoryCommit: BASE_REPOSITORY_COMMIT,
      tasksAttempted: tasks.length,
      tasksMeasured: compiled.length,
      normalizedReplayRunsPerTask: 2,
      targetedCorrectionsUsed: 0,
      evaluationHarnessAccountingCorrections: Number.parseInt(
        process.env.NEURCODE_EVAL_HARNESS_CORRECTIONS ?? '0',
        10,
      ),
      compilerChangedAfterFirstObservedRun: false,
      firstObservedArtifact: 'first-observed-results.json',
    },
    verdict,
    releaseDecisionOccurred: false,
    humanGate: {
      status: 'pending',
      simulated: false,
      requestedDevelopers: 5,
      requestedChanges: 10,
    },
    arms: {
      A: 'complete accepted unified diff',
      B: 'arm A plus complete non-deleted changed post-images, unique blobs counted once',
      C: 'arm A plus compiler selections and context halos through existing Share capture',
      D: {
        status: 'not-evaluated',
        reason: 'No reproducible full-repository agent exploration was run within the fixed observational budget.',
      },
    },
    aggregate: {
      changedHunkSymbolCoverage: round(actualImplementationCoverage),
      provisionalRequiredContextRecall: round(actualRecall),
      medianTokenReductionVersusB: round(medianReduction),
      compilationLatencyMs: {
        p50: round(p50),
        p95: round(p95),
        maximumIndividualPhase: maxPhase
          ? { task: maxPhase.task, phase: maxPhase.phase, milliseconds: round(maxPhase.milliseconds) }
          : null,
      },
      candidateCounts: Object.fromEntries(
        ['definition', 'dependency', 'consumer', 'test', 'instruction', 'total'].map((channel) => [
          channel,
          compiled.reduce((sum, task) => sum + (task.candidateCounts?.[channel] ?? 0), 0),
        ]),
      ),
      selectedItems: compiled.reduce((sum, task) => sum + task.selected.items, 0),
      sensitiveFindings: {
        armA: tasks.reduce((sum, task) => sum + (task.armA?.sensitiveFindings ?? 0), 0),
        armB: tasks.reduce((sum, task) => sum + (task.armB?.sensitiveFindings ?? 0), 0),
        armC: sensitiveC,
      },
      archiveVerificationPasses: tasks.filter((task) => task.armC.archiveVerificationSuccess).length,
      validatorPasses: tasks.filter((task) => task.armC.validatorSuccess).length,
      replayPasses: tasks.filter((task) => task.replay.exact).length,
      localShareBlocks: countBy(
        tasks.filter((task) => !task.armC.success),
        (task) => task.armC.category ?? task.compile.errorCategory ?? 'unknown',
      ),
    },
    gates,
    robustness: {
      byRepository: groupRobustness(tasks, 'repository'),
      byTaskFamily: groupRobustness(tasks, 'family'),
    },
    dominantFailures: {
      missingOracleObligationsByKind: countBy(
        tasks.flatMap((task) => Object.entries(task.oracle.missingKinds)
          .flatMap(([kind, count]) => Array.from({ length: count }, () => kind))),
        (kind) => kind,
      ),
      uncertaintyByKind: countBy(
        tasks.flatMap((task) => Object.entries(task.oracle.uncertaintyKinds)
          .flatMap(([kind, count]) => Array.from({ length: count }, () => kind))),
        (kind) => kind,
      ),
      overSelectionByChannel: countBy(
        tasks.flatMap((task) => Object.entries(task.selected?.overSelectionByChannel ?? {})
          .flatMap(([channel, count]) => Array.from({ length: count }, () => channel))),
        (channel) => channel,
      ),
      ambiguityCategories: countBy(
        tasks.flatMap((task) => Object.entries(task.missingContext?.ambiguityCategories ?? {})
          .flatMap(([category, count]) => Array.from({ length: count }, () => category))),
        (category) => category,
      ),
    },
    storage: {
      evaluationRunStartingBytes: storageBefore,
      initialTemporaryCorpusBytes: initialCorpusBytes,
      temporaryCorpusBytesAfterMaterialization: directoryBytes(corpusRoot),
      limitBytes: 5 * 1024 * 1024 * 1024,
      cleanup: {
        temporaryClonesRemoved: false,
        bytesRemoved: 0,
        retainedThirdPartySourceBytes: directoryBytes(corpusRoot),
      },
    },
    architecture: {
      runtimePackageDependencies: runtimeDependencyCount,
      forbiddenRuntimeMechanisms,
      graphDepth: 1,
      formatFilesChanged: formatChangedFiles,
      newCapturePath: false,
      productNetworkCalls: 0,
      productModelCalls: 0,
    },
    limitations: [
      'The provisional oracle is regex- and public-review-reference-based, not a human gold label.',
      'Arm D and task-completion outcomes were not evaluated.',
      'Token counts are deterministic estimates, not model-tokenizer counts.',
      'Filesystem cache state was not forcibly reset between tasks.',
      'Human retention, addback, time-saved, comprehension, and full-change recheck observations remain pending.',
    ],
    tasks,
  };
  result.sourceFreeArtifactScan = sourceFreeArtifactScan(result);
  atomicWrite(resultPath, result);
  process.stdout.write(`${verdict}\n`);
}

main();
