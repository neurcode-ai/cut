export type CompileDiff =
  | { kind: 'worktree' }
  | { kind: 'staged' }
  | { kind: 'range'; range: string };

export interface CompileInput {
  repositoryRoot: string;
  diff: CompileDiff;
  task?: string;
  estimatedTokenBudget?: number;
  operationalEvidenceSupplied?: boolean;
  wallClockLimitMs?: number;
}

export type CandidateChannel =
  | 'definition'
  | 'dependency'
  | 'consumer'
  | 'test'
  | 'instruction';

export type ObligationKind =
  | 'implementation'
  | 'public-interface'
  | 'direct-consumer'
  | 'test'
  | 'configuration'
  | 'data-migration'
  | 'operational-evidence'
  | 'security-sensitive';

export interface CompileInclusion {
  selection: string;
  path: string;
  start?: number;
  end?: number;
  channel: CandidateChannel;
  reason: string;
  obligations: string[];
  estimatedTokens: number;
}

export interface CoverageObligation {
  id: string;
  kind: ObligationKind;
  weight: number;
  status: 'satisfied' | 'unsatisfied';
  satisfiedBy: string[];
  detail: string;
  reason?: string;
}

export interface CompilePlan {
  version: 0;
  task: string;
  diff: {
    kind: CompileDiff['kind'];
    base: string;
    head: string;
    changedFiles: number;
  };
  interpretation: {
    mode: 'matched' | 'diff-only';
    explicitPaths: string[];
    matchedTerms: string[];
    intents: Array<'review-security-audit' | 'test-failing-repro' | 'migrate-schema' | 'performance'>;
    message: string;
  };
  selections: string[];
  inclusions: CompileInclusion[];
  exclusionSummary: string[];
  obligations: CoverageObligation[];
  estimatedInputTokens: number;
  estimatedSelectedTokens: number;
  candidateCounts: Record<CandidateChannel | 'total', number>;
  ambiguities: string[];
  truncation: {
    truncated: boolean;
    channels: CandidateChannel[];
  };
  repository: {
    targetCodeFiles: number;
    ignoredTargetCodeFiles: number;
  };
  timings: {
    gitMs: number;
    indexMs: number;
    candidatesMs: number;
    obligationsMs: number;
    selectionMs: number;
    planMs: number;
    totalMs: number;
  };
}

export const COMPILER_LIMITS = {
  dependencyCandidates: 25,
  consumerCandidates: 25,
  testCandidates: 10,
  instructionCandidates: 3,
  totalCandidates: 120,
  genericHubImporters: 20,
  wallClockMs: 3_000,
  estimatedTokenBudget: 25_000,
  maximumTargetCodeFiles: 10_000,
} as const;

export function estimateTokens(text: string): number {
  const lexicalRuns = text.match(/\S+/g)?.length ?? 0;
  return Math.max(1, Math.ceil(Math.max(text.length / 4, lexicalRuns * 1.3)));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

export function normalizeCompilePlan(plan: CompilePlan): Record<string, unknown> {
  return {
    ...plan,
    timings: Object.keys(plan.timings),
  };
}

export function canonicalCompilePlan(plan: CompilePlan, normalized = false): string {
  return JSON.stringify(stable(normalized ? normalizeCompilePlan(plan) : plan));
}
