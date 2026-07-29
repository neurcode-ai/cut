import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import {
  SHARE_LIMITS,
  finalizeShare,
  makePin,
  renderAgentJson,
  renderHtml,
  renderMarkdown,
  scanFields,
  sha256Bytes,
  writeShareArchive,
  type EvidenceItem,
  type FileItem,
  type ScanField,
  type SecretFinding,
  type ShareBundle,
  type ShareDocumentDraft,
  type ShareItem,
  type StoryFrame,
} from '@neurcode-ai/share-format';
import { runAirlock, type AirlockState } from './airlock';
import { captureEvidence, type EvidenceCapture } from './evidence';
import { pruneUnreferencedBlobs, readShareSelections } from './git-reader';

export interface CreateShareOptions {
  selections: string[];
  staged: boolean;
  diff: boolean | string;
  run?: string;
  runTimeoutSeconds: number;
  title?: string;
  message?: string;
  notes: string[];
  forceInclude: string[];
  stripContext: string[];
  acknowledgeFindings: string[];
  expire?: string;
  out?: string;
  preview?: boolean | string;
  copy?: boolean | string;
  stdout?: string;
  dryRun: boolean;
  yes: boolean;
  toolVersion: string;
  cwd?: string;
  capturedEvidence?: EvidenceCapture;
  itemOrder?: string[];
  reviewOutput?: NodeJS.WritableStream;
  browserItems?: Array<{
    path: string;
    content: string;
    source: 'pasted' | 'uploaded';
    language?: string;
  }>;
  hostedPublish?: {
    visibility: 'unlisted' | 'restricted' | 'public';
    expiryHours: number;
    recipientCount: number;
  };
}

function addBlob(blobs: Map<string, Buffer>, content: Buffer): string {
  const hash = sha256Bytes(content);
  blobs.set(hash, content);
  return hash;
}

function parseNotes(values: string[]): Map<string, string> {
  const notes = new Map<string, string>();
  for (const value of values) {
    const equals = value.indexOf('=');
    if (equals < 1) throw new Error(`Notes use --note <file>=<text>: ${value}`);
    const target = value.slice(0, equals).trim().replace(/^\.\//, '');
    const note = value.slice(equals + 1).trim();
    if (!note) throw new Error(`Note is empty for ${target}.`);
    if (note.length > 4_000) throw new Error(`Note for ${target} exceeds 4,000 characters.`);
    notes.set(target, note);
  }
  return notes;
}

function noteTarget(item: ShareItem): string[] {
  if (item.kind === 'file' || item.kind === 'excerpt') return [item.path, item.id];
  if (item.kind === 'diff') return ['diff', item.id];
  return ['run', item.id];
}

function buildFrames(items: ShareItem[], noteValues: string[]): StoryFrame[] {
  const notes = parseNotes(noteValues);
  const frames: StoryFrame[] = [];
  for (const [target, note] of notes) {
    const item = items.find((candidate) => noteTarget(candidate).includes(target));
    if (!item) throw new Error(`--note target is not in this Share: ${target}`);
    frames.push({
      id: `f${frames.length + 1}`,
      cite: { item: item.id },
      role: note.trim().endsWith('?') ? 'question' : 'explanation',
      note,
      class: 'asserted',
    });
  }
  return frames;
}

function fieldsForScan(state: Pick<AirlockState, 'draft' | 'blobs'>): ScanField[] {
  const fields: ScanField[] = [
    { scope: 'title', text: state.draft.manifest.title },
    { scope: 'intent', text: state.draft.manifest.intent },
  ];
  for (const frame of state.draft.story.frames) {
    fields.push({ scope: `note:${frame.cite.item}`, text: frame.note });
  }
  for (const item of state.draft.pack.items) {
    if (item.kind === 'file') {
      fields.push(
        { scope: `path:${item.id}`, text: item.path },
        { scope: `file:${item.id}`, text: state.blobs.get(item.blob)?.toString('utf8') ?? '' },
      );
    } else if (item.kind === 'excerpt') {
      fields.push(
        { scope: `path:${item.id}`, text: item.path },
        { scope: `excerpt:${item.id}`, text: state.blobs.get(item.blob)?.toString('utf8') ?? '' },
      );
      if (item.context) {
        fields.push({ scope: `context:${item.id}`, text: state.blobs.get(item.context.blob)?.toString('utf8') ?? '' });
      }
    } else if (item.kind === 'diff') {
      // Scanning the complete unified diff includes both added and removed lines.
      fields.push({ scope: 'diff:complete', text: state.blobs.get(item.blob)?.toString('utf8') ?? '' });
      item.files.forEach((file, index) => {
        fields.push({ scope: `path:${item.id}:${index + 1}`, text: file.path });
      });
    } else {
      fields.push({ scope: `argv:${item.id}`, text: item.argv.join(' ') });
      if (item.stdout) fields.push({ scope: `stdout:${item.id}`, text: state.blobs.get(item.stdout)?.toString('utf8') ?? '' });
      if (item.stderr) fields.push({ scope: `stderr:${item.id}`, text: state.blobs.get(item.stderr)?.toString('utf8') ?? '' });
    }
  }
  return fields;
}

function rescan(state: AirlockState): SecretFinding[] {
  return scanFields(fieldsForScan(state));
}

function rebuildBlobIndex(draft: ShareDocumentDraft, blobs: Map<string, Buffer>): void {
  pruneUnreferencedBlobs(draft.pack.items, blobs);
  const aggregateBytes = [...blobs.values()].reduce((sum, content) => sum + content.length, 0);
  if (aggregateBytes > SHARE_LIMITS.maxAggregateBlobBytes) {
    throw new Error(`Share exceeds the ${SHARE_LIMITS.maxAggregateBlobBytes}-byte aggregate uncompressed limit.`);
  }
  draft.pack.blobs = [...blobs.entries()]
    .map(([hash, content]) => ({ hash, bytes: content.length }))
    .sort((a, b) => a.hash.localeCompare(b.hash));
}

function titleAndIntent(
  message: string | undefined,
  repositoryName: string,
  explicitTitle?: string,
): { title: string; intent: string } {
  const intent = message?.trim() ?? '';
  const title = explicitTitle?.trim().slice(0, 180)
    || intent.split(/\r?\n/, 1)[0]?.slice(0, 180)
    || `Share from ${repositoryName}`;
  if (explicitTitle && !explicitTitle.trim()) throw new Error('Share title cannot be empty.');
  if (intent.length > 8_000) throw new Error('Share intent exceeds 8,000 characters.');
  return { title, intent };
}

function createdAt(): string {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch && /^\d+$/.test(epoch)) return new Date(Number(epoch) * 1000).toISOString();
  return new Date().toISOString();
}

