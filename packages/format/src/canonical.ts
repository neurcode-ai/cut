import { createHash } from 'node:crypto';
import type { ShareDocument, ShareDocumentDraft } from './model';

function serialize(value: unknown, seen: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Canonical JSON rejects non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => serialize(entry === undefined ? null : entry, seen)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if (seen.has(object)) throw new Error('Canonical JSON rejects cyclic structures.');
    seen.add(object);
    const result = `{${Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serialize(object[key], seen)}`)
      .join(',')}}`;
    seen.delete(object);
    return result;
  }
  throw new Error(`Canonical JSON cannot serialize ${typeof value}.`);
}

export function canonicalize(value: unknown): string {
  return serialize(value, new Set());
}

function digestMaterial(draft: ShareDocumentDraft): Record<string, unknown> {
  const manifest = { ...draft.manifest } as Record<string, unknown>;
  delete manifest.digest;
  // Capture time describes when the artifact was assembled; it is not part of
  // the content-addressed identity of the selected bytes and repository state.
  delete manifest.createdAt;
  const items = draft.pack.items.map((item) => {
    if (item.kind !== 'evidence') return item;
    const evidence = { ...item } as Record<string, unknown>;
    // The observed command, output, exit, duration, and bounds remain identity
    // material. Its wall-clock start is descriptive capture metadata.
    delete evidence.startedAt;
    return evidence;
  });
  return {
    manifest,
    items: [...items].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    blobs: [...draft.pack.blobs].sort((a, b) => a.hash.localeCompare(b.hash)),
    story: draft.story,
  };
}

export function computeShareDigest(draft: ShareDocumentDraft): string {
  const input = `neurcode-cut-v1\n${canonicalize(digestMaterial(draft))}`;
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

export function finalizeShare(draft: ShareDocumentDraft): ShareDocument {
  const digest = computeShareDigest(draft);
  return {
    ...draft,
    manifest: {
      ...draft.manifest,
      digest,
    },
  } as ShareDocument;
}
