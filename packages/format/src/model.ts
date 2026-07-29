export type ProvenanceGrade =
  | 'git-object-matched'
  | 'worktree-captured'
  | 'uploaded'
  | 'pasted';

export type TruthClass = 'observed' | 'asserted' | 'derived';

export interface BlobIndexEntry {
  hash: string;
  bytes: number;
}

export interface ItemBase {
  id: string;
  kind: 'file' | 'excerpt' | 'diff' | 'evidence';
  provenance: ProvenanceGrade;
  class: 'observed';
  bytes: number;
}

export interface FileItem extends ItemBase {
  kind: 'file';
  path: string;
  pin: string;
  blob: string;
  mode: number;
  language?: string;
}

export interface ExcerptContext {
  blob: string;
  start: number;
  end: number;
  bytes: number;
}

export interface ExcerptItem extends ItemBase {
  kind: 'excerpt';
  path: string;
  pin: string;
  blob: string;
  range: { start: number; end: number };
  context?: ExcerptContext;
  language?: string;
}

export interface DiffItem extends ItemBase {
  kind: 'diff';
  blob: string;
  base: string;
  head: string;
  files: Array<{
    path: string;
    changeType: 'add' | 'delete' | 'modify' | 'rename';
    added: number;
    removed: number;
  }>;
  addedLines: number;
  removedLines: number;
}

export interface EvidenceItem extends ItemBase {
  kind: 'evidence';
  argv: string[];
  exit: number;
  stdout?: string;
  stderr?: string;
  startedAt: string;
  durationMs: number;
  cwd: string;
  observedBy: 'author-cli' | 'ci' | 'unknown';
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export type ShareItem = FileItem | ExcerptItem | DiffItem | EvidenceItem;

export interface StoryFrame {
  id: string;
  cite: { item: string };
  role: 'explanation' | 'question' | 'warning' | 'todo' | 'heading';
  note: string;
  class: 'asserted';
}

export interface ShareManifest {
  cut: 1;
  digest: string;
  revisionOf: string | null;
  title: string;
  intent: string;
  createdAt: string;
  origin: {
    remote: string;
    head: string;
    branch: string;
    dirty: boolean;
  };
  tool: { name: 'neurcode'; version: string };
  security: {
    class: 'asserted';
    acknowledgedFindings: string[];
    consent: 'interactive' | 'yes';
  };
}

export interface ShareDocument {
  manifest: ShareManifest;
  pack: {
    items: ShareItem[];
    blobs: BlobIndexEntry[];
  };
  story: {
    frames: StoryFrame[];
  };
}

export type ShareDocumentDraft = Omit<ShareDocument, 'manifest'> & {
  manifest: Omit<ShareManifest, 'digest'> & { digest?: string };
};

export interface ShareBundle {
  cut: ShareDocument;
  blobs: Map<string, Buffer>;
}

export const SHARE_LIMITS = {
  compressedPackBytes: 25 * 1024 * 1024,
  maxItems: 500,
  maxTextBlobBytes: 2 * 1024 * 1024,
  maxAggregateBlobBytes: 12 * 1024 * 1024,
  maxMetadataBytes: 2 * 1024 * 1024,
  maxEvidenceStreamBytes: 1024 * 1024,
  maxArchiveExpandedBytes: 50 * 1024 * 1024,
  maxArchiveEntries: 1000,
  defaultRunTimeoutMs: 60_000,
  maxRunTimeoutMs: 10 * 60_000,
} as const;
