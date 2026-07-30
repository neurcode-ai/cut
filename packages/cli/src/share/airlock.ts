import { createInterface } from 'node:readline/promises';
import type {
  SecretFinding,
  ShareDocumentDraft,
  ShareItem,
} from '@neurcode-ai/share-format';
import { canonicalize, finalizeShare } from '@neurcode-ai/share-format';
import { canonicalCompilePlan, type CompilePlan } from '@neurcode-ai/share-compiler';
import { pruneUnreferencedBlobs } from './git-reader';

export interface AirlockState {
  draft: ShareDocumentDraft;
  blobs: Map<string, Buffer>;
  findings: SecretFinding[];
  exclusions?: string[];
  destinations?: string[];
  compilerPlan?: CompilePlan;
}

export interface AirlockResult extends AirlockState {
  proceed: boolean;
  consent?: 'interactive' | 'yes';
}

function itemLabel(item: ShareItem): string {
  if (item.kind === 'file') return item.path;
  if (item.kind === 'excerpt') {
    return `${item.path}:${item.range.start}-${item.range.end}${item.context ? ` (+ context ${item.context.start}-${item.context.end})` : ' (context stripped)'}`;
  }
  if (item.kind === 'diff') return `unified diff (${item.files.length} file(s), +${item.addedLines} −${item.removedLines})`;
  return `observed command (${item.argv.join(' ')})`;
}

