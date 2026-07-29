import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  finalizeShare,
  writeShareArchive,
  type ShareDocumentDraft,
} from '@neurcode-ai/share-format';
import { renderVerifiedArchive } from './index';

test('renders only after archive verification', () => {
  const content = Buffer.from('export const answer = 42;\n');
  const hash = `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const draft: ShareDocumentDraft = {
    manifest: {
      cut: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      tool: { name: 'neurcode', version: '1.0.0' },
      title: 'Synthetic example',
      intent: 'Verify static rendering',
      origin: { remote: 'example.com/acme/demo', head: '0'.repeat(40), branch: 'main', dirty: false },
      security: { class: 'asserted', consent: 'yes', acknowledgedFindings: [] },
      revisionOf: null,
    },
    pack: {
      items: [{
        id: 'i1',
        kind: 'file',
        path: 'src/example.ts',
        mode: 0o644,
        bytes: content.length,
        blob: hash,
        pin: `example.com/acme/demo@${'0'.repeat(40)}:src/example.ts!${hash}`,
        class: 'observed',
        provenance: 'git-object-matched',
        language: 'typescript',
      }],
      blobs: [{ hash, bytes: content.length }],
    },
    story: { frames: [] },
  };
  const bundle = { cut: finalizeShare(draft), blobs: new Map([[hash, content]]) };
  const html = renderVerifiedArchive(writeShareArchive(bundle), 'html');
  assert.match(html, /Synthetic example/);
  assert.match(html, /answer/);
});
