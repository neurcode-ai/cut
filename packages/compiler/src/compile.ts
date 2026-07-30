import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { posix } from 'node:path';
import {
  contextText,
  deniedPathReason,
  detectSymbols,
  directorySummary,
  extractStaticImports,
  identifierParts,
  isConfigurationPath,
  isMigrationPath,
  isTargetCodePath,
  isTestPath,
  rangeText,
  resolveRelativeImport,
  selectionFor,
  symbolsForRange,
  type DetectedSymbol,
  type StaticImport,
} from './analysis';
import {
  batchIgnoredPaths,
  listRepositoryPaths,
  readDiffSnapshot,
  readRepositoryText,
  type ChangedHunk,
  type DiffSnapshot,
} from './git';
import {
  COMPILER_LIMITS,
  estimateTokens,
  type CandidateChannel,
  type CompileInclusion,
  type CompileInput,
  type CompilePlan,
  type CoverageObligation,
  type ObligationKind,
} from './model';

const CHANNEL_PRIORITY: Record<CandidateChannel, number> = {
  definition: 0,
  dependency: 1,
  consumer: 2,
  test: 3,
  instruction: 4,
};

const BASE_WEIGHTS: Record<ObligationKind, number> = {
  implementation: 100,
  'public-interface': 8,
  'direct-consumer': 6,
  test: 5,
  configuration: 5,
  'data-migration': 7,
  'operational-evidence': 4,
  'security-sensitive': 10,
};

interface SourceRecord {
  path: string;
  text: string;
  symbols: DetectedSymbol[];
  imports: StaticImport[];
  dynamicRelativeSpecifiers: string[];
}

interface Candidate {
  id: string;
  selection: string;
  path: string;
  start?: number;
  end?: number;
  symbol?: string;
  channel: CandidateChannel;
  reason: string;
  covers: Set<string>;
  mandatory: boolean;
  estimatedTokens: number;
}

interface InternalObligation {
  id: string;
  kind: ObligationKind;
  weight: number;
  detail: string;
  preSatisfiedBy?: string;
}

