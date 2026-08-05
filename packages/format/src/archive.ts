import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { canonicalize, computeShareDigest } from './canonical';
import { SHARE_LIMITS, type ShareBundle, type ShareDocument } from './model';
import { renderHtml } from './render/html';
import { CUT1_AGENT_GUIDANCE, renderMarkdown } from './render/markdown';
import { validateShareBundle, validateShareDocument } from './validation';

const BLOCK = 512;

interface ArchiveEntry {
  name: string;
  content: Buffer;
}

function derivedEntries(bundle: ShareBundle): ArchiveEntry[] {
  return [
    { name: 'cut.json', content: Buffer.from(`${canonicalize(bundle.cut)}\n`) },
    { name: 'README.md', content: Buffer.from(renderMarkdown(bundle, { cut1ArchiveCompatibility: true })) },
    { name: 'AGENT.md', content: Buffer.from(CUT1_AGENT_GUIDANCE) },
    { name: 'render/index.html', content: Buffer.from(renderHtml(bundle, { cut1ArchiveCompatibility: true })) },
  ];
}

function writeString(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) throw new Error(`Archive field is too long: ${value}`);
  bytes.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length > length - 1) throw new Error('Archive value exceeds field width.');
  writeString(target, offset, length, `${encoded}\0`);
}

function tarHeader(entry: ArchiveEntry): Buffer {
  if (Buffer.byteLength(entry.name, 'utf8') > 100) throw new Error(`Archive path is too long: ${entry.name}`);
  const header = Buffer.alloc(BLOCK, 0);
  writeString(header, 0, 100, entry.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.content.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  writeString(header, 265, 32, 'neurcode');
  writeString(header, 297, 32, 'neurcode');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, '0');
  writeString(header, 148, 8, `${checksumText}\0 `);
  return header;
}

function tar(entries: ArchiveEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry), entry.content);
    const padding = (BLOCK - (entry.content.length % BLOCK)) % BLOCK;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(chunks);
}

function tarExpandedBytes(entries: ArchiveEntry[]): number {
  return entries.reduce((total, entry) => {
    const padding = (BLOCK - (entry.content.length % BLOCK)) % BLOCK;
    return total + BLOCK + entry.content.length + padding;
  }, BLOCK * 2);
}

