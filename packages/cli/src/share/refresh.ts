import { createInterface } from 'node:readline/promises';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  finalizeShare,
  makePin,
  scanFields,
  sha256Bytes,
  writeShareArchive,
  type ExcerptItem,
  type FileItem,
  type ShareBundle,
  type ShareDocumentDraft,
  type ShareItem,
  type StoryFrame,
} from '@neurcode-ai/share-format';
import { runAirlock, type AirlockState } from './airlock';
import {
  fieldsForScan,
  rebuildBlobIndex,
  rescan,
} from './create';
import { pruneUnreferencedBlobs } from './git-reader';
import {
  comparisonBytes,
  type VerificationItemResult,
  type VerificationReport,
} from './verification';

export type RefreshDecision = 'keep' | 'use' | 'remove' | 'abort';

export interface RefreshResult {
  aborted: boolean;
  bundle?: ShareBundle;
  output?: string;
  delta: Array<{
    itemId: string;
    status: string;
    decision: RefreshDecision;
    before?: string;
    after?: string;
  }>;
}

function selectionLabel(path: string, range?: { start: number; end: number }): string {
  return `${path}${range ? `:${range.start}-${range.end}` : ''}`;
}

function parseReplacement(value: string): { path: string; range?: { start: number; end: number } } {
  const match = value.match(/^(.*):([1-9]\d*)-([1-9]\d*)$/);
  const path = (match ? match[1] : value).replace(/^\.\//, '');
  if (
    !path
    || path.startsWith('/')
    || path.includes('\\')
    || path.includes('\0')
    || path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Reviewed replacement has an unsafe path: ${value}`);
  }
  if (!match) return { path };
  const start = Number(match[2]);
  const end = Number(match[3]);
  if (end < start) throw new Error(`Reviewed replacement range is invalid: ${value}`);
  return { path, range: { start, end } };
}

function noteByItem(bundle: ShareBundle): Map<string, StoryFrame> {
  return new Map(bundle.cut.story.frames.map((frame) => [frame.cite.item, frame]));
}

async function interactiveDecisions(
  report: VerificationReport,
  supplied: Map<string, RefreshDecision>,
): Promise<Map<string, RefreshDecision>> {
  const decisions = new Map(supplied);
  const unresolved = report.items.filter((item) => item.status !== 'current' && !decisions.has(item.itemId));
  if (unresolved.length === 0) return decisions;
  if (!process.stdin.isTTY) {
    throw new Error(
      `Refresh requires an explicit decision for: ${unresolved.map((item) => item.itemId).join(', ')}. `
      + 'Use --decision <item>=keep|use|remove|abort.',
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const item of unresolved) {
      process.stdout.write(
        `\n${item.itemId} · ${item.status} · ${item.citationPath ?? item.itemKind}`
        + `${item.resolvedPath ? ` → ${item.resolvedPath}` : ''}\n${item.reason}\n`,
      );
      const answer = (await prompt.question('Decision [keep/use/remove/abort]: ')).trim().toLowerCase();
      if (!['keep', 'use', 'remove', 'abort'].includes(answer)) {
        throw new Error(`Refresh decision for ${item.itemId} was not recognized.`);
      }
      decisions.set(item.itemId, answer as RefreshDecision);
      if (answer === 'abort') break;
    }
    return decisions;
  } finally {
    prompt.close();
  }
}

function movedItem(
  item: FileItem | ExcerptItem,
  verification: VerificationItemResult,
  report: VerificationReport,
  originalBytes: Buffer,
): FileItem | ExcerptItem {
  if (!verification.resolvedPath || !verification.resolvedRange) {
    throw new Error(`${item.id} has no unique moved location to review.`);
  }
  const revision = report.comparison.kind === 'revision'
    ? report.comparison.revision
    : report.comparison.kind === 'staged'
      ? 'index'
      : 'worktree';
  const provenance = report.comparison.kind === 'revision'
    ? 'git-object-matched' as const
    : 'worktree-captured' as const;
  if (item.kind === 'file') {
    return {
      ...item,
      path: verification.resolvedPath,
      provenance,
      pin: makePin({
        origin: report.comparison.repository,
        revision,
        path: verification.resolvedPath,
        bytes: originalBytes,
      }),
    };
  }
  return {
    ...item,
    path: verification.resolvedPath,
    provenance,
    range: verification.resolvedRange,
    context: undefined,
    pin: makePin({
      origin: report.comparison.repository,
      revision,
      path: verification.resolvedPath,
      range: verification.resolvedRange,
      bytes: originalBytes,
    }),
  };
}

function reviewedReplacement(input: {
  item: FileItem | ExcerptItem;
  verification: VerificationItemResult;
  replacement?: string;
  repoPath: string;
  against?: string;
  staged?: boolean;
  blobs: Map<string, Buffer>;
}): FileItem | ExcerptItem {
  const fallbackPath = input.verification.resolvedPath ?? input.verification.citationPath;
  const fallbackRange = input.verification.resolvedRange ?? input.verification.citationRange;
  if (!input.replacement && input.verification.status === 'ambiguous') {
    throw new Error(`${input.item.id} is ambiguous; --replacement ${input.item.id}=<path[:start-end]> is required.`);
  }
  if (!input.replacement && input.verification.status === 'deleted') {
    throw new Error(`${input.item.id} is deleted; --replacement ${input.item.id}=<path[:start-end]> is required.`);
  }
  const selected = input.replacement
    ? parseReplacement(input.replacement)
    : fallbackPath
      ? { path: fallbackPath, range: fallbackRange }
      : null;
  if (!selected) throw new Error(`${input.item.id} has no reviewed current replacement.`);
  if (input.item.kind === 'file' && selected.range) {
    throw new Error(`${input.item.id} is a whole-file item; its reviewed replacement must name a whole file.`);
  }
  if (input.item.kind === 'excerpt' && !selected.range) {
    throw new Error(`${input.item.id} is an excerpt; its reviewed replacement must include a line range.`);
  }
  const captured = comparisonBytes({
    repoPath: input.repoPath,
    against: input.against,
    staged: input.staged,
    path: selected.path,
    range: selected.range,
  });
  const blob = sha256Bytes(captured.bytes);
  input.blobs.set(blob, captured.bytes);
  const revision = captured.target.kind === 'revision'
    ? captured.target.revision
    : captured.target.kind === 'staged'
      ? 'index'
      : 'worktree';
  const provenance = captured.target.kind === 'revision' ? 'git-object-matched' as const : 'worktree-captured' as const;
  if (input.item.kind === 'file') {
    return {
      ...input.item,
      path: selected.path,
      provenance,
      blob,
      bytes: captured.bytes.length,
      pin: makePin({
        origin: captured.target.repository,
        revision,
        path: selected.path,
        bytes: captured.bytes,
      }),
    };
  }
  return {
    ...input.item,
    path: selected.path,
    range: selected.range!,
    context: undefined,
    provenance,
    blob,
    bytes: captured.bytes.length,
    pin: makePin({
      origin: captured.target.repository,
      revision,
      path: selected.path,
      range: selected.range,
      bytes: captured.bytes,
    }),
  };
}

export async function refreshShare(input: {
  bundle: ShareBundle;
  report: VerificationReport;
  repoPath: string;
  against?: string;
  staged?: boolean;
  output: string;
  decisions?: Map<string, RefreshDecision>;
  replacements?: Map<string, string>;
  acknowledgeFindings?: string[];
  yes: boolean;
  toolVersion: string;
  reviewOutput?: NodeJS.WritableStream;
}): Promise<RefreshResult> {
  const decisions = await interactiveDecisions(input.report, input.decisions ?? new Map());
  const itemIds = new Set(input.report.items.map((item) => item.itemId));
  for (const itemId of decisions.keys()) {
    if (!itemIds.has(itemId)) throw new Error(`Refresh decision names an item outside this Cut: ${itemId}.`);
  }
  for (const itemId of input.replacements?.keys() ?? []) {
    if (!itemIds.has(itemId)) throw new Error(`Refresh replacement names an item outside this Cut: ${itemId}.`);
    if (decisions.get(itemId) !== 'use') {
      throw new Error(`Refresh replacement for ${itemId} requires --decision ${itemId}=use.`);
    }
  }
  if ([...decisions.values()].includes('abort')) {
    return { aborted: true, delta: [] };
  }
  const required = input.report.items.filter((item) => item.status !== 'current');
  const missing = required.filter((item) => !decisions.has(item.itemId));
  if (missing.length) {
    throw new Error(`Refresh requires explicit decisions for: ${missing.map((item) => item.itemId).join(', ')}.`);
  }

  const originalItems = new Map(input.bundle.cut.pack.items.map((item) => [item.id, item]));
  const notes = noteByItem(input.bundle);
  const blobs = new Map(input.bundle.blobs);
  const selected: Array<{ oldId: string; item: ShareItem }> = [];
  const delta: RefreshResult['delta'] = [];
  for (const result of input.report.items) {
    const item = originalItems.get(result.itemId)!;
    const decision: RefreshDecision = result.status === 'current'
      ? 'keep'
      : decisions.get(result.itemId)!;
    if (decision === 'abort') return { aborted: true, delta };
    if (decision === 'remove') {
      delta.push({
        itemId: item.id,
        status: result.status,
        decision,
        before: result.citationPath ? selectionLabel(result.citationPath, result.citationRange) : item.kind,
      });
      continue;
    }
    let next = item;
    if (decision === 'use') {
      if (result.status === 'moved' && (item.kind === 'file' || item.kind === 'excerpt') && !input.replacements?.has(item.id)) {
        const originalBytes = blobs.get(item.blob);
        if (!originalBytes) throw new Error(`${item.id} no longer has its immutable captured bytes.`);
        next = movedItem(item, result, input.report, originalBytes);
      } else if (item.kind === 'file' || item.kind === 'excerpt') {
        next = reviewedReplacement({
          item,
          verification: result,
          replacement: input.replacements?.get(item.id),
          repoPath: input.repoPath,
          against: input.against,
          staged: input.staged,
          blobs,
        });
      } else {
        throw new Error(`${item.id} is ${item.kind}; choose keep, remove, or abort.`);
      }
    }
    selected.push({ oldId: item.id, item: next });
    delta.push({
      itemId: item.id,
      status: result.status,
      decision,
      before: result.citationPath ? selectionLabel(result.citationPath, result.citationRange) : item.kind,
      after: next.kind === 'file' || next.kind === 'excerpt'
        ? selectionLabel(next.path, next.kind === 'excerpt' ? next.range : undefined)
        : next.kind,
    });
  }

  const idMap = new Map<string, string>();
  const items = selected.map(({ oldId, item }, index) => {
    const id = `i${index + 1}`;
    idMap.set(oldId, id);
    return { ...item, id } as ShareItem;
  });
  const frames = selected
    .map(({ oldId }) => ({ oldId, frame: notes.get(oldId) }))
    .filter((entry): entry is { oldId: string; frame: StoryFrame } => Boolean(entry.frame))
    .map(({ oldId, frame }, index) => ({
      ...frame,
      id: `f${index + 1}`,
      cite: { item: idMap.get(oldId)! },
    }));
  const repositoryHead = input.report.comparison.kind === 'revision'
    ? input.report.comparison.revision
    : input.report.comparison.revision.replace(/^(?:worktree|index)@/, '');
  const draft: ShareDocumentDraft = {
    manifest: {
      ...input.bundle.cut.manifest,
      digest: undefined,
      revisionOf: input.bundle.cut.manifest.digest,
      createdAt: new Date().toISOString(),
      origin: {
        remote: input.report.comparison.repository,
        head: repositoryHead,
        branch: input.report.comparison.kind === 'revision' ? '' : input.bundle.cut.manifest.origin.branch,
        dirty: input.report.comparison.dirty,
      },
      tool: { name: 'neurcode', version: input.toolVersion },
      security: {
        class: 'asserted',
        acknowledgedFindings: [],
        consent: input.yes ? 'yes' : 'interactive',
      },
    },
    pack: { items, blobs: [] },
    story: { frames },
  };
  pruneUnreferencedBlobs(items, blobs);
  rebuildBlobIndex(draft, blobs);
  const state: AirlockState = {
    draft,
    blobs,
    findings: scanFields(fieldsForScan({ draft, blobs })),
    exclusions: [],
    destinations: [`new local immutable revision: ${resolve(input.output)}`],
  };

  const output = input.reviewOutput ?? process.stdout;
  output.write('\nRefresh disclosure delta\n');
  for (const entry of delta) {
    output.write(
      `  ${entry.itemId} · ${entry.status} · ${entry.decision}`
      + `${entry.before ? ` · ${entry.before}` : ''}`
      + `${entry.after && entry.after !== entry.before ? ` → ${entry.after}` : ''}\n`,
    );
  }
  output.write(`  revisionOf · ${input.bundle.cut.manifest.digest}\n`);
  const airlock = await runAirlock({
    state,
    acknowledgedFindingIds: input.acknowledgeFindings ?? [],
    yes: input.yes,
    dryRun: false,
    output,
    rescan,
  });
  if (!airlock.proceed) return { aborted: true, delta };
  const findingIds = new Set(airlock.findings.map((finding) => finding.id));
  airlock.draft.manifest.security = {
    class: 'asserted',
    acknowledgedFindings: (input.acknowledgeFindings ?? []).filter((id) => findingIds.has(id)).sort(),
    consent: airlock.consent ?? 'interactive',
  };
  rebuildBlobIndex(airlock.draft, airlock.blobs);
  const bundle: ShareBundle = {
    cut: finalizeShare(airlock.draft),
    blobs: airlock.blobs,
  };
  const archive = writeShareArchive(bundle);
  const destination = resolve(input.output);
  if (existsSync(destination)) throw new Error(`Refusing to overwrite existing output: ${destination}`);
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, archive, { mode: 0o600, flag: 'wx' });
  output.write(`\nRefreshed local revision ready · ${bundle.cut.manifest.digest}\n  ${destination}\nNothing was published.\n`);
  return { aborted: false, bundle, output: destination, delta };
}