// Absolute local paths are not secret-scanner findings, but they can disclose
// local identity or machine layout. The visual Composer surfaces these; the
// terminal/headless disclosure must show the same advisory so power-user and
// agent flows are not less transparent than the browser.
function absolutePathWarnings(state: AirlockState): string[] {
  const pattern = /(?:\/(?:Users|home|private\/var|tmp)\/[^\s"'`<>]+|[A-Za-z]:\\[^\s"'`<>]+)/g;
  const warnings = new Set<string>();
  for (const item of state.draft.pack.items) {
    const hashes = item.kind === 'file' || item.kind === 'diff'
      ? [item.blob]
      : item.kind === 'excerpt'
        ? [item.blob, ...(item.context ? [item.context.blob] : [])]
        : [item.stdout, item.stderr].filter((value): value is string => Boolean(value));
    for (const hash of hashes) {
      const content = state.blobs.get(hash)?.toString('utf8') ?? '';
      for (const match of content.match(pattern) ?? []) warnings.add(`${item.id}: ${match.slice(0, 240)}`);
    }
  }
  return [...warnings].slice(0, 100);
}

function writeInventory(
  state: AirlockState,
  acknowledged: Set<string>,
  output: NodeJS.WritableStream,
): void {
  const hasBlockingFindings = state.findings.some((finding) => !acknowledged.has(finding.id));
  output.write('\nNeurcode Share: Review what will be shared\n');
  output.write('Nothing is uploaded until you explicitly choose Publish.\n\n');
  for (const item of state.draft.pack.items) {
    const label = hasBlockingFindings
      ? '[details withheld until blocking secret findings are resolved]'
      : itemLabel(item);
    output.write(`  ${item.id.padEnd(4)} ${item.kind.padEnd(9)} ${String(item.bytes).padStart(8)} B  ${item.provenance.padEnd(20)} ${label}\n`);
    if (item.kind === 'excerpt' && item.context) {
      output.write(`       context   ${String(item.context.bytes).padStart(8)} B  author-approved fixed lines ${item.context.start}-${item.context.end}\n`);
    }
  }
  if (state.exclusions?.length) {
    output.write('\n  Default-deny exclusions:\n');
    for (const exclusion of state.exclusions) output.write(`    - ${exclusion}\n`);
  }
  const blobBytes = [...state.blobs.values()].reduce((sum, blob) => sum + blob.length, 0);
  output.write(`\n  Total: ${state.draft.pack.items.length} item(s), ${state.blobs.size} unique blob(s), ${blobBytes} uncompressed bytes\n`);
  output.write(`  Origin: ${state.draft.manifest.origin.remote}@${state.draft.manifest.origin.head}\n`);
  output.write('  Destination(s):\n');
  for (const destination of state.destinations ?? ['local artifact (hosted work is gated)']) {
    output.write(`    - ${destination}\n`);
  }
  if (state.findings.length === 0) {
    output.write('  Secret scan: no findings (scanners have limits; review the inventory)\n');
  } else {
    output.write(`  Secret scan: ${state.findings.length} finding(s)\n`);
    for (const finding of state.findings) {
      const status = acknowledged.has(finding.id) ? 'acknowledged' : 'BLOCKING';
      output.write(`    ${finding.id}  ${status.padEnd(12)} ${finding.scope}:${finding.line}: ${finding.summary}\n`);
    }
  }
  if (hasBlockingFindings) {
    output.write('\n  Complete compiler plan and cut.json metadata boundary withheld while secret findings are blocking.\n');
    output.write('  Resolve, exclude, or explicitly acknowledge every displayed finding before metadata is shown.\n');
  } else {
    const absolutePaths = absolutePathWarnings(state);
    if (absolutePaths.length === 0) {
      output.write('  Absolute paths: none detected\n');
    } else {
      output.write(`  Absolute paths: ${absolutePaths.length} warning(s). They are not secret findings, but they disclose local identity or machine layout. Review each:\n`);
      for (const warning of absolutePaths) output.write(`    - ${warning}\n`);
    }
    if (state.compilerPlan) {
      output.write('\n  Selected by compiler — review every proposed item and unresolved obligation:\n');
      output.write(`    ${canonicalCompilePlan(state.compilerPlan)}\n`);
    }
    output.write('\n  Complete cut.json metadata boundary (content bytes are inventoried above):\n');
    output.write(`    ${canonicalize(finalizeShare(state.draft))}\n`);
  }
  output.write('\n');
}

function hasSource(items: ShareItem[]): boolean {
  return items.some((item) => item.kind !== 'evidence');
}

function stripContext(state: AirlockState, id: string): boolean {
  const item = state.draft.pack.items.find((candidate) => candidate.id === id);
  if (!item || item.kind !== 'excerpt' || !item.context) return false;
  delete item.context;
  pruneUnreferencedBlobs(state.draft.pack.items, state.blobs);
  return true;
}

function excludeItem(state: AirlockState, id: string): boolean {
  const index = state.draft.pack.items.findIndex((item) => item.id === id);
  if (index < 0) return false;
  const next = state.draft.pack.items.filter((_, itemIndex) => itemIndex !== index);
  if (!hasSource(next)) throw new Error('A Share cannot remove its last source or diff item.');
  state.draft.pack.items = next;
  state.draft.story.frames = state.draft.story.frames.filter((frame) => frame.cite.item !== id);
  pruneUnreferencedBlobs(state.draft.pack.items, state.blobs);
  return true;
}

export async function runAirlock(input: {
  state: AirlockState;
  acknowledgedFindingIds: string[];
  yes: boolean;
  dryRun: boolean;
  output?: NodeJS.WritableStream;
  rescan: (state: AirlockState) => SecretFinding[];
}): Promise<AirlockResult> {
  const output = input.output ?? process.stdout;
  const acknowledged = new Set(input.acknowledgedFindingIds);
  let state = input.state;
  const synchronizeSecurity = (): void => {
    const currentIds = new Set(state.findings.map((finding) => finding.id));
    state.draft.manifest.security = {
      class: 'asserted',
      acknowledgedFindings: [...acknowledged].filter((id) => currentIds.has(id)).sort(),
      consent: input.yes ? 'yes' : 'interactive',
    };
  };
  synchronizeSecurity();
  writeInventory(state, acknowledged, output);

  if (input.dryRun) return { ...state, proceed: false };

  const blocking = (): SecretFinding[] => state.findings.filter((finding) => !acknowledged.has(finding.id));
  if (input.yes) {
    if (blocking().length > 0) {
      throw new Error('Secret findings block this Share. Review them, then acknowledge each exact ID with --acknowledge-finding <id>.');
    }
    return { ...state, proceed: true, consent: 'yes' };
  }
  if (!process.stdin.isTTY) {
    throw new Error('Non-interactive creation requires --yes. The full inventory is still printed.');
  }

  const prompt = createInterface({ input: process.stdin, output });
  try {
    while (true) {
      output.write('Commands: y create local Share · s <item> strip context · x <item> exclude · q abort\n');
      const answer = (await prompt.question('review> ')).trim();
      if (answer === 'q' || answer === '') return { ...state, proceed: false };
      if (answer === 'y') {
        if (blocking().length > 0) {
          output.write('Blocked: acknowledge each displayed finding explicitly and rerun.\n\n');
          continue;
        }
        return { ...state, proceed: true, consent: 'interactive' };
      }
      const [command, id] = answer.split(/\s+/, 2);
      if (command === 's' && id) {
        if (!stripContext(state, id)) output.write(`Cannot strip context from ${id}.\n`);
      } else if (command === 'x' && id) {
        if (!excludeItem(state, id)) output.write(`Unknown item: ${id}.\n`);
      } else {
        output.write('Unknown command.\n');
      }
      state.findings = input.rescan(state);
      synchronizeSecurity();
      writeInventory(state, acknowledged, output);
    }
  } finally {
    prompt.close();
  }
}
