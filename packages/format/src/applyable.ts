import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { canonicalize, computeShareDigest } from './canonical';
import type {
  ExcerptItem,
  FileItem,
  ProvenanceGrade,
  ShareBundle,
  ShareDocument,
} from './model';
import { validateShareDocument } from './validation';

export const APPLYABLE_REPLY_FORMAT = 'neurcode-cut-applyable-reply-v1' as const;
export const APPLYABLE_REPLY_ITEM_PATH = 'CUT_APPLYABLE_REPLY_V1.json' as const;

export const APPLYABLE_REPLY_LIMITS = {
  maxEdits: 20,
  maxMetadataBytes: 2 * 1024 * 1024,
  maxEditTextBytes: 1024 * 1024,
  maxContextBytes: 16 * 1024,
  maxPathBytes: 1024,
} as const;

export interface ApplyableReplyText {
  text: string;
  digest: string;
}

export interface ApplyableReplyEdit {
  id: string;
  parentItemId: string;
  kind: 'file' | 'excerpt';
  path: string;
  provenance: ProvenanceGrade;
  range: { start: number; end: number };
  original: ApplyableReplyText;
  context: { before: string; after: string };
  replacement: ApplyableReplyText;
  resultDigest: string;
}

export interface ApplyableReplyMetadata {
  format: typeof APPLYABLE_REPLY_FORMAT;
  parent: {
    cutId: string;
    digest: string;
    document: ShareDocument;
  };
  repository: {
    remote: string;
    baseRevision: string;
  };
  author: {
    kind: 'authenticated-user';
    displayName: string;
  };
  provenance: {
    createdBy: 'neurcode-share-cloud';
    interaction: 'browser-suggested-edit';
    serverAttestation: string;
  };
  edits: ApplyableReplyEdit[];
}

type PlainObject = Record<string, unknown>;

const HASH = /^sha256:[a-f0-9]{64}$/;
const SHARE_ID = /^shr_[A-Za-z0-9_-]{20,26}$/;
const ITEM_ID = /^i[1-9]\d*$/;
const REVISION = /^[a-f0-9]{40,64}$/i;
const ORIGIN = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\/[^\/\s]+\/[^\/\s]+|(?:local|remote)\/opaque-[a-f0-9]{16})$/i;
const PROVENANCE = new Set<ProvenanceGrade>([
  'git-object-matched',
  'worktree-captured',
  'uploaded',
  'pasted',
]);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

function fail(message: string): never {
  throw new Error(`Invalid applyable Cut reply: ${message}`);
}

function objectAt(value: unknown, label: string): PlainObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} has an unsafe prototype.`);
  return value as PlainObject;
}

function exactKeys(value: PlainObject, required: string[], label: string): void {
  const requiredSet = new Set(required);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required.`);
  }
  for (const key of Object.keys(value)) {
    if (!requiredSet.has(key)) fail(`${label}.${key} is unknown.`);
  }
}

function boundedString(value: unknown, label: string, maxBytes: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.includes('\0')) {
    fail(`${label} must be ${allowEmpty ? 'a' : 'a non-empty'} string.`);
  }
  if (Buffer.byteLength(value, 'utf8') > maxBytes) fail(`${label} exceeds its byte limit.`);
  // Buffer silently replaces lone UTF-16 surrogates. Round-tripping catches them
  // so every digest below names the exact text a conforming reader sees.
  const bytes = Buffer.from(value, 'utf8');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (decoded !== value) fail(`${label} is not canonical valid UTF-8 text.`);
  return value;
}

function hashAt(value: unknown, label: string): string {
  const result = boundedString(value, label, 71);
  if (!HASH.test(result)) fail(`${label} must be a lowercase SHA-256 identifier.`);
  return result;
}