function composerItemKey(item: ShareItem): string {
  if ((item.kind === 'file' || item.kind === 'excerpt') && (item.provenance === 'pasted' || item.provenance === 'uploaded')) {
    return `local:${item.path}`;
  }
  if (item.kind === 'file') return `selection:${item.path}`;
  if (item.kind === 'excerpt') return `selection:${item.path}:${item.range.start}-${item.range.end}`;
  if (item.kind === 'diff') return 'diff';
  return 'evidence';
}

function applyItemOrder(items: ShareItem[], order: string[] | undefined): void {
  if (!order?.length) return;
  const rank = new Map(order.map((key, index) => [key, index]));
  items.sort((left, right) => {
    const leftRank = rank.get(composerItemKey(left)) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(composerItemKey(right)) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
  items.forEach((item, index) => {
    item.id = `i${index + 1}`;
  });
}

function ensureParent(absolute: string): void {
  mkdirSync(dirname(absolute), { recursive: true });
}

function writeNewFile(path: string, content: Buffer | string): void {
  writeFileSync(path, content, { mode: 0o600, flag: 'wx' });
}

function outputFormat(path: string): 'archive' | 'markdown' | 'json' | 'html' {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tar.gz')) return 'archive';
  if (lower.endsWith('.md')) return 'markdown';
  if (lower.endsWith('.json')) return 'json';
  if (lower.endsWith('.html')) return 'html';
  throw new Error(`Unsupported Share output extension: ${extname(path) || '(none)'}. Use .tar.gz, .md, .json, or .html.`);
}

function bytesForFormat(bundle: ShareBundle, format: 'archive' | 'markdown' | 'json' | 'html'): Buffer {
  if (format === 'archive') return writeShareArchive(bundle);
  if (format === 'markdown') return Buffer.from(renderMarkdown(bundle));
  if (format === 'json') return Buffer.from(renderAgentJson(bundle));
  return Buffer.from(renderHtml(bundle));
}

function copyToClipboard(content: Buffer): void {
  const candidates = process.platform === 'darwin'
    ? [['pbcopy']]
    : process.platform === 'win32'
      ? [['clip']]
      : [['wl-copy'], ['xclip', '-selection', 'clipboard']];
  for (const [command, ...args] of candidates) {
    const result = spawnSync(command, args, { input: content, stdio: ['pipe', 'ignore', 'ignore'] });
    if (!result.error && result.status === 0) return;
  }
  throw new Error('No supported clipboard command was available. Use --out ctx.md or --stdout md.');
}

function normalizeMachineFormat(value: boolean | string | undefined): 'md' | 'json' | null {
  if (value === undefined || value === false) return null;
  if (value === true || value === 'md' || value === 'markdown') return 'md';
  if (value === 'json') return 'json';
  throw new Error(`Unsupported machine format: ${value}. Use md or json.`);
}

export async function createLocalShare(options: CreateShareOptions): Promise<{
  bundle?: ShareBundle;
  reviewState?: AirlockState;
  outputs: string[];
  dryRun: boolean;
  aborted: boolean;
}> {
  if (options.dryRun && options.run && !options.capturedEvidence) {
    throw new Error('--dry-run does not execute --run commands. Remove --run to inspect the source boundary, or rerun normally to capture evidence.');
  }
  const stdoutFormat = normalizeMachineFormat(options.stdout);
  const copyFormat = normalizeMachineFormat(options.copy);
  let out = options.out;
  if (!options.dryRun && !out && !options.preview && !copyFormat && !stdoutFormat && !options.hostedPublish) {
    out = 'neurcode-share.tar.gz';
  }
  const outPlan = out
    ? { absolute: resolve(out), format: outputFormat(out) }
    : null;
  const previewPlan = options.preview
    ? resolve(typeof options.preview === 'string' ? options.preview : 'neurcode-share-preview.html')
    : null;
  const plannedPaths = [outPlan?.absolute, previewPlan].filter((value): value is string => Boolean(value));
  if (new Set(plannedPaths).size !== plannedPaths.length) {
    throw new Error('Share output and preview must use different paths.');
  }
  for (const path of plannedPaths) {
    if (existsSync(path)) throw new Error(`Refusing to overwrite existing output: ${path}`);
  }
  const destinations = options.dryRun
    ? ['dry run: no files, stdout payload, or clipboard write']
    : [
        ...(outPlan ? [`local ${outPlan.format}: ${outPlan.absolute}`] : []),
        ...(previewPlan ? [`local HTML preview: ${previewPlan}`] : []),
        ...(stdoutFormat ? [`${stdoutFormat.toUpperCase()} payload on stdout`] : []),
        ...(copyFormat ? [`${copyFormat.toUpperCase()} payload on the local clipboard`] : []),
        ...(options.hostedPublish
          ? [
              `hosted ${options.hostedPublish.visibility} Share after browser authentication`
              + ` · expires in ${options.hostedPublish.expiryHours} hours`
              + ` · ${options.hostedPublish.recipientCount} allowed recipient(s)`,
            ]
          : []),
      ];
  const cwd = options.cwd ?? process.cwd();
  const selection = readShareSelections(cwd, {
    selections: options.selections,
    staged: options.staged,
    diff: options.diff,
    forceInclude: options.forceInclude,
    stripContext: options.stripContext,
    allowEmpty: Boolean(options.browserItems?.length),
  });
  const { title, intent } = titleAndIntent(options.message, selection.repository.name, options.title);
  const items = selection.items;
  const blobs = selection.blobs;
  for (const local of options.browserItems ?? []) {
    if (
      !local.path
      || local.path.startsWith('/')
      || local.path.includes('\\')
      || local.path.includes('\0')
      || local.path.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error(`Browser item has an unsafe portable path: ${local.path || '(empty)'}`);
    }
    const content = Buffer.from(local.content, 'utf8');
    if (content.length === 0 || content.length > SHARE_LIMITS.maxTextBlobBytes) {
      throw new Error(`Browser item ${local.path} must contain 1 to ${SHARE_LIMITS.maxTextBlobBytes} bytes of text.`);
    }
    if (items.some((item) => (item.kind === 'file' || item.kind === 'excerpt') && item.path === local.path)) {
      throw new Error(`Duplicate Share path: ${local.path}`);
    }
    const blob = addBlob(blobs, content);
    const opaqueOrigin = `local/opaque-${sha256Bytes(Buffer.from(`${local.path}\0${blob}`)).slice(7, 23)}`;
    const item: FileItem = {
      id: `i${items.length + 1}`,
      kind: 'file',
      provenance: local.source,
      class: 'observed',
      bytes: content.length,
      path: local.path,
      pin: makePin({
        origin: opaqueOrigin,
        revision: '0'.repeat(40),
        path: local.path,
        bytes: content,
      }),
      blob,
      mode: 0o644,
      language: local.language,
    };
    items.push(item);
  }
  let capturedEvidence: Awaited<ReturnType<typeof captureEvidence>> | undefined;

  if (options.run || options.capturedEvidence) {
    const timeoutMs = Math.floor(options.runTimeoutSeconds * 1000);
    const evidence = options.capturedEvidence ?? await captureEvidence({
      command: options.run as string,
      repoRoot: selection.repository.root,
      timeoutMs,
      // Never emit unscanned or unbounded command output. A bounded capture is
      // replayed only after every Share field has passed the secret scan.
      stream: false,
    });
    capturedEvidence = evidence;
    const stdout = evidence.stdout.length ? addBlob(blobs, evidence.stdout) : undefined;
    const stderr = evidence.stderr.length ? addBlob(blobs, evidence.stderr) : undefined;
    const item: EvidenceItem = {
      id: `i${items.length + 1}`,
      kind: 'evidence',
      provenance: 'worktree-captured',
      class: 'observed',
      bytes: evidence.stdout.length + evidence.stderr.length,
      argv: evidence.argv,
      exit: evidence.exit,
      stdout,
      stderr,
      startedAt: evidence.startedAt,
      durationMs: evidence.durationMs,
      cwd: evidence.cwd,
      observedBy: 'author-cli',
      timedOut: evidence.timedOut,
      stdoutTruncated: evidence.stdoutTruncated,
      stderrTruncated: evidence.stderrTruncated,
    };
    items.push(item);
  }
  if (items.length > SHARE_LIMITS.maxItems) throw new Error(`Share exceeds the ${SHARE_LIMITS.maxItems}-item limit.`);
  applyItemOrder(items, options.itemOrder);

  const frames = buildFrames(items, options.notes);
  const draft: ShareDocumentDraft = {
    manifest: {
      cut: 1,
      revisionOf: null,
      title,
      intent,
      createdAt: createdAt(),
      origin: {
        remote: selection.repository.origin,
        head: selection.repository.head,
        branch: selection.repository.branch,
        dirty: selection.repository.dirty,
      },
      tool: { name: 'neurcode', version: options.toolVersion },
      security: { class: 'asserted', acknowledgedFindings: [], consent: options.yes ? 'yes' : 'interactive' },
    },
    pack: { items, blobs: [] },
    story: { frames },
  };
  rebuildBlobIndex(draft, blobs);
  const initialState: AirlockState = {
    draft,
    blobs,
    findings: scanFields(fieldsForScan({ draft, blobs })),
    exclusions: selection.warnings,
    destinations,
  };
  if (capturedEvidence && initialState.findings.length === 0 && !options.stdout) {
    if (capturedEvidence.stdout.length) process.stdout.write(capturedEvidence.stdout);
    if (capturedEvidence.stderr.length) process.stderr.write(capturedEvidence.stderr);
  }
  const airlock = await runAirlock({
    state: initialState,
    acknowledgedFindingIds: options.acknowledgeFindings,
    yes: options.yes,
    dryRun: options.dryRun,
    output: options.reviewOutput ?? (options.stdout ? process.stderr : process.stdout),
    rescan,
  });
  if (!airlock.proceed) {
    return {
      reviewState: options.dryRun ? airlock : undefined,
      outputs: [],
      dryRun: options.dryRun,
      aborted: !options.dryRun,
    };
  }

  const currentFindingIds = new Set(airlock.findings.map((finding) => finding.id));
  airlock.draft.manifest.security = {
    class: 'asserted',
    acknowledgedFindings: options.acknowledgeFindings.filter((id) => currentFindingIds.has(id)).sort(),
    consent: airlock.consent ?? 'interactive',
  };
  rebuildBlobIndex(airlock.draft, airlock.blobs);
  const bundle: ShareBundle = { cut: finalizeShare(airlock.draft), blobs: airlock.blobs };
  // Building once is also the compressed pack-size acceptance check.
  const archive = writeShareArchive(bundle);
  const outputs: string[] = [];

  if (outPlan) {
    ensureParent(outPlan.absolute);
    writeNewFile(
      outPlan.absolute,
      outPlan.format === 'archive' ? archive : bytesForFormat(bundle, outPlan.format),
    );
    outputs.push(outPlan.absolute);
  }
  if (previewPlan) {
    ensureParent(previewPlan);
    writeNewFile(previewPlan, renderHtml(bundle));
    outputs.push(previewPlan);
  }
  if (stdoutFormat) {
    process.stdout.write(stdoutFormat === 'md' ? renderMarkdown(bundle) : renderAgentJson(bundle));
  }
  if (copyFormat) {
    copyToClipboard(Buffer.from(copyFormat === 'md' ? renderMarkdown(bundle) : renderAgentJson(bundle)));
  }

  const log = options.stdout ? process.stderr : process.stdout;
  log.write(`\nShare ready · ${bundle.cut.manifest.digest}\n`);
  for (const output of outputs) log.write(`  ${output}\n`);
  if (copyFormat) log.write(`  ${copyFormat.toUpperCase()} copied to clipboard\n`);
  log.write('Nothing was uploaded. Use Publish only after reviewing the exact disclosure.\n');
  return { bundle, outputs, dryRun: false, aborted: false };
}
