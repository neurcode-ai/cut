#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { root } from './lib.mjs';

const require = createRequire(import.meta.url);
const current = require(join(root, 'packages/format/dist/index.js'));
const scratch = mkdtempSync(join(tmpdir(), 'neurcode-cut-compat-'));

try {
  writeFileSync(join(scratch, 'package.json'), '{"name":"compatibility-consumer","private":true}\n');
  execFileSync(
    'npm',
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '@neurcode-ai/share-format@0.1.0'],
    { cwd: scratch, stdio: 'pipe' },
  );
  const oldRequire = createRequire(join(scratch, 'consumer.cjs'));
  const previous = oldRequire('@neurcode-ai/share-format');
  const content = Buffer.from('export const compatibility = true;\n');
  const hash = current.sha256Bytes(content);
  const draft = {
    manifest: {
      cut: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      tool: { name: 'neurcode', version: 'compatibility-test' },
      title: 'Synthetic compatibility fixture',
      intent: 'Prove cut/1 replay across package versions',
      origin: {
        remote: 'example.com/acme/compatibility',
        head: '0'.repeat(40),
        branch: 'main',
        dirty: false,
      },
      security: { class: 'asserted', consent: 'yes', acknowledgedFindings: [] },
      revisionOf: null,
    },
    pack: {
      items: [{
        id: 'i1',
        kind: 'file',
        path: 'src/compatibility.ts',
        mode: 0o644,
        bytes: content.length,
        blob: hash,
        pin: `example.com/acme/compatibility@${'0'.repeat(40)}:src/compatibility.ts!${hash}`,
        class: 'observed',
        provenance: 'git-object-matched',
        language: 'typescript',
      }],
      blobs: [{ hash, bytes: content.length }],
    },
    story: { frames: [] },
  };
  const bundle = { cut: current.finalizeShare(draft), blobs: new Map([[hash, content]]) };
  const currentArchive = current.writeShareArchive(bundle);
  const previousArchive = previous.writeShareArchive(bundle);
  if (!currentArchive.equals(previousArchive)) throw new Error('cut/1 archive bytes changed from 0.1.0.');
  if (previous.readShareArchive(currentArchive).cut.manifest.digest !== bundle.cut.manifest.digest) {
    throw new Error('0.1.0 could not replay the current cut/1 archive.');
  }
  if (current.readShareArchive(previousArchive).cut.manifest.digest !== bundle.cut.manifest.digest) {
    throw new Error('Current reader could not replay a 0.1.0 cut/1 archive.');
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

process.stdout.write('Format compatibility green: 0.1.0 ↔ 0.5.0 deterministic replay.\n');