function integerAt(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    fail(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value as number;
}

export function applyableTextDigest(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function validateApplyableRepositoryPath(value: unknown, label = 'path'): string {
  const path = boundedString(value, label, APPLYABLE_REPLY_LIMITS.maxPathBytes);
  if (
    path !== path.normalize('NFC')
    || path.startsWith('/')
    || path.includes('\\')
    || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(path)
    || /[<>:"|?*]/.test(path)
    || /%(?:2e|2f|5c)/i.test(path)
  ) {
    fail(`${label} is not a canonical repository-relative path.`);
  }
  const parts = path.split('/');
  if (
    parts.some((part) =>
      !part
      || part === '.'
      || part === '..'
      || part.toLowerCase() === '.git'
      || part.endsWith('.')
      || part.endsWith(' ')
      || WINDOWS_RESERVED.test(part)
      || Buffer.byteLength(part, 'utf8') > 255)
  ) {
    fail(`${label} contains an unsafe path component.`);
  }
  return path;
}

function validateText(value: unknown, label: string): ApplyableReplyText {
  const text = objectAt(value, label);
  exactKeys(text, ['text', 'digest'], label);
  const result = boundedString(text.text, `${label}.text`, APPLYABLE_REPLY_LIMITS.maxEditTextBytes, true);
  const digest = hashAt(text.digest, `${label}.digest`);
  if (applyableTextDigest(result) !== digest) fail(`${label}.digest does not match its exact text.`);
  return { text: result, digest };
}

function validateContext(value: unknown, label: string): { before: string; after: string } {
  const context = objectAt(value, label);
  exactKeys(context, ['before', 'after'], label);
  return {
    before: boundedString(context.before, `${label}.before`, APPLYABLE_REPLY_LIMITS.maxContextBytes, true),
    after: boundedString(context.after, `${label}.after`, APPLYABLE_REPLY_LIMITS.maxContextBytes, true),
  };
}

export function validateApplyableReplyMetadata(value: unknown): ApplyableReplyMetadata {
  const root = objectAt(value, 'metadata');
  exactKeys(root, ['format', 'parent', 'repository', 'author', 'provenance', 'edits'], 'metadata');
  if (root.format !== APPLYABLE_REPLY_FORMAT) fail('metadata.format is unsupported.');

  const parent = objectAt(root.parent, 'metadata.parent');
  exactKeys(parent, ['cutId', 'digest', 'document'], 'metadata.parent');
  const cutId = boundedString(parent.cutId, 'metadata.parent.cutId', 64);
  if (!SHARE_ID.test(cutId)) fail('metadata.parent.cutId is not a hosted Cut ID.');
  const parentDigest = hashAt(parent.digest, 'metadata.parent.digest');
  const parentDocument = validateShareDocument(parent.document);
  const recomputedParentDigest = computeShareDigest({
    ...parentDocument,
    manifest: { ...parentDocument.manifest, digest: undefined },
  });
  if (parentDocument.manifest.digest !== recomputedParentDigest || parentDigest !== recomputedParentDigest) {
    fail('metadata.parent.document does not prove the declared immutable parent digest.');
  }

  const repository = objectAt(root.repository, 'metadata.repository');
  exactKeys(repository, ['remote', 'baseRevision'], 'metadata.repository');
  const remote = boundedString(repository.remote, 'metadata.repository.remote', 1024);
  if (!ORIGIN.test(remote) || /[?#@:]/.test(remote)) fail('metadata.repository.remote is not sanitized.');
  const baseRevision = boundedString(repository.baseRevision, 'metadata.repository.baseRevision', 64);
  if (!REVISION.test(baseRevision)) fail('metadata.repository.baseRevision is invalid.');
  if (
    parentDocument.manifest.origin.remote !== remote
    || parentDocument.manifest.origin.head !== baseRevision
  ) {
    fail('metadata.repository does not match the proven parent document.');
  }

  const author = objectAt(root.author, 'metadata.author');
  exactKeys(author, ['kind', 'displayName'], 'metadata.author');
  if (author.kind !== 'authenticated-user') fail('metadata.author.kind is unsupported.');
  const displayName = boundedString(author.displayName, 'metadata.author.displayName', 120);
  if (/[\r\n\u001b]/.test(displayName)) fail('metadata.author.displayName contains unsafe controls.');

  const provenance = objectAt(root.provenance, 'metadata.provenance');
  exactKeys(provenance, ['createdBy', 'interaction', 'serverAttestation'], 'metadata.provenance');
  if (provenance.createdBy !== 'neurcode-share-cloud') fail('metadata.provenance.createdBy is unsupported.');
  if (provenance.interaction !== 'browser-suggested-edit') fail('metadata.provenance.interaction is unsupported.');
  const serverAttestation = boundedString(
    provenance.serverAttestation,
    'metadata.provenance.serverAttestation',
    80,
  );
  if (!/^hmac-sha256:[a-f0-9]{64}$/.test(serverAttestation)) {
    fail('metadata.provenance.serverAttestation is invalid.');
  }

  if (!Array.isArray(root.edits) || root.edits.length < 1 || root.edits.length > APPLYABLE_REPLY_LIMITS.maxEdits) {
    fail('metadata.edits must be a non-empty bounded array.');
  }
  const parentItems = new Set<string>();
  const paths = new Map<string, string>();
  const edits = root.edits.map((entry, index): ApplyableReplyEdit => {
    const label = `metadata.edits[${index}]`;
    const edit = objectAt(entry, label);
    exactKeys(
      edit,
      ['id', 'parentItemId', 'kind', 'path', 'provenance', 'range', 'original', 'context', 'replacement', 'resultDigest'],
      label,
    );
    if (edit.id !== `e${index + 1}`) fail(`${label}.id must be e${index + 1}.`);
    const parentItemId = boundedString(edit.parentItemId, `${label}.parentItemId`, 32);
    if (!ITEM_ID.test(parentItemId) || parentItems.has(parentItemId)) {
      fail(`${label}.parentItemId is invalid or duplicated.`);
    }
    parentItems.add(parentItemId);
    if (edit.kind !== 'file' && edit.kind !== 'excerpt') fail(`${label}.kind is unsupported.`);
    const path = validateApplyableRepositoryPath(edit.path, `${label}.path`);
    if (path === APPLYABLE_REPLY_ITEM_PATH) fail(`${label}.path targets the metadata item.`);
    const foldedPath = path.toLocaleLowerCase('en-US');
    const collidingPath = paths.get(foldedPath);
    if (collidingPath && collidingPath !== path) fail(`${label}.path has a case-colliding peer.`);
    if (collidingPath) fail(`${label}.path is duplicated.`);
    paths.set(foldedPath, path);
    if (typeof edit.provenance !== 'string' || !PROVENANCE.has(edit.provenance as ProvenanceGrade)) {
      fail(`${label}.provenance is unsupported.`);
    }
    const range = objectAt(edit.range, `${label}.range`);
    exactKeys(range, ['start', 'end'], `${label}.range`);
    const start = integerAt(range.start, `${label}.range.start`, 1);
    const end = integerAt(range.end, `${label}.range.end`, start);
    const original = validateText(edit.original, `${label}.original`);
    const context = validateContext(edit.context, `${label}.context`);
    const replacement = validateText(edit.replacement, `${label}.replacement`);
    const resultDigest = hashAt(edit.resultDigest, `${label}.resultDigest`);
    if (resultDigest !== replacement.digest) fail(`${label}.resultDigest does not match the proposed range result.`);
    if (original.text === replacement.text) fail(`${label} does not change the selected text.`);
    const provenItem = parentDocument.pack.items.find((item) => item.id === parentItemId);
    if (!provenItem || (provenItem.kind !== 'file' && provenItem.kind !== 'excerpt')) {
      fail(`${label} does not reference an eligible item in the proven parent document.`);
    }
    if (
      provenItem.kind !== edit.kind
      || provenItem.path !== path
      || provenItem.provenance !== edit.provenance
      || provenItem.blob !== original.digest
    ) {
      fail(`${label} does not match its proven parent item.`);
    }
    if (provenItem.kind === 'file') {
      const end = Math.max(1, lineChunks(original.text).length);
      if (start !== 1 || end !== (range.end as number) || context.before || context.after) {
        fail(`${label} has an invalid full-file range or context.`);
      }
    } else if (start !== provenItem.range.start || end !== provenItem.range.end) {
      fail(`${label}.range does not match the proven parent excerpt.`);
    }
    return {
      id: `e${index + 1}`,
      parentItemId,
      kind: edit.kind,
      path,
      provenance: edit.provenance as ProvenanceGrade,
      range: { start, end },
      original,
      context,
      replacement,
      resultDigest,
    };
  });

  return {
    format: APPLYABLE_REPLY_FORMAT,
    parent: { cutId, digest: parentDigest, document: parentDocument },
    repository: { remote, baseRevision },
    author: { kind: 'authenticated-user', displayName },
    provenance: {
      createdBy: 'neurcode-share-cloud',
      interaction: 'browser-suggested-edit',
      serverAttestation,
    },
    edits,
  };
}

export function serializeApplyableReplyMetadata(value: ApplyableReplyMetadata): Buffer {
  const validated = validateApplyableReplyMetadata(value);
  const bytes = Buffer.from(`${canonicalize(validated)}\n`, 'utf8');
  if (bytes.length > APPLYABLE_REPLY_LIMITS.maxMetadataBytes) fail('metadata exceeds its byte limit.');
  return bytes;
}

export function applyableReplyAttestationMaterial(value: ApplyableReplyMetadata): string {
  const checked = validateApplyableReplyMetadata(value);
  return `neurcode-cut-applyable-reply-attestation-v1\n${canonicalize({
    ...checked,
    provenance: {
      createdBy: checked.provenance.createdBy,
      interaction: checked.provenance.interaction,
    },
  })}`;
}

export function readApplyableReplyMetadata(bundle: ShareBundle): ApplyableReplyMetadata | null {
  const matches = bundle.cut.pack.items.filter(
    (item): item is FileItem => item.kind === 'file' && item.path === APPLYABLE_REPLY_ITEM_PATH,
  );
  if (matches.length === 0) return null;
  if (matches.length !== 1) fail('the Cut contains duplicate metadata items.');
  const item = matches[0];
  if (item.language !== 'json' || item.mode !== 0o644 || item.provenance !== 'uploaded') {
    fail('the metadata item has an invalid representation.');
  }
  const bytes = bundle.blobs.get(item.blob);
  if (!bytes || bytes.length !== item.bytes || bytes.length > APPLYABLE_REPLY_LIMITS.maxMetadataBytes) {
    fail('the metadata item blob is missing or oversized.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('the metadata item is not valid UTF-8 JSON.');
  }
  const metadata = validateApplyableReplyMetadata(parsed);
  if (!serializeApplyableReplyMetadata(metadata).equals(bytes)) {
    fail('the metadata item is not in its deterministic canonical form.');
  }
  return metadata;
}

function lineChunks(text: string): string[] {
  const chunks = text.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (chunks[chunks.length - 1] === '') chunks.pop();
  return chunks;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, end)); } catch {}
  }
  return '';
}

function utf8Suffix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= maxBytes) return value;
  const start = bytes.length - maxBytes;
  for (let offset = start; offset <= Math.min(bytes.length, start + 3); offset += 1) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset)); } catch {}
  }
  return '';
}

