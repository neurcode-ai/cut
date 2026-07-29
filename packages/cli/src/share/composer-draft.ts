import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvidenceCapture } from './evidence';
import { composerGitDirectory } from './composer-data';

export type ComposerDiffMode =
  | { kind: 'none' }
  | { kind: 'current' }
  | { kind: 'staged' }
  | { kind: 'commit'; range: string; label: string };

export interface ComposerDraft {
  schemaVersion: 1;
  id: string;
  title: string;
  intent: string;
  selections: string[];
  diff: ComposerDiffMode;
  notes: Record<string, string>;
  order: string[];
  evidence: EvidenceCapture | null;
  localItems: Array<{
    path: string;
    content: string;
    source: 'pasted' | 'uploaded';
    language?: string;
  }>;
  visibility: 'unlisted' | 'restricted' | 'public';
  recipients: string[];
  expiryHours: number;
  updatedAt: string;
  version: number;
}

interface SerializedDraft extends Omit<ComposerDraft, 'evidence'> {
  evidence: null | Omit<EvidenceCapture, 'stdout' | 'stderr'> & {
    stdoutBase64: string;
    stderrBase64: string;
  };
}

function draftDirectory(cwd: string): string {
  return join(composerGitDirectory(cwd), 'neurcode-share', 'drafts');
}

function draftPath(cwd: string, id: string): string {
  if (!/^[a-f0-9]{24}$/.test(id)) throw new Error('Invalid local Share draft ID.');
  return join(draftDirectory(cwd), `${id}.json`);
}

export function newComposerDraft(preset?: 'handoff'): ComposerDraft {
  return {
    schemaVersion: 1,
    id: randomBytes(12).toString('hex'),
    title: preset === 'handoff' ? 'Continue this work' : '',
    intent: preset === 'handoff'
      ? 'What should the next person or AI agent understand, verify, or do next?'
      : '',
    selections: [],
    diff: preset === 'handoff' ? { kind: 'current' } : { kind: 'none' },
    notes: {},
    order: preset === 'handoff' ? ['diff'] : [],
    evidence: null,
    localItems: [],
    visibility: 'unlisted',
    recipients: [],
    expiryHours: 168,
    updatedAt: new Date().toISOString(),
    version: 1,
  };
}

function serialize(draft: ComposerDraft): SerializedDraft {
  return {
    ...draft,
    evidence: draft.evidence
      ? {
          ...draft.evidence,
          stdoutBase64: draft.evidence.stdout.toString('base64'),
          stderrBase64: draft.evidence.stderr.toString('base64'),
          stdout: undefined,
          stderr: undefined,
        } as SerializedDraft['evidence']
      : null,
  };
}

function deserialize(value: SerializedDraft): ComposerDraft {
  if (value.schemaVersion !== 1 || !/^[a-f0-9]{24}$/.test(value.id)) {
    throw new Error('Local Share draft has an unsupported format.');
  }
  const evidence = value.evidence
    ? {
        argv: value.evidence.argv,
        exit: value.evidence.exit,
        stdout: Buffer.from(value.evidence.stdoutBase64, 'base64'),
        stderr: Buffer.from(value.evidence.stderrBase64, 'base64'),
        startedAt: value.evidence.startedAt,
        durationMs: value.evidence.durationMs,
        cwd: value.evidence.cwd,
        timedOut: value.evidence.timedOut,
        stdoutTruncated: value.evidence.stdoutTruncated,
        stderrTruncated: value.evidence.stderrTruncated,
      }
    : null;
  const localItems = Array.isArray(value.localItems) ? value.localItems : [];
  const aggregate = localItems.reduce(
    (sum, item) => sum + (typeof item?.content === 'string' ? Buffer.byteLength(item.content) : 0),
    0,
  );
  if (localItems.length > 100 || aggregate > 12 * 1024 * 1024) {
    throw new Error('Local Share draft browser items exceed safe limits.');
  }
  return {
    ...value,
    evidence,
    localItems,
    visibility: value.visibility === 'restricted' || value.visibility === 'public' ? value.visibility : 'unlisted',
    recipients: Array.isArray(value.recipients) ? value.recipients : [],
    expiryHours: Number.isInteger(value.expiryHours) ? value.expiryHours : 168,
  };
}

export function saveComposerDraft(cwd: string, draft: ComposerDraft): void {
  const directory = draftDirectory(cwd);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = draftPath(cwd, draft.id);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(serialize(draft))}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, target);
}

export function loadComposerDraft(cwd: string, id: string): ComposerDraft {
  const parsed = JSON.parse(readFileSync(draftPath(cwd, id), 'utf8')) as SerializedDraft;
  return deserialize(parsed);
}