function safeArchivePath(name: string): boolean {
  return Boolean(name)
    && !name.startsWith('/')
    && !name.includes('\\')
    && !name.includes('\0')
    && name.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

function parseOctal(field: Buffer): number {
  const value = field.toString('ascii').replace(/\0.*$/, '').trim();
  if (!/^[0-7]*$/.test(value)) throw new Error('Invalid numeric field in Cut archive.');
  return value ? Number.parseInt(value, 8) : 0;
}

function verifyChecksum(header: Buffer): void {
  const expected = parseOctal(header.subarray(148, 156));
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (actual !== expected) throw new Error('Cut archive header checksum mismatch.');
}

export function writeShareArchive(bundle: ShareBundle): Buffer {
  // This conservative admission check runs before complete Markdown, HTML, or
  // tar representations are allocated.
  validateShareBundle(bundle);
  if (4 + bundle.blobs.size > SHARE_LIMITS.maxArchiveEntries) {
    throw new Error('Cut archive would exceed the entry-count limit.');
  }
  const entries: ArchiveEntry[] = derivedEntries(bundle);
  for (const [hash, content] of [...bundle.blobs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const hex = hash.replace(/^sha256:/, '');
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error(`Invalid blob hash: ${hash}`);
    entries.push({ name: `blobs/sha256/${hex.slice(0, 2)}/${hex.slice(2)}`, content });
  }
  const expandedBytes = tarExpandedBytes(entries);
  if (expandedBytes > SHARE_LIMITS.maxArchiveExpandedBytes) {
    throw new Error(`Cut archive exceeds the ${SHARE_LIMITS.maxArchiveExpandedBytes}-byte expanded limit.`);
  }
  // Node emits a zero gzip MTIME for reproducible output; tar headers above
  // likewise use zero timestamps and stable ordering.
  const output = gzipSync(tar(entries), { level: 9 });
  if (output.length > SHARE_LIMITS.compressedPackBytes) {
    throw new Error(`Cut archive exceeds the ${SHARE_LIMITS.compressedPackBytes}-byte compressed limit.`);
  }
  return output;
}

export function readShareArchive(input: Uint8Array): ShareBundle {
  if (input.byteLength > SHARE_LIMITS.compressedPackBytes) {
    throw new Error('Compressed Cut archive exceeds the allowed size.');
  }
  let expanded: Buffer;
  try {
    expanded = gunzipSync(input, { maxOutputLength: SHARE_LIMITS.maxArchiveExpandedBytes });
  } catch (error) {
    throw new Error(`Invalid or oversized Cut archive: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (expanded.length > SHARE_LIMITS.maxArchiveExpandedBytes) {
    throw new Error('Expanded Cut archive exceeds the allowed size.');
  }

  const entries = new Map<string, Buffer>();
  let offset = 0;
  let terminated = false;
  while (offset + BLOCK <= expanded.length) {
    const header = expanded.subarray(offset, offset + BLOCK);
    offset += BLOCK;
    if (header.every((byte) => byte === 0)) {
      terminated = true;
      break;
    }
    verifyChecksum(header);
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const type = header[156];
    if (!safeArchivePath(name)) throw new Error(`Unsafe path in Cut archive: ${name}`);
    if (type !== 0 && type !== 0x30) {
      throw new Error(`Unsupported non-regular entry in Cut archive: ${name}`);
    }
    if (entries.has(name)) throw new Error(`Duplicate entry in Cut archive: ${name}`);
    const size = parseOctal(header.subarray(124, 136));
    if (size < 0 || offset + size > expanded.length) throw new Error('Truncated Cut archive entry.');
    if (entries.size >= SHARE_LIMITS.maxArchiveEntries) throw new Error('Cut archive has too many entries.');
    entries.set(name, Buffer.from(expanded.subarray(offset, offset + size)));
    offset += size + ((BLOCK - (size % BLOCK)) % BLOCK);
  }
  if (!terminated || !expanded.subarray(offset).every((byte) => byte === 0)) {
    throw new Error('Cut archive has an invalid or non-zero trailer.');
  }

  const cutBytes = entries.get('cut.json');
  if (!cutBytes) throw new Error('Cut archive is missing cut.json.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cutBytes.toString('utf8'));
  } catch {
    throw new Error('Cut archive cut.json is invalid.');
  }
  const cut: ShareDocument = validateShareDocument(parsed);
  const recomputed = computeShareDigest({
    ...cut,
    manifest: { ...cut.manifest, digest: undefined },
  });
  if (recomputed !== cut.manifest.digest) throw new Error('Cut archive document digest mismatch.');

  const blobs = new Map<string, Buffer>();
  for (const blob of cut.pack.blobs) {
    if (!/^sha256:[a-f0-9]{64}$/.test(blob.hash) || !Number.isSafeInteger(blob.bytes) || blob.bytes < 0) {
      throw new Error('Cut archive contains an invalid blob index entry.');
    }
    const hex = blob.hash.slice('sha256:'.length);
    const name = `blobs/sha256/${hex.slice(0, 2)}/${hex.slice(2)}`;
    const content = entries.get(name);
    if (!content) throw new Error(`Cut archive is missing ${blob.hash}.`);
    if (content.length !== blob.bytes) throw new Error(`Cut archive blob size mismatch: ${blob.hash}.`);
    const actual = createHash('sha256').update(content).digest('hex');
    if (actual !== hex) throw new Error(`Cut archive blob digest mismatch: ${blob.hash}.`);
    blobs.set(blob.hash, content);
  }
  const expectedEntries = new Set([
    'cut.json',
    'README.md',
    'AGENT.md',
    'render/index.html',
    ...cut.pack.blobs.map((blob) => {
      const hex = blob.hash.slice('sha256:'.length);
      return `blobs/sha256/${hex.slice(0, 2)}/${hex.slice(2)}`;
    }),
  ]);
  for (const required of expectedEntries) {
    if (!entries.has(required)) throw new Error(`Cut archive is missing ${required}.`);
  }
  for (const name of entries.keys()) {
    if (!expectedEntries.has(name)) throw new Error(`Cut archive contains an unknown entry: ${name}.`);
  }
  const bundle = { cut, blobs };
  validateShareBundle(bundle);
  for (const expected of derivedEntries(bundle)) {
    if (!entries.get(expected.name)?.equals(expected.content)) {
      throw new Error(`Cut archive derived entry mismatch: ${expected.name}.`);
    }
  }
  return bundle;
}
