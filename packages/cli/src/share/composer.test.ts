import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { launchShareComposer } from './composer';

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'neurcode-share-composer-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'current.ts'), 'export const current = 1;\n');
  writeFileSync(join(root, 'src', 'staged.ts'), 'export const staged = 1;\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'composer-test@neurcode.local']);
  git(root, ['config', 'user.name', 'Composer Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initial']);
  writeFileSync(join(root, 'src', 'current.ts'), 'export const current = 2;\n');
  writeFileSync(join(root, 'src', 'staged.ts'), 'export const staged = 2;\n');
  git(root, ['add', 'src/staged.ts']);
  return root;
}

test('loopback Composer is local-only, resumable, provenance-honest, and blocks exact findings', async () => {
  const root = fixture();
  const handle = await launchShareComposer({
    cwd: root,
    toolVersion: 'test',
    apiUrl: 'http://127.0.0.1:9',
    openBrowser: false,
    idleTimeoutMs: 60_000,
  });
  try {
    const url = new URL(handle.url);
    assert.equal(url.hostname, '127.0.0.1');
    assert.match(url.pathname, /^\/session\/[A-Za-z0-9_-]{32}\/$/);

    const htmlResponse = await fetch(handle.url);
    assert.equal(htmlResponse.status, 200);
    const html = await htmlResponse.text();
    assert.match(htmlResponse.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(html, /Review what will be shared/);
    assert.match(html, /Copy for AI agent/);
    assert.doesNotMatch(html, /Copy for (Claude|Codex|Cursor)/);
    assert.doesNotMatch(html, /[—–]/);
    const configMatch = html.match(/window\.__NEURCODE_SHARE_COMPOSER__=(\{[^;]+\});/);
    assert.ok(configMatch);
    const config = JSON.parse(configMatch[1]) as { basePath: string; csrfToken: string };
    const origin = url.origin;

    const bootstrapResponse = await fetch(`${origin}${config.basePath}/api/bootstrap`);
    const bootstrap = await bootstrapResponse.json() as any;
    assert.ok(bootstrap.repository.currentChanges.includes('src/current.ts'));
    assert.ok(bootstrap.repository.stagedChanges.includes('src/staged.ts'));
    assert.ok(bootstrap.repository.recentCommits.length >= 1);
    assert.equal(bootstrap.draft.localItems.length, 0);

    const draftFile = join(root, '.git', 'neurcode-share', 'drafts', `${handle.draftId}.json`);
    assert.equal(statSync(draftFile).mode & 0o777, 0o600);

    const rejectedMutation = await fetch(`${origin}${config.basePath}/api/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: bootstrap.draft }),
    });
    assert.equal(rejectedMutation.status, 403);

    const draft = {
      ...bootstrap.draft,
      title: 'Review a pasted sample',
      intent: 'Check this browser-only input.',
      localItems: [{
        path: 'pasted/sample.ts',
        content: `export const key = "AKIA${'A1'.repeat(8)}";\n`,
        source: 'pasted',
      }],
      order: ['local:pasted/sample.ts'],
    };
    const savedResponse = await fetch(`${origin}${config.basePath}/api/draft`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-neurcode-share-csrf': config.csrfToken,
      },
      body: JSON.stringify({ draft }),
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json() as any;
    assert.equal(saved.localItems[0].source, 'pasted');

    const reviewResponse = await fetch(`${origin}${config.basePath}/api/review`, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-neurcode-share-csrf': config.csrfToken,
      },
      body: JSON.stringify({ version: saved.version }),
    });
    assert.equal(reviewResponse.status, 200);
    const review = await reviewResponse.json() as any;
    assert.equal(review.digest, null);
    assert.ok(review.findings.length >= 1);
    assert.equal(review.previewHtml, null);
    assert.equal(review.previewMarkdown, null);
    assert.equal(review.items[0].provenance, 'pasted');

    const traversal = await fetch(`${origin}${config.basePath}/api/file?path=../outside`);
    assert.equal(traversal.status, 400);
  } finally {
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('zero-argument Composer boots from Git and removal also narrows the proposed diff', async () => {
  const root = fixture();
  const handle = await launchShareComposer({
    cwd: root,
    toolVersion: 'test',
    apiUrl: 'http://127.0.0.1:9',
    preset: 'working-set',
    openBrowser: false,
    idleTimeoutMs: 60_000,
  });
  try {
    const url = new URL(handle.url);
    const html = await (await fetch(handle.url)).text();
    const configMatch = html.match(/window\.__NEURCODE_SHARE_COMPOSER__=(\{[^;]+\});/);
    assert.ok(configMatch);
    const config = JSON.parse(configMatch[1]) as { basePath: string; csrfToken: string };
    const bootstrap = await (await fetch(`${url.origin}${config.basePath}/api/bootstrap`)).json() as any;

    assert.equal(bootstrap.draft.captureMode, 'zero-argument');
    assert.equal(bootstrap.draft.title, `Cut from ${bootstrap.repository.repository.name}`);
    assert.deepEqual(bootstrap.draft.selections, ['src/current.ts', 'src/staged.ts']);
    assert.deepEqual(bootstrap.draft.workingSet.diffPaths, ['src/current.ts', 'src/staged.ts']);
    assert.equal(bootstrap.draft.workingSet.initialItemCount, 3);

    const update = {
      ...bootstrap.draft,
      intent: 'Please review only the staged change.',
      selections: ['src/staged.ts'],
      order: ['selection:src/staged.ts', 'diff'],
    };
    const savedResponse = await fetch(`${url.origin}${config.basePath}/api/draft`, {
      method: 'POST',
      headers: {
        origin: url.origin,
        'content-type': 'application/json',
        'x-neurcode-share-csrf': config.csrfToken,
      },
      body: JSON.stringify({ draft: update }),
    });
    assert.equal(savedResponse.status, 200);
    const saved = await savedResponse.json() as any;
    assert.deepEqual(saved.workingSet.diffPaths, ['src/staged.ts']);
    assert.equal(saved.workingSet.removedItemCount, 1);

    const reviewResponse = await fetch(`${url.origin}${config.basePath}/api/review`, {
      method: 'POST',
      headers: {
        origin: url.origin,
        'content-type': 'application/json',
        'x-neurcode-share-csrf': config.csrfToken,
      },
      body: JSON.stringify({ version: saved.version }),
    });
    assert.equal(reviewResponse.status, 200);
    const review = await reviewResponse.json() as any;
    assert.match(review.previewMarkdown, /src\/staged\.ts/);
    assert.doesNotMatch(review.previewMarkdown, /src\/current\.ts/);
  } finally {
    // Closing before Publish is a local cancellation. The deliberately invalid
    // API endpoint would make any accidental hosted request fail this test.
    await handle.close();
    rmSync(root, { recursive: true, force: true });
  }
});
