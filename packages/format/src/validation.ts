import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { computeShareDigest } from './canonical';
import {
  SHARE_LIMITS,
  type BlobIndexEntry,
  type EvidenceItem,
  type ShareBundle,
  type ShareDocument,
  type ShareItem,
} from './model';

type ObjectValue = Record<string, unknown>;

const HASH = /^sha256:[a-f0-9]{64}$/;
const ITEM_ID = /^i[1-9]\d*$/;
const FRAME_ID = /^f[1-9]\d*$/;
const ORIGIN = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/[^\/\s]+\/[^\/\s]+|(?:local|remote)\/opaque-[a-f0-9]{16})$/i;
const PROVENANCE = new Set(['git-object-matched', 'worktree-captured', 'uploaded', 'pasted']);
const CHANGE_TYPES = new Set(['add', 'delete', 'modify', 'rename']);
const STORY_ROLES = new Set(['explanation', 'question', 'warning', 'todo', 'heading']);
const OBSERVERS = new Set(['author-cli', 'ci', 'unknown']);

function fail(message: string): never {
  throw new Error(`Invalid Cut document: ${message}`);
}

function objectAt(value: unknown, label: string): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} has an unsafe prototype.`);
  return value as ObjectValue;
}

function exactKeys(
  value: ObjectValue,
  required: string[],
  optional: string[],
  label: string,
): void {
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required.`);
  }
  for (const key of actual) {
    if (!allowed.has(key)) fail(`${label}.${key} is unknown.`);
  }
}