function expectedContext(item: ExcerptItem, bundle: ShareBundle): { before: string; after: string } {
  if (!item.context) return { before: '', after: '' };
  const contextBytes = bundle.blobs.get(item.context.blob);
  if (!contextBytes) fail(`parent item ${item.id} is missing its context blob.`);
  const contextText = new TextDecoder('utf-8', { fatal: true }).decode(contextBytes);
  const lines = lineChunks(contextText);
  const selectedStart = item.range.start - item.context.start;
  const selectedLength = item.range.end - item.range.start + 1;
  return {
    before: utf8Suffix(lines.slice(0, selectedStart).join(''), APPLYABLE_REPLY_LIMITS.maxContextBytes),
    after: utf8Prefix(lines.slice(selectedStart + selectedLength).join(''), APPLYABLE_REPLY_LIMITS.maxContextBytes),
  };
}

export function createApplyableReplyMetadata(input: {
  parentCutId: string;
  parent: ShareBundle;
  authorDisplayName: string;
  edits: Array<{ parentItemId: string; replacement: string }>;
  attest: (material: string) => string;
}): ApplyableReplyMetadata {
  if (!Array.isArray(input.edits)) fail('edits must be an array.');
  const edits = input.edits.map((requested, index): ApplyableReplyEdit => {
    const parentItem = input.parent.cut.pack.items.find((item) => item.id === requested.parentItemId);
    if (!parentItem || (parentItem.kind !== 'file' && parentItem.kind !== 'excerpt')) {
      fail(`requested edit ${index + 1} does not reference an eligible parent item.`);
    }
    const bytes = input.parent.blobs.get(parentItem.blob);
    if (!bytes) fail(`requested edit ${index + 1} parent bytes are missing.`);
    let original: string;
    try { original = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch {
      fail(`requested edit ${index + 1} parent bytes are not UTF-8 text.`);
    }
    const replacement = boundedString(
      requested.replacement,
      `requested edit ${index + 1} replacement`,
      APPLYABLE_REPLY_LIMITS.maxEditTextBytes,
      true,
    );
    const range = parentItem.kind === 'file'
      ? { start: 1, end: Math.max(1, lineChunks(original).length) }
      : parentItem.range;
    const context = parentItem.kind === 'file'
      ? { before: '', after: '' }
      : expectedContext(parentItem, input.parent);
    return {
      id: `e${index + 1}`,
      parentItemId: parentItem.id,
      kind: parentItem.kind,
      path: parentItem.path,
      provenance: parentItem.provenance,
      range,
      original: { text: original, digest: applyableTextDigest(original) },
      context,
      replacement: { text: replacement, digest: applyableTextDigest(replacement) },
      resultDigest: applyableTextDigest(replacement),
    };
  });
  const unsigned = {
    format: APPLYABLE_REPLY_FORMAT,
    parent: {
      cutId: input.parentCutId,
      digest: input.parent.cut.manifest.digest,
      document: input.parent.cut,
    },
    repository: {
      remote: input.parent.cut.manifest.origin.remote,
      baseRevision: input.parent.cut.manifest.origin.head,
    },
    author: { kind: 'authenticated-user', displayName: input.authorDisplayName },
    provenance: { createdBy: 'neurcode-share-cloud', interaction: 'browser-suggested-edit' },
    edits,
  } as const;
  const material = `neurcode-cut-applyable-reply-attestation-v1\n${canonicalize(unsigned)}`;
  return validateApplyableReplyMetadata({
    ...unsigned,
    provenance: {
      ...unsigned.provenance,
      serverAttestation: input.attest(material),
    },
  });
}

export function validateApplyableReplyAgainstParent(
  metadata: ApplyableReplyMetadata,
  parent: ShareBundle,
  expectedParentCutId?: string,
): void {
  const checked = validateApplyableReplyMetadata(metadata);
  if (expectedParentCutId && checked.parent.cutId !== expectedParentCutId) fail('parent Cut ID does not match.');
  if (checked.parent.digest !== parent.cut.manifest.digest) fail('parent digest does not match the immutable Cut.');
  if (canonicalize(checked.parent.document) !== canonicalize(parent.cut)) {
    fail('proven parent document does not match the authoritative parent Cut.');
  }
  if (checked.repository.remote !== parent.cut.manifest.origin.remote) fail('repository identity does not match the parent.');
  if (checked.repository.baseRevision !== parent.cut.manifest.origin.head) fail('base revision does not match the parent.');

  for (const edit of checked.edits) {
    const parentItem = parent.cut.pack.items.find((item) => item.id === edit.parentItemId);
    if (!parentItem || (parentItem.kind !== 'file' && parentItem.kind !== 'excerpt')) {
      fail(`${edit.id} does not reference an eligible parent item.`);
    }
    if (
      parentItem.kind !== edit.kind
      || parentItem.path !== edit.path
      || parentItem.provenance !== edit.provenance
    ) {
      fail(`${edit.id} does not match its parent item identity.`);
    }
    const originalBytes = parent.blobs.get(parentItem.blob);
    if (!originalBytes) fail(`${edit.id} parent bytes are missing.`);
    let originalText: string;
    try {
      originalText = new TextDecoder('utf-8', { fatal: true }).decode(originalBytes);
    } catch {
      fail(`${edit.id} parent bytes are not UTF-8 text.`);
    }
    if (originalText !== edit.original.text || applyableTextDigest(originalText) !== edit.original.digest) {
      fail(`${edit.id} original text does not match its immutable parent item.`);
    }
    if (parentItem.kind === 'file') {
      const end = Math.max(1, lineChunks(originalText).length);
      if (edit.range.start !== 1 || edit.range.end !== end || edit.context.before || edit.context.after) {
        fail(`${edit.id} has an invalid full-file range or context.`);
      }
    } else {
      if (edit.range.start !== parentItem.range.start || edit.range.end !== parentItem.range.end) {
        fail(`${edit.id} range does not match its parent excerpt.`);
      }
      const context = expectedContext(parentItem, parent);
      if (context.before !== edit.context.before || context.after !== edit.context.after) {
        fail(`${edit.id} context does not match its parent excerpt.`);
      }
    }
  }
}