interface Exclusion {
  channel: CandidateChannel | 'repository';
  path: string;
  reason: string;
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function wordPresent(text: string, value: string): boolean {
  if (!value || value === '*' || value === 'default') return false;
  return new RegExp(`(^|[^A-Za-z0-9_$])${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_$]|$)`).test(text);
}

function candidateTokens(source: string, start?: number, end?: number): number {
  const unique = new Set(contextText(source, start, end));
  return [...unique].reduce((sum, text) => sum + estimateTokens(text), 0);
}

function contentIdentity(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function estimatedUniqueTokens(texts: string[]): number {
  const unique = new Map<string, string>();
  for (const text of texts) unique.set(contentIdentity(text), text);
  return [...unique.values()].reduce((sum, text) => sum + estimateTokens(text), 0);
}

function lines(text: string): string[] {
  const result = text.split('\n');
  if (result.at(-1) === '') result.pop();
  return result.length ? result : [''];
}

function taskInterpretation(
  task: string,
  repositoryPaths: string[],
  changedSymbols: DetectedSymbol[],
): CompilePlan['interpretation'] {
  const explicitPaths = repositoryPaths.filter((path) => task.includes(path)).sort();
  const changedParts = new Set(changedSymbols.flatMap((symbol) => identifierParts(symbol.name)));
  const taskIdentifiers = task.match(/[A-Za-z_][A-Za-z0-9_-]{1,}/g) ?? [];
  const matchedTerms = uniqueSorted(taskIdentifiers.flatMap((identifier) =>
    identifierParts(identifier).filter((part) => changedParts.has(part))));
  const intents: CompilePlan['interpretation']['intents'] = [];
  if (/\b(?:review|security|audit)\b/i.test(task)) intents.push('review-security-audit');
  if (/\b(?:test|failing|repro)\b/i.test(task)) intents.push('test-failing-repro');
  if (/\b(?:migrate|migration|schema)\b/i.test(task)) intents.push('migrate-schema');
  if (/\b(?:performance|perf|latency|slow)\b/i.test(task)) intents.push('performance');
  const mode = explicitPaths.length || matchedTerms.length ? 'matched' : 'diff-only';
  return {
    mode,
    explicitPaths,
    matchedTerms,
    intents,
    message: mode === 'diff-only'
      ? 'No task terms matched changed symbols or exact repository paths. Selecting from the change alone.'
      : 'Task terms matched only the listed observed paths or changed-symbol terms.',
  };
}

function adjustedWeight(
  kind: ObligationKind,
  intents: CompilePlan['interpretation']['intents'],
): number {
  let weight = BASE_WEIGHTS[kind];
  if (kind === 'implementation') return weight;
  if (intents.includes('review-security-audit') && (kind === 'security-sensitive' || kind === 'direct-consumer')) {
    weight += 2;
  }
  if (intents.includes('test-failing-repro') && kind === 'test') weight += 2;
  if (intents.includes('migrate-schema') && (kind === 'configuration' || kind === 'data-migration')) weight += 2;
  if (intents.includes('performance') && kind === 'direct-consumer') weight += 2;
  return weight;
}

function sourceForPath(sources: Map<string, SourceRecord>, path: string): SourceRecord {
  const source = sources.get(path);
  if (!source) throw new Error(`Context compiler internal source index is missing changed path: ${path}`);
  return source;
}

function addCandidate(target: Map<string, Candidate>, candidate: Candidate): Candidate {
  const existing = target.get(candidate.selection);
  if (!existing) {
    target.set(candidate.selection, candidate);
    return candidate;
  }
  for (const obligation of candidate.covers) existing.covers.add(obligation);
  existing.mandatory ||= candidate.mandatory;
  if (CHANNEL_PRIORITY[candidate.channel] < CHANNEL_PRIORITY[existing.channel]) {
    existing.channel = candidate.channel;
    existing.reason = candidate.reason;
  }
  return existing;
}

function makeCandidate(input: {
  source: SourceRecord;
  channel: CandidateChannel;
  reason: string;
  start?: number;
  end?: number;
  symbol?: string;
  mandatory?: boolean;
}): Candidate {
  const selection = selectionFor(input.source.path, input.start, input.end);
  return {
    id: `${input.channel}:${selection}`,
    selection,
    path: input.source.path,
    start: input.start,
    end: input.end,
    symbol: input.symbol,
    channel: input.channel,
    reason: input.reason,
    covers: new Set(),
    mandatory: Boolean(input.mandatory),
    estimatedTokens: candidateTokens(input.source.text, input.start, input.end),
  };
}

function createObligation(
  target: Map<string, InternalObligation>,
  interpretation: CompilePlan['interpretation'],
  input: Omit<InternalObligation, 'weight'>,
): InternalObligation {
  const existing = target.get(input.id);
  if (existing) return existing;
  const obligation: InternalObligation = {
    ...input,
    weight: adjustedWeight(input.kind, interpretation.intents),
  };
  target.set(input.id, obligation);
  return obligation;
}

function changedHunkText(snapshot: DiffSnapshot, sources: Map<string, SourceRecord>, path: string): string {
  const source = sources.get(path);
  if (!source) return '';
  const sourceLines = lines(source.text);
  return snapshot.hunks
    .filter((hunk) => hunk.path === path && hunk.newLines > 0)
    .map((hunk) => sourceLines.slice(hunk.newStart - 1, hunk.newStart - 1 + hunk.newLines).join('\n'))
    .join('\n');
}

function symbolCandidatesForHunk(source: SourceRecord, hunk: ChangedHunk): DetectedSymbol[] {
  const sourceLineCount = lines(source.text).length;
  const start = Math.min(Math.max(1, hunk.newStart), sourceLineCount);
  const end = hunk.newLines > 0
    ? Math.min(sourceLineCount, start + hunk.newLines - 1)
    : start;
  return symbolsForRange(source.symbols, start, end);
}

function matchingSymbol(
  source: SourceRecord,
  names: string[],
): DetectedSymbol | undefined {
  for (const name of names) {
    const exact = source.symbols.find((symbol) =>
      symbol.name === name || (name === 'default' && symbol.kind === 'default'));
    if (exact) return exact;
  }
  return source.symbols.find((symbol) => symbol.exported);
}

function importerUseSymbol(source: SourceRecord, localNames: string[]): DetectedSymbol | undefined {
  return source.symbols.find((symbol) => {
    const text = rangeText(source.text, symbol.start, symbol.end);
    return localNames.some((name) => wordPresent(text, name));
  });
}

function candidateSort(left: Candidate, right: Candidate): number {
  return CHANNEL_PRIORITY[left.channel] - CHANNEL_PRIORITY[right.channel]
    || left.path.localeCompare(right.path)
    || (left.start ?? 0) - (right.start ?? 0)
    || (left.end ?? 0) - (right.end ?? 0)
    || left.selection.localeCompare(right.selection);
}

function summarizeExclusions(exclusions: Exclusion[]): string[] {
  const grouped = new Map<string, { channel: string; directory: string; reason: string; count: number }>();
  for (const exclusion of exclusions) {
    const directory = directorySummary(exclusion.path);
    const key = `${exclusion.channel}\0${directory}\0${exclusion.reason}`;
    const current = grouped.get(key);
    if (current) current.count += 1;
    else grouped.set(key, {
      channel: exclusion.channel,
      directory,
      reason: exclusion.reason,
      count: 1,
    });
  }
  return [...grouped.values()]
    .sort((left, right) =>
      left.channel.localeCompare(right.channel)
      || left.directory.localeCompare(right.directory)
      || left.reason.localeCompare(right.reason))
    .map((entry) =>
      `${entry.channel}: excluded ${entry.count} candidate${entry.count === 1 ? '' : 's'} under ${entry.directory} — ${entry.reason}`);
}

function securitySensitive(path: string, symbols: string[], task: string): boolean {
  const material = `${path} ${symbols.join(' ')} ${task}`;
  return /\b(?:auth|authorization|session|token|permission|crypto|cryptography|password|bearer|jwt)\b/i.test(material);
}

function configurationObligations(
  snapshot: DiffSnapshot,
  obligations: Map<string, InternalObligation>,
  interpretation: CompilePlan['interpretation'],
): void {
  for (const changed of snapshot.changed) {
    if (isConfigurationPath(changed.path)) {
      createObligation(obligations, interpretation, {
        id: `configuration:${changed.path}`,
        kind: 'configuration',
        detail: `Accepted patch changes configuration at ${changed.path}.`,
        preSatisfiedBy: 'complete-diff',
      });
    }
    if (isMigrationPath(changed.path)) {
      createObligation(obligations, interpretation, {
        id: `data-migration:${changed.path}`,
        kind: 'data-migration',
        detail: `Accepted patch changes migration material at ${changed.path}.`,
        preSatisfiedBy: 'complete-diff',
      });
    }
  }
}

function planObligations(
  obligations: Map<string, InternalObligation>,
  candidates: Candidate[],
  selected: Candidate[],
): CoverageObligation[] {
  const selectedSelections = new Set(selected.map((candidate) => candidate.selection));
  return [...obligations.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((obligation) => {
      const covering = candidates
        .filter((candidate) => candidate.covers.has(obligation.id) && selectedSelections.has(candidate.selection))
        .map((candidate) => candidate.selection)
        .sort();
      const satisfiedBy = obligation.preSatisfiedBy ? [obligation.preSatisfiedBy] : covering;
      const status = satisfiedBy.length ? 'satisfied' : 'unsatisfied';
      let reason: string | undefined;
      if (status === 'unsatisfied') {
        if (obligation.kind === 'operational-evidence') reason = 'no command evidence was supplied';
        else if (!candidates.some((candidate) => candidate.covers.has(obligation.id))) {
          reason = 'no bounded evidence-backed candidate was found';
        } else {
          reason = 'eligible candidates were not selected';
        }
      }
      return {
        id: obligation.id,
        kind: obligation.kind,
        weight: obligation.weight,
        status,
        satisfiedBy,
        detail: obligation.detail,
        reason,
      };
    });
}

function selectCandidates(
  candidates: Candidate[],
  obligations: Map<string, InternalObligation>,
  budget: number,
): Candidate[] {
  const selected: Candidate[] = candidates.filter((candidate) => candidate.mandatory).sort(candidateSort);
  const selectedKeys = new Set(selected.map((candidate) => candidate.selection));
  let used = selected.reduce((sum, candidate) => sum + candidate.estimatedTokens, 0);
  if (used > budget) {
    throw new Error(`Context compiler mandatory changed-symbol selection exceeds the ${budget}-token estimate budget.`);
  }
  const satisfied = new Set<string>();
  for (const obligation of obligations.values()) if (obligation.preSatisfiedBy) satisfied.add(obligation.id);
  for (const candidate of selected) for (const obligation of candidate.covers) satisfied.add(obligation);

  while (true) {
    const ranked = candidates
      .filter((candidate) => !selectedKeys.has(candidate.selection))
      .map((candidate) => {
        const uncovered = [...candidate.covers]
          .filter((id) => !satisfied.has(id))
          .reduce((sum, id) => sum + (obligations.get(id)?.weight ?? 0), 0);
        return {
          candidate,
          uncovered,
          score: uncovered / Math.sqrt(Math.max(1, candidate.estimatedTokens)),
        };
      })
      .filter((entry) => entry.uncovered > 0)
      .sort((left, right) =>
        right.score - left.score
        || candidateSort(left.candidate, right.candidate));
    const next = ranked[0]?.candidate;
    if (!next) break;
    if (used + next.estimatedTokens > budget) {
      const uncoveredIds = [...next.covers].filter((id) => !satisfied.has(id));
      const alternativesFit = candidates.some((candidate) =>
        !selectedKeys.has(candidate.selection)
        && used + candidate.estimatedTokens <= budget
        && uncoveredIds.some((id) => candidate.covers.has(id)));
      if (!alternativesFit) {
        throw new Error(`Context compiler budget cannot satisfy ${uncoveredIds.sort().join(', ')}.`);
      }
      next.covers.clear();
      continue;
    }
    selected.push(next);
    selectedKeys.add(next.selection);
    used += next.estimatedTokens;
    for (const obligation of next.covers) satisfied.add(obligation);
  }
  return selected.sort(candidateSort);
}

export function compile(input: CompileInput): CompilePlan {
  const started = performance.now();
  const wallClockLimit = input.wallClockLimitMs ?? COMPILER_LIMITS.wallClockMs;
  if (!Number.isFinite(wallClockLimit) || wallClockLimit <= 0 || wallClockLimit > COMPILER_LIMITS.wallClockMs) {
    throw new Error(`Context compiler wall-clock limit must be between 1 and ${COMPILER_LIMITS.wallClockMs} milliseconds.`);
  }
  const budget = input.estimatedTokenBudget ?? COMPILER_LIMITS.estimatedTokenBudget;
  if (!Number.isSafeInteger(budget) || budget <= 0) throw new Error('Context compiler estimated-token budget must be a positive integer.');
  const task = input.task?.trim() ?? '';
  if (task.length > 8_000 || task.includes('\0')) throw new Error('Context compiler task must be a bounded string.');
  const expired = (): boolean => performance.now() - started >= wallClockLimit;
  const truncationChannels = new Set<CandidateChannel>();
  const ambiguities: string[] = [];
  const exclusions: Exclusion[] = [];

  const gitStarted = performance.now();
  const snapshot = readDiffSnapshot(input.repositoryRoot, input.diff);
  const gitMs = performance.now() - gitStarted;

  const indexStarted = performance.now();
  const repositoryPaths = listRepositoryPaths(snapshot.repositoryRoot, snapshot.kind !== 'range');
  const targetPaths = repositoryPaths.filter(isTargetCodePath);
  const ignored = batchIgnoredPaths(snapshot.repositoryRoot, repositoryPaths);
  const eligiblePaths = targetPaths.filter((path) => {
    const reason = deniedPathReason(path);
    if (reason) exclusions.push({ channel: 'repository', path, reason });
    if (ignored.has(path)) exclusions.push({ channel: 'repository', path, reason: 'Git-ignored path' });
    return !reason && !ignored.has(path);
  });
  if (eligiblePaths.length > COMPILER_LIMITS.maximumTargetCodeFiles) {
    truncationChannels.add('consumer');
    truncationChannels.add('test');
    ambiguities.push(
      `Unknown: repository has ${eligiblePaths.length} target-language files; optional indexing was bounded to ${COMPILER_LIMITS.maximumTargetCodeFiles}.`,
    );
  }
  const indexedPaths = eligiblePaths.slice(0, COMPILER_LIMITS.maximumTargetCodeFiles);
  const sources = new Map<string, SourceRecord>();
  const changedTargetPaths = new Set(
    snapshot.changed
      .filter((entry) => entry.status !== 'D' && isTargetCodePath(entry.path) && !deniedPathReason(entry.path) && !ignored.has(entry.path))
      .map((entry) => entry.path),
  );
  for (const path of indexedPaths) {
    try {
      const text = readRepositoryText(snapshot.repositoryRoot, path);
      const extracted = extractStaticImports(text);
      sources.set(path, {
        path,
        text,
        symbols: detectSymbols(text),
        imports: extracted.imports,
        dynamicRelativeSpecifiers: extracted.dynamicRelativeSpecifiers,
      });
    } catch (error) {
      if (changedTargetPaths.has(path)) throw error;
      exclusions.push({ channel: 'repository', path, reason: 'optional source could not be parsed safely' });
      ambiguities.push(`Unknown: optional source under ${directorySummary(path)} could not be parsed safely.`);
    }
  }
  for (const path of changedTargetPaths) {
    if (!sources.has(path)) {
      const text = readRepositoryText(snapshot.repositoryRoot, path);
      const extracted = extractStaticImports(text);
      sources.set(path, {
        path,
        text,
        symbols: detectSymbols(text),
        imports: extracted.imports,
        dynamicRelativeSpecifiers: extracted.dynamicRelativeSpecifiers,
      });
    }
  }
  const codePathSet = new Set(sources.keys());
  const indexMs = performance.now() - indexStarted;

  const candidatesStarted = performance.now();
  const candidatesBySelection = new Map<string, Candidate>();
  const obligations = new Map<string, InternalObligation>();
  const definitionCandidatesByPath = new Map<string, Candidate[]>();
  const changedSymbols: DetectedSymbol[] = [];

  for (const changed of snapshot.changed) {
    if (changed.status === 'D' && isTargetCodePath(changed.path)) {
      ambiguities.push(`Unknown: deleted target-language source under ${directorySummary(changed.path)} has no post-image symbol range.`);
      continue;
    }
    if (!changedTargetPaths.has(changed.path)) continue;
    const source = sourceForPath(sources, changed.path);
    const pathHunks = snapshot.hunks.filter((hunk) => hunk.path === changed.path);
    const hunks = pathHunks.length
      ? pathHunks
      : [{ path: changed.path, oldStart: 1, oldLines: 0, newStart: 1, newLines: lines(source.text).length }];
    for (const [hunkIndex, hunk] of hunks.entries()) {
      const detected = symbolCandidatesForHunk(source, hunk);
      const symbols = detected.length ? detected : [undefined];
      for (const symbol of symbols) {
        const candidate = makeCandidate({
          source,
          channel: 'definition',
          start: symbol?.start,
          end: symbol?.end,
          symbol: symbol?.name,
          mandatory: true,
          reason: symbol
            ? `Machine-derived: contains changed enclosing symbol \`${symbol.name}\` at lines ${symbol.start}-${symbol.end}.`
            : 'Machine-derived (weak): changed hunk had no safely detected enclosing symbol; selected the complete file.',
        });
        const merged = addCandidate(candidatesBySelection, candidate);
        const obligation = createObligation(obligations, {
          mode: 'diff-only',
          explicitPaths: [],
          matchedTerms: [],
          intents: [],
          message: '',
        }, {
          id: `implementation:${changed.path}:${hunkIndex + 1}:${symbol?.name ?? 'whole-file'}`,
          kind: 'implementation',
          detail: symbol
            ? `Changed hunk ${hunkIndex + 1} is enclosed by ${symbol.name}.`
            : `Changed hunk ${hunkIndex + 1} requires a safe whole-file fallback.`,
        });
        merged.covers.add(obligation.id);
        if (symbol?.exported) {
          const publicObligation = createObligation(obligations, {
            mode: 'diff-only',
            explicitPaths: [],
            matchedTerms: [],
            intents: [],
            message: '',
          }, {
            id: `public-interface:${changed.path}:${symbol.name}`,
            kind: 'public-interface',
            detail: `Changed symbol ${symbol.name} is exported.`,
          });
          merged.covers.add(publicObligation.id);
        }
        if (isTestPath(changed.path)) {
          const testObligation = createObligation(obligations, {
            mode: 'diff-only',
            explicitPaths: [],
            matchedTerms: [],
            intents: [],
            message: '',
          }, {
            id: `test:changed:${changed.path}`,
            kind: 'test',
            detail: `Accepted patch changes test material at ${changed.path}.`,
          });
          merged.covers.add(testObligation.id);
        }
        if (symbol) changedSymbols.push(symbol);
        const current = definitionCandidatesByPath.get(changed.path) ?? [];
        if (!current.some((entry) => entry.selection === merged.selection)) current.push(merged);
        definitionCandidatesByPath.set(changed.path, current.sort(candidateSort));
      }
    }
  }

  const interpretation = taskInterpretation(task, repositoryPaths, changedSymbols);
  for (const obligation of obligations.values()) obligation.weight = adjustedWeight(obligation.kind, interpretation.intents);
  configurationObligations(snapshot, obligations, interpretation);
  const operational = createObligation(obligations, interpretation, {
    id: 'operational-evidence',
    kind: 'operational-evidence',
    detail: 'Observed command evidence for the proposed Share.',
    preSatisfiedBy: input.operationalEvidenceSupplied ? 'supplied-evidence' : undefined,
  });
  void operational;

  for (const [path, definitions] of definitionCandidatesByPath) {
    const symbolNames = definitions.map((candidate) => candidate.symbol).filter((name): name is string => Boolean(name));
    if (!securitySensitive(path, symbolNames, task)) continue;
    const obligation = createObligation(obligations, interpretation, {
      id: `security-sensitive:${path}`,
      kind: 'security-sensitive',
      detail: `Observed auth, session, token, permission, or cryptography term at ${path}.`,
    });
    for (const candidate of definitions) candidate.covers.add(obligation.id);
  }

  const optionalCandidates: Candidate[] = [];
  const channelDiscovered: Record<Exclude<CandidateChannel, 'definition'>, number> = {
    dependency: 0,
    consumer: 0,
    test: 0,
    instruction: 0,
  };
  const channelCaps: Record<Exclude<CandidateChannel, 'definition'>, number> = {
    dependency: COMPILER_LIMITS.dependencyCandidates,
    consumer: COMPILER_LIMITS.consumerCandidates,
    test: COMPILER_LIMITS.testCandidates,
    instruction: COMPILER_LIMITS.instructionCandidates,
  };
  const addOptional = (candidate: Candidate): Candidate | null => {
    const channel = candidate.channel as Exclude<CandidateChannel, 'definition'>;
    channelDiscovered[channel] += 1;
    if (channelDiscovered[channel] > channelCaps[channel]) {
      truncationChannels.add(channel);
      exclusions.push({ channel, path: candidate.path, reason: `channel cap ${channelCaps[channel]} reached` });
      return null;
    }
    optionalCandidates.push(candidate);
    return candidate;
  };

  if (!expired()) {
    for (const changedPath of [...definitionCandidatesByPath.keys()].sort()) {
      const source = sourceForPath(sources, changedPath);
      const changedText = changedHunkText(snapshot, sources, changedPath);
      for (const imported of source.imports) {
        if (!imported.specifier.startsWith('.')) continue;
        const resolved = resolveRelativeImport(changedPath, imported.specifier, codePathSet);
        if (!resolved) {
          ambiguities.push(`Unknown: relative import ${imported.specifier} from ${changedPath} did not resolve within the bounded TS/JS resolver.`);
          exclusions.push({ channel: 'dependency', path: changedPath, reason: 'unresolved relative import' });
          continue;
        }
        const relevantNames = imported.names.filter((name) =>
          wordPresent(changedText, name.local) || interpretation.matchedTerms.some((term) => identifierParts(name.local).includes(term)));
        if (!relevantNames.length) continue;
        const dependency = sourceForPath(sources, resolved);
        const symbol = matchingSymbol(dependency, relevantNames.map((name) => name.imported));
        const candidate = makeCandidate({
          source: dependency,
          channel: 'dependency',
          start: symbol?.start,
          end: symbol?.end,
          symbol: symbol?.name,
          reason: symbol
            ? `Machine-derived (weak): changed code references imported symbol \`${relevantNames[0].local}\`; selected its detected definition.`
            : `Machine-derived (weak): changed code references ${imported.specifier}, but no exact export range was detected; selected the complete module.`,
        });
        const obligation = createObligation(obligations, interpretation, {
          id: `public-interface:dependency:${changedPath}:${resolved}:${relevantNames.map((name) => name.imported).sort().join(',')}`,
          kind: 'public-interface',
          detail: `Changed code uses a depth-one relative import from ${resolved}.`,
        });
        candidate.covers.add(obligation.id);
        addOptional(candidate);
      }
      for (const specifier of source.dynamicRelativeSpecifiers) {
        ambiguities.push(`Unknown: dynamic import ${specifier} from ${changedPath} is outside the static resolver.`);
      }
    }
  } else {
    truncationChannels.add('dependency');
  }

  const importersByResolvedPath = new Map<string, Array<{ source: SourceRecord; imported: StaticImport }>>();
  if (!expired()) {
    for (const source of [...sources.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      for (const imported of source.imports) {
        const resolved = resolveRelativeImport(source.path, imported.specifier, codePathSet);
        if (!resolved) continue;
        const current = importersByResolvedPath.get(resolved) ?? [];
        current.push({ source, imported });
        importersByResolvedPath.set(resolved, current);
      }
    }
    for (const changedPath of [...definitionCandidatesByPath.keys()].sort()) {
      const importers = (importersByResolvedPath.get(changedPath) ?? [])
        .filter((entry) => entry.source.path !== changedPath)
        .sort((left, right) => left.source.path.localeCompare(right.source.path));
      if (importers.length > COMPILER_LIMITS.genericHubImporters) {
        exclusions.push({ channel: 'consumer', path: changedPath, reason: `generic hub with ${importers.length} importers` });
        continue;
      }
      const changedNames = new Set(
        (definitionCandidatesByPath.get(changedPath) ?? [])
          .map((candidate) => candidate.symbol)
          .filter((name): name is string => Boolean(name)),
      );
      for (const entry of importers) {
        if (isTestPath(entry.source.path)) continue;
        const relevant = entry.imported.names.filter((name) =>
          name.imported === '*' || name.imported === 'default' || changedNames.size === 0 || changedNames.has(name.imported));
        if (!relevant.length && !entry.imported.sideEffectOnly && !entry.imported.reExport) continue;
        const localNames = relevant.map((name) => name.local);
        const symbol = importerUseSymbol(entry.source, localNames);
        const candidate = makeCandidate({
          source: entry.source,
          channel: 'consumer',
          start: symbol?.start,
          end: symbol?.end,
          symbol: symbol?.name,
          reason: symbol
            ? `Machine-derived (weak): depth-one importer uses changed module inside detected symbol \`${symbol.name}\`.`
            : 'Machine-derived (weak): depth-one importer was found, but no bounded use-site symbol was detected; selected the complete file.',
        });
        const obligation = createObligation(obligations, interpretation, {
          id: `direct-consumer:${changedPath}:${entry.source.path}`,
          kind: 'direct-consumer',
          detail: `${entry.source.path} directly imports changed module ${changedPath}.`,
        });
        candidate.covers.add(obligation.id);
        addOptional(candidate);
      }
    }
  } else {
    truncationChannels.add('consumer');
  }

  if (!expired()) {
    const changedPaths = [...definitionCandidatesByPath.keys()].sort();
    const changedNames = uniqueSorted(
      [...definitionCandidatesByPath.values()].flatMap((entries) =>
        entries.map((candidate) => candidate.symbol).filter((name): name is string => Boolean(name))),
    );
    for (const source of [...sources.values()]
      .filter((entry) => isTestPath(entry.path) && !definitionCandidatesByPath.has(entry.path))
      .sort((left, right) => left.path.localeCompare(right.path))) {
      const importedChanged = source.imports.some((imported) => {
        const resolved = resolveRelativeImport(source.path, imported.specifier, codePathSet);
        return resolved ? changedPaths.includes(resolved) : false;
      });
      const mentioned = changedNames.filter((name) => wordPresent(source.text, name));
      if (!importedChanged && mentioned.length === 0) continue;
      const symbol = importerUseSymbol(source, mentioned);
      const candidate = makeCandidate({
        source,
        channel: 'test',
        start: symbol?.start,
        end: symbol?.end,
        symbol: symbol?.name,
        reason: symbol
          ? `Machine-derived (weak): convention-based test references changed material inside \`${symbol.name}\`.`
          : 'Machine-derived (weak): convention-based test imports or references changed material; selected the complete file.',
      });
      for (const changedPath of changedPaths) {
        const directlyImports = source.imports.some((imported) =>
          resolveRelativeImport(source.path, imported.specifier, codePathSet) === changedPath);
        const relevantName = (definitionCandidatesByPath.get(changedPath) ?? [])
          .some((definition) => definition.symbol ? wordPresent(source.text, definition.symbol) : false);
        if (!directlyImports && !relevantName) continue;
        const obligation = createObligation(obligations, interpretation, {
          id: `test:related:${changedPath}`,
          kind: 'test',
          detail: `A convention-based test references changed material from ${changedPath}.`,
        });
        candidate.covers.add(obligation.id);
      }
      if (candidate.covers.size) addOptional(candidate);
    }
  } else {
    truncationChannels.add('test');
  }

  if (!expired()) {
    const instructionPaths = repositoryPaths.filter((path) => /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/i.test(path));
    const nearby = new Set<string>();
    for (const changed of snapshot.changed) {
      let directory = posix.dirname(changed.path);
      for (let depth = 0; depth <= 2; depth += 1) {
        for (const name of ['AGENTS.md', 'CLAUDE.md']) {
          const candidate = directory === '.' ? name : `${directory}/${name}`;
          if (instructionPaths.includes(candidate)) nearby.add(candidate);
        }
        if (directory === '.') break;
        directory = posix.dirname(directory);
      }
    }
    for (const path of [...nearby].sort()) {
      if (ignored.has(path) || deniedPathReason(path)) continue;
      const text = readRepositoryText(snapshot.repositoryRoot, path);
      const source: SourceRecord = {
        path,
        text,
        symbols: [],
        imports: [],
        dynamicRelativeSpecifiers: [],
      };
      const candidate = makeCandidate({
        source,
        channel: 'instruction',
        reason: 'Machine-derived (weak): nearby repository instructions were found within the frozen two-directory bound.',
      });
      if (interpretation.explicitPaths.includes(path)) {
        const obligation = createObligation(obligations, interpretation, {
          id: `configuration:instruction:${path}`,
          kind: 'configuration',
          detail: `Task explicitly names nearby repository instructions at ${path}.`,
        });
        candidate.covers.add(obligation.id);
      }
      addOptional(candidate);
    }
  } else {
    truncationChannels.add('instruction');
  }

  const definitions = [...candidatesBySelection.values()].sort(candidateSort);
  if (definitions.length > COMPILER_LIMITS.totalCandidates) {
    throw new Error(`Context compiler mandatory definitions exceed the ${COMPILER_LIMITS.totalCandidates}-candidate limit.`);
  }
  const optionalSorted = optionalCandidates.sort(candidateSort);
  const remaining = COMPILER_LIMITS.totalCandidates - definitions.length;
  const retainedOptional = optionalSorted.slice(0, remaining);
  for (const omitted of optionalSorted.slice(remaining)) {
    truncationChannels.add(omitted.channel);
    exclusions.push({ channel: omitted.channel, path: omitted.path, reason: 'total candidate cap reached' });
  }
  for (const candidate of retainedOptional) addCandidate(candidatesBySelection, candidate);
  const candidates = [...candidatesBySelection.values()].sort(candidateSort);
  const candidatesMs = performance.now() - candidatesStarted;

  const obligationsStarted = performance.now();
  for (const candidate of candidates) {
    for (const obligationId of candidate.covers) {
      if (!obligations.has(obligationId)) {
        throw new Error(`Context compiler internal candidate references unknown obligation ${obligationId}.`);
      }
    }
  }
  const obligationsMs = performance.now() - obligationsStarted;

  const selectionStarted = performance.now();
  const selected = selectCandidates(candidates, obligations, budget);
  const coverage = planObligations(obligations, candidates, selected);
  const mandatoryUnsatisfied = coverage.filter((obligation) =>
    obligation.kind === 'implementation' && obligation.status !== 'satisfied');
  if (mandatoryUnsatisfied.length) {
    throw new Error(`Context compiler internal inconsistency left mandatory obligations unsatisfied: ${mandatoryUnsatisfied.map((entry) => entry.id).join(', ')}`);
  }
  const selectionMs = performance.now() - selectionStarted;

  const planStarted = performance.now();
  const baselineTexts = [snapshot.text];
  for (const changed of snapshot.changed) {
    if (changed.status === 'D') continue;
    baselineTexts.push(readRepositoryText(snapshot.repositoryRoot, changed.path));
  }
  const selectedTexts = [snapshot.text];
  for (const candidate of selected) {
    const source = sources.get(candidate.path);
    if (source) selectedTexts.push(...contextText(source.text, candidate.start, candidate.end));
    else selectedTexts.push(readRepositoryText(snapshot.repositoryRoot, candidate.path));
  }
  const inclusions: CompileInclusion[] = selected.map((candidate) => ({
    selection: candidate.selection,
    path: candidate.path,
    start: candidate.start,
    end: candidate.end,
    channel: candidate.channel,
    reason: candidate.reason,
    obligations: [...candidate.covers].sort(),
    estimatedTokens: candidate.estimatedTokens,
  }));
  const candidateCounts: CompilePlan['candidateCounts'] = {
    definition: candidates.filter((candidate) => candidate.channel === 'definition').length,
    dependency: candidates.filter((candidate) => candidate.channel === 'dependency').length,
    consumer: candidates.filter((candidate) => candidate.channel === 'consumer').length,
    test: candidates.filter((candidate) => candidate.channel === 'test').length,
    instruction: candidates.filter((candidate) => candidate.channel === 'instruction').length,
    total: candidates.length,
  };
  const planMs = performance.now() - planStarted;
  const totalMs = performance.now() - started;
  if (totalMs >= wallClockLimit) {
    for (const channel of ['dependency', 'consumer', 'test', 'instruction'] as CandidateChannel[]) {
      truncationChannels.add(channel);
    }
  }
  const plan: CompilePlan = {
    version: 0,
    task,
    diff: {
      kind: snapshot.kind,
      base: snapshot.base,
      head: snapshot.head,
      changedFiles: snapshot.changed.length,
    },
    interpretation,
    selections: inclusions.map((inclusion) => inclusion.selection),
    inclusions,
    exclusionSummary: summarizeExclusions(exclusions),
    obligations: coverage,
    estimatedInputTokens: estimatedUniqueTokens(baselineTexts),
    estimatedSelectedTokens: estimatedUniqueTokens(selectedTexts),
    candidateCounts,
    ambiguities: uniqueSorted(ambiguities),
    truncation: {
      truncated: truncationChannels.size > 0,
      channels: [...truncationChannels].sort((left, right) => CHANNEL_PRIORITY[left] - CHANNEL_PRIORITY[right]),
    },
    repository: {
      targetCodeFiles: eligiblePaths.length,
      ignoredTargetCodeFiles: targetPaths.length - eligiblePaths.length,
    },
    timings: {
      gitMs: Math.round(gitMs * 1000) / 1000,
      indexMs: Math.round(indexMs * 1000) / 1000,
      candidatesMs: Math.round(candidatesMs * 1000) / 1000,
      obligationsMs: Math.round(obligationsMs * 1000) / 1000,
      selectionMs: Math.round(selectionMs * 1000) / 1000,
      planMs: Math.round(planMs * 1000) / 1000,
      totalMs: Math.round(totalMs * 1000) / 1000,
    },
  };
  if (new Set(plan.selections).size !== plan.selections.length) {
    throw new Error('Context compiler internal inconsistency produced duplicate CLI selections.');
  }
  if (plan.candidateCounts.total > COMPILER_LIMITS.totalCandidates) {
    throw new Error('Context compiler internal inconsistency exceeded the total candidate cap.');
  }
  return plan;
}