function stringAt(value: unknown, label: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > max || value.includes('\0')) {
    fail(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} bounded string.`);
  }
  return value as string;
}

function integerAt(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

function booleanAt(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(`${label} must be boolean.`);
  return value as boolean;
}

function enumAt(value: unknown, allowed: Set<string>, label: string): string {
  if (typeof value !== 'string' || !allowed.has(value)) fail(`${label} has an unsupported value.`);
  return value;
}

function timestampAt(value: unknown, label: string): string {
  const timestamp = stringAt(value, label, 64);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    fail(`${label} must be a canonical ISO-8601 timestamp.`);
  }
  return timestamp;
}

export function validatePortablePath(value: unknown, label: string): string {
  const path = stringAt(value, label, 4_096);
  if (
    path.startsWith('/')
    || path.includes('\\')
    || /[\r\n]/.test(path)
    || path.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    fail(`${label} is not a safe repository-relative path.`);
  }
  return path;
}

function hashAt(value: unknown, label: string): string {
  const hash = stringAt(value, label, 71);
  if (!HASH.test(hash)) fail(`${label} must be a lowercase SHA-256 identifier.`);
  return hash;
}

function provenanceAt(value: unknown, label: string): void {
  enumAt(value, PROVENANCE, label);
}

function baseItem(value: ObjectValue, index: number, kind: string): void {
  if (value.id !== `i${index + 1}` || !ITEM_ID.test(String(value.id))) {
    fail(`pack.items[${index}].id must be i${index + 1}.`);
  }
  if (value.kind !== kind) fail(`pack.items[${index}].kind is inconsistent.`);
  provenanceAt(value.provenance, `pack.items[${index}].provenance`);
  if (value.class !== 'observed') fail(`pack.items[${index}].class must be observed.`);
  integerAt(value.bytes, `pack.items[${index}].bytes`, 0, SHARE_LIMITS.maxTextBlobBytes * 2);
}

function validateFileItem(value: ObjectValue, index: number): void {
  exactKeys(
    value,
    ['id', 'kind', 'provenance', 'class', 'bytes', 'path', 'pin', 'blob', 'mode'],
    ['language'],
    `pack.items[${index}]`,
  );
  baseItem(value, index, 'file');
  validatePortablePath(value.path, `pack.items[${index}].path`);
  const blob = hashAt(value.blob, `pack.items[${index}].blob`);
  const pin = stringAt(value.pin, `pack.items[${index}].pin`, 8_192);
  if (!pin.endsWith(`!${blob}`) || /[\s\0]/.test(pin)) fail(`pack.items[${index}].pin does not bind its blob.`);
  integerAt(value.mode, `pack.items[${index}].mode`, 0, 0o777);
  if (value.language !== undefined) stringAt(value.language, `pack.items[${index}].language`, 64);
}

function validateExcerptItem(value: ObjectValue, index: number): void {
  exactKeys(
    value,
    ['id', 'kind', 'provenance', 'class', 'bytes', 'path', 'pin', 'blob', 'range'],
    ['context', 'language'],
    `pack.items[${index}]`,
  );
  baseItem(value, index, 'excerpt');
  validatePortablePath(value.path, `pack.items[${index}].path`);
  const blob = hashAt(value.blob, `pack.items[${index}].blob`);
  const pin = stringAt(value.pin, `pack.items[${index}].pin`, 8_192);
  if (!pin.endsWith(`!${blob}`) || /[\s\0]/.test(pin)) fail(`pack.items[${index}].pin does not bind its blob.`);
  const range = objectAt(value.range, `pack.items[${index}].range`);
  exactKeys(range, ['start', 'end'], [], `pack.items[${index}].range`);
  const start = integerAt(range.start, `pack.items[${index}].range.start`, 1);
  const end = integerAt(range.end, `pack.items[${index}].range.end`, start);
  if (value.context !== undefined) {
    const context = objectAt(value.context, `pack.items[${index}].context`);
    exactKeys(context, ['blob', 'start', 'end', 'bytes'], [], `pack.items[${index}].context`);
    hashAt(context.blob, `pack.items[${index}].context.blob`);
    const contextStart = integerAt(context.start, `pack.items[${index}].context.start`, 1, start);
    integerAt(context.end, `pack.items[${index}].context.end`, end);
    if (contextStart > start || (context.end as number) < end) {
      fail(`pack.items[${index}].context must contain the selected range.`);
    }
    integerAt(context.bytes, `pack.items[${index}].context.bytes`, 0, SHARE_LIMITS.maxTextBlobBytes);
  }
  if (value.language !== undefined) stringAt(value.language, `pack.items[${index}].language`, 64);
}

function validateDiffItem(value: ObjectValue, index: number): void {
  exactKeys(
    value,
    ['id', 'kind', 'provenance', 'class', 'bytes', 'blob', 'base', 'head', 'files', 'addedLines', 'removedLines'],
    [],
    `pack.items[${index}]`,
  );
  baseItem(value, index, 'diff');
  hashAt(value.blob, `pack.items[${index}].blob`);
  stringAt(value.base, `pack.items[${index}].base`, 8_192);
  stringAt(value.head, `pack.items[${index}].head`, 8_192);
  if (!Array.isArray(value.files) || value.files.length > SHARE_LIMITS.maxItems) {
    fail(`pack.items[${index}].files must be a bounded array.`);
  }
  let added = 0;
  let removed = 0;
  value.files.forEach((entry, fileIndex) => {
    const file = objectAt(entry, `pack.items[${index}].files[${fileIndex}]`);
    exactKeys(file, ['path', 'changeType', 'added', 'removed'], [], `pack.items[${index}].files[${fileIndex}]`);
    validatePortablePath(file.path, `pack.items[${index}].files[${fileIndex}].path`);
    enumAt(file.changeType, CHANGE_TYPES, `pack.items[${index}].files[${fileIndex}].changeType`);
    added += integerAt(file.added, `pack.items[${index}].files[${fileIndex}].added`, 0);
    removed += integerAt(file.removed, `pack.items[${index}].files[${fileIndex}].removed`, 0);
  });
  if (integerAt(value.addedLines, `pack.items[${index}].addedLines`, 0) !== added) {
    fail(`pack.items[${index}].addedLines does not match its file summaries.`);
  }
  if (integerAt(value.removedLines, `pack.items[${index}].removedLines`, 0) !== removed) {
    fail(`pack.items[${index}].removedLines does not match its file summaries.`);
  }
}

function validateEvidenceItem(value: ObjectValue, index: number): void {
  exactKeys(
    value,
    ['id', 'kind', 'provenance', 'class', 'bytes', 'argv', 'exit', 'startedAt', 'durationMs', 'cwd', 'observedBy', 'timedOut', 'stdoutTruncated', 'stderrTruncated'],
    ['stdout', 'stderr'],
    `pack.items[${index}]`,
  );
  baseItem(value, index, 'evidence');
  if (!Array.isArray(value.argv) || value.argv.length === 0 || value.argv.length > 128) {
    fail(`pack.items[${index}].argv must be a non-empty bounded array.`);
  }
  value.argv.forEach((argument, argumentIndex) =>
    stringAt(argument, `pack.items[${index}].argv[${argumentIndex}]`, 4_096, true));
  integerAt(value.exit, `pack.items[${index}].exit`, -2_147_483_648, 2_147_483_647);
  if (value.stdout !== undefined) hashAt(value.stdout, `pack.items[${index}].stdout`);
  if (value.stderr !== undefined) hashAt(value.stderr, `pack.items[${index}].stderr`);
  timestampAt(value.startedAt, `pack.items[${index}].startedAt`);
  if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
    fail(`pack.items[${index}].durationMs must be a non-negative finite number.`);
  }
  const cwd = stringAt(value.cwd, `pack.items[${index}].cwd`, 4_096);
  if (cwd !== '.') validatePortablePath(cwd, `pack.items[${index}].cwd`);
  enumAt(value.observedBy, OBSERVERS, `pack.items[${index}].observedBy`);
  booleanAt(value.timedOut, `pack.items[${index}].timedOut`);
  booleanAt(value.stdoutTruncated, `pack.items[${index}].stdoutTruncated`);
  booleanAt(value.stderrTruncated, `pack.items[${index}].stderrTruncated`);
}

function validateItem(value: unknown, index: number): ShareItem {
  const item = objectAt(value, `pack.items[${index}]`);
  if (item.kind === 'file') validateFileItem(item, index);
  else if (item.kind === 'excerpt') validateExcerptItem(item, index);
  else if (item.kind === 'diff') validateDiffItem(item, index);
  else if (item.kind === 'evidence') validateEvidenceItem(item, index);
  else fail(`pack.items[${index}].kind is unsupported.`);
  return item as unknown as ShareItem;
}

function referencedHashes(item: ShareItem): string[] {
  if (item.kind === 'file' || item.kind === 'diff') return [item.blob];
  if (item.kind === 'excerpt') return [item.blob, ...(item.context ? [item.context.blob] : [])];
  return [item.stdout, item.stderr].filter((value): value is string => Boolean(value));
}

export function validateShareDocument(value: unknown): ShareDocument {
  const root = objectAt(value, 'root');
  exactKeys(root, ['manifest', 'pack', 'story'], [], 'root');

  const manifest = objectAt(root.manifest, 'manifest');
  exactKeys(
    manifest,
    ['cut', 'digest', 'revisionOf', 'title', 'intent', 'createdAt', 'origin', 'tool', 'security'],
    [],
    'manifest',
  );
  if (manifest.cut !== 1) fail('manifest.cut must be 1.');
  hashAt(manifest.digest, 'manifest.digest');
  if (manifest.revisionOf !== null) hashAt(manifest.revisionOf, 'manifest.revisionOf');
  stringAt(manifest.title, 'manifest.title', 180);
  stringAt(manifest.intent, 'manifest.intent', 8_000, true);
  timestampAt(manifest.createdAt, 'manifest.createdAt');
  const origin = objectAt(manifest.origin, 'manifest.origin');
  exactKeys(origin, ['remote', 'head', 'branch', 'dirty'], [], 'manifest.origin');
  const remote = stringAt(origin.remote, 'manifest.origin.remote', 1_024);
  if (!ORIGIN.test(remote) || /[?#@:]/.test(remote)) fail('manifest.origin.remote is not sanitized.');
  if (!/^[a-f0-9]{40,64}$/i.test(stringAt(origin.head, 'manifest.origin.head', 64))) {
    fail('manifest.origin.head must be a commit hash.');
  }
  stringAt(origin.branch, 'manifest.origin.branch', 1_024, true);
  booleanAt(origin.dirty, 'manifest.origin.dirty');
  const tool = objectAt(manifest.tool, 'manifest.tool');
  exactKeys(tool, ['name', 'version'], [], 'manifest.tool');
  if (tool.name !== 'neurcode') fail('manifest.tool.name must be neurcode.');
  stringAt(tool.version, 'manifest.tool.version', 128);
  const security = objectAt(manifest.security, 'manifest.security');
  exactKeys(security, ['class', 'acknowledgedFindings', 'consent'], [], 'manifest.security');
  if (security.class !== 'asserted') fail('manifest.security.class must be asserted.');
  if (!Array.isArray(security.acknowledgedFindings) || security.acknowledgedFindings.length > 1_000) {
    fail('manifest.security.acknowledgedFindings must be a bounded array.');
  }
  const findingIds = new Set<string>();
  security.acknowledgedFindings.forEach((finding, index) => {
    if (typeof finding !== 'string' || !/^sf_[a-f0-9]{12}$/.test(finding) || findingIds.has(finding)) {
      fail(`manifest.security.acknowledgedFindings[${index}] is invalid or duplicated.`);
    }
    findingIds.add(finding);
  });
  enumAt(security.consent, new Set(['interactive', 'yes']), 'manifest.security.consent');

  const pack = objectAt(root.pack, 'pack');
  exactKeys(pack, ['items', 'blobs'], [], 'pack');
  if (!Array.isArray(pack.items) || pack.items.length === 0 || pack.items.length > SHARE_LIMITS.maxItems) {
    fail('pack.items must be a non-empty bounded array.');
  }
  const items = pack.items.map(validateItem);
  if (!items.some((item) => item.kind !== 'evidence')) fail('pack.items must contain source or a diff.');
  if (!Array.isArray(pack.blobs) || pack.blobs.length > SHARE_LIMITS.maxArchiveEntries - 4) {
    fail('pack.blobs must be a bounded array.');
  }
  const blobs = new Map<string, BlobIndexEntry>();
  let aggregateBlobBytes = 0;
  pack.blobs.forEach((entry, index) => {
    const blob = objectAt(entry, `pack.blobs[${index}]`);
    exactKeys(blob, ['hash', 'bytes'], [], `pack.blobs[${index}]`);
    const hash = hashAt(blob.hash, `pack.blobs[${index}].hash`);
    if (blobs.has(hash)) fail(`pack.blobs[${index}].hash is duplicated.`);
    const bytes = integerAt(blob.bytes, `pack.blobs[${index}].bytes`, 0, SHARE_LIMITS.maxTextBlobBytes);
    aggregateBlobBytes += bytes;
    blobs.set(hash, { hash, bytes });
  });
  if (aggregateBlobBytes > SHARE_LIMITS.maxAggregateBlobBytes) {
    fail('pack.blobs exceeds the aggregate uncompressed byte limit.');
  }
  const referenced = new Set<string>();
  for (const item of items) {
    const references = referencedHashes(item);
    for (const reference of references) {
      if (!blobs.has(reference)) fail(`item ${item.id} references an unindexed blob.`);
      referenced.add(reference);
    }
    const primaryBytes = item.kind === 'evidence'
      ? references.reduce((sum, hash) => sum + (blobs.get(hash)?.bytes ?? 0), 0)
      : blobs.get(references[0])?.bytes ?? -1;
    if (item.bytes !== primaryBytes) fail(`item ${item.id} byte count does not match its blob data.`);
    if (item.kind === 'excerpt' && item.context && blobs.get(item.context.blob)?.bytes !== item.context.bytes) {
      fail(`item ${item.id} context byte count does not match its blob data.`);
    }
  }
  for (const hash of blobs.keys()) {
    if (!referenced.has(hash)) fail(`pack.blobs contains unreferenced blob ${hash}.`);
  }

  const story = objectAt(root.story, 'story');
  exactKeys(story, ['frames'], [], 'story');
  if (!Array.isArray(story.frames) || story.frames.length > SHARE_LIMITS.maxItems) {
    fail('story.frames must be a bounded array.');
  }
  const itemIds = new Set(items.map((item) => item.id));
  const cited = new Set<string>();
  story.frames.forEach((entry, index) => {
    const frame = objectAt(entry, `story.frames[${index}]`);
    exactKeys(frame, ['id', 'cite', 'role', 'note', 'class'], [], `story.frames[${index}]`);
    if (frame.id !== `f${index + 1}` || !FRAME_ID.test(String(frame.id))) {
      fail(`story.frames[${index}].id must be f${index + 1}.`);
    }
    const cite = objectAt(frame.cite, `story.frames[${index}].cite`);
    exactKeys(cite, ['item'], [], `story.frames[${index}].cite`);
    const item = stringAt(cite.item, `story.frames[${index}].cite.item`, 32);
    if (!itemIds.has(item) || cited.has(item)) fail(`story.frames[${index}] has an invalid or duplicate citation.`);
    cited.add(item);
    enumAt(frame.role, STORY_ROLES, `story.frames[${index}].role`);
    stringAt(frame.note, `story.frames[${index}].note`, 4_000);
    if (frame.class !== 'asserted') fail(`story.frames[${index}].class must be asserted.`);
  });
  return value as ShareDocument;
}

function lineCount(content: Buffer): number {
  if (content.length === 0) return 1;
  let lines = 1;
  for (const byte of content) if (byte === 0x0a) lines += 1;
  return lines;
}

function paddedTarEntrySize(bytes: number): number {
  return 512 + bytes + ((512 - (bytes % 512)) % 512);
}

export function validateShareBundle(bundle: ShareBundle): {
  metadataBytes: number;
  aggregateBlobBytes: number;
  estimatedExpandedBytes: number;
} {
  const cut = validateShareDocument(bundle.cut);
  const expectedDigest = computeShareDigest({
    ...cut,
    manifest: { ...cut.manifest, digest: undefined },
  });
  if (cut.manifest.digest !== expectedDigest) fail('manifest.digest does not match the content identity.');
  const indexed = new Map(cut.pack.blobs.map((blob) => [blob.hash, blob]));
  if (bundle.blobs.size !== indexed.size) fail('bundle blob count does not match pack.blobs.');
  let aggregateBlobBytes = 0;
  for (const [hash, content] of bundle.blobs) {
    const index = indexed.get(hash);
    if (!index) fail(`bundle contains unindexed blob ${hash}.`);
    if (content.length !== index.bytes) fail(`bundle blob ${hash} has the wrong size.`);
    if (`sha256:${createHash('sha256').update(content).digest('hex')}` !== hash) {
      fail(`bundle blob ${hash} has the wrong digest.`);
    }
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      fail(`bundle blob ${hash} is not valid UTF-8 text.`);
    }
    aggregateBlobBytes += content.length;
  }
  if (aggregateBlobBytes > SHARE_LIMITS.maxAggregateBlobBytes) {
    fail('bundle exceeds the aggregate uncompressed byte limit.');
  }

  const metadataBytes = Buffer.byteLength(JSON.stringify(cut), 'utf8');
  if (metadataBytes > SHARE_LIMITS.maxMetadataBytes) fail('bundle metadata exceeds its byte limit.');
  let renderedContentBytes = 0;
  let renderedLines = 0;
  for (const item of cut.pack.items) {
    for (const hash of referencedHashes(item)) {
      const content = bundle.blobs.get(hash);
      if (!content) fail(`bundle is missing ${hash}.`);
      renderedContentBytes += content.length;
      renderedLines += lineCount(content);
    }
  }
  const htmlUpper = 256 * 1024
    + metadataBytes * 8
    + renderedContentBytes * 8
    + renderedLines * 320
    + cut.pack.items.length * 8_192;
  const markdownUpper = 64 * 1024
    + metadataBytes * 4
    // A pathological all-backtick blob can require two fences nearly as long
    // as the payload itself, so reserve four times the rendered content.
    + renderedContentBytes * 4
    + cut.pack.items.length * 4_096;
  const cutUpper = metadataBytes * 2 + 1_024;
  const estimatedExpandedBytes = [
    cutUpper,
    markdownUpper,
    Buffer.byteLength('# Cut by Neurcode consumption contract\n', 'utf8') + 4_096,
    htmlUpper,
    ...cut.pack.blobs.map((blob) => blob.bytes),
  ].reduce((sum, bytes) => sum + paddedTarEntrySize(bytes), 1_024);
  if (estimatedExpandedBytes > SHARE_LIMITS.maxArchiveExpandedBytes) {
    fail('rendered archive could exceed the expanded-size limit.');
  }
  if (4 + bundle.blobs.size > SHARE_LIMITS.maxArchiveEntries) {
    fail('bundle would exceed the archive entry-count limit.');
  }
  return { metadataBytes, aggregateBlobBytes, estimatedExpandedBytes };
}
