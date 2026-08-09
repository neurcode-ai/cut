import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inboxHuman } from '../living-commands';
import { normalizeHostedInbox, recordHostedCliProductEvent } from './hosted';

function page(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const cutId = `shr_${'a'.repeat(20)}`;
  return {
    schemaVersion: 1,
    items: [{
      id: cutId,
      title: 'Queue fix',
      url: `https://cut.neurcode.com/c/${cutId}`,
      relationship: 'team',
      state: 'waiting',
      author: 'Cut creator',
      team: { name: 'Platform', slug: 'platform' },
      createdAt: '2026-08-10T00:00:00.000Z',
      latestActivityAt: '2026-08-10T00:01:00.000Z',
      feedback: { comments: 2, replies: 0 },
      source: 'must not survive normalization',
      recipientEmail: 'must-not-survive@example.com',
    }],
    nextCursor: 'eyJhdCI6IjIwMjYifQ',
    limit: 25,
    status: 'all',
    team: null,
    ...overrides,
  };
}

test('Cut Inbox normalizes only its documented, source-free schema', () => {
  const normalized = normalizeHostedInbox(page());
  assert.equal(normalized.schemaVersion, 1);
  assert.equal(normalized.items[0].title, 'Queue fix');
  assert.equal('source' in normalized.items[0], false);
  assert.equal('recipientEmail' in normalized.items[0], false);
  assert.deepEqual(normalized.items[0].feedback, { comments: 2, replies: 0 });
});

test('Cut Inbox rejects oversized pages, unsafe URLs, cursors, and counts', () => {
  assert.throws(() => normalizeHostedInbox(page({ items: Array.from({ length: 101 }, () => ({})) })), /invalid/);
  assert.throws(() => normalizeHostedInbox(page({ nextCursor: '../token' })), /cursor/);
  assert.throws(() => normalizeHostedInbox(page({
    items: [{
      ...(page().items as Record<string, unknown>[])[0],
      url: 'https://cut.neurcode.com/c/another?cap=secret',
    }],
  })), /unsafe browser URL/);
  assert.throws(() => normalizeHostedInbox(page({
    items: [{
      ...(page().items as Record<string, unknown>[])[0],
      feedback: { comments: -1, replies: 0 },
    }],
  })), /comment count/);
});

test('human Cut Inbox output escapes terminal controls and exposes pagination', () => {
  const raw = page();
  const item = (raw.items as Record<string, unknown>[])[0];
  item.title = 'Queue\u001b[2J\u202e spoof';
  const rendered = inboxHuman(normalizeHostedInbox(raw));
  assert.doesNotMatch(rendered, /\u001b|\u202e/);
  assert.match(rendered, /Queue\\u001b\[2J\\u202e spoof/);
  assert.match(rendered, /Next page: cut inbox --cursor eyJhdCI6IjIwMjYifQ/);
});

test('empty Cut Inbox output is explicit', () => {
  const rendered = inboxHuman(normalizeHostedInbox(page({ items: [], nextCursor: null })));
  assert.match(rendered, /No authorized Cut conversations match this view/);
});

test('CLI try/apply telemetry has a closed source-free body', async () => {
  const originalFetch = globalThis.fetch;
  let recorded: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    recorded = JSON.parse(String(init?.body));
    return new Response('{}', { status: 202 });
  }) as typeof fetch;
  try {
    await recordHostedCliProductEvent({
      eventType: 'apply_rejected_by_reason_class',
      elapsedMs: 11.6,
      failureStage: 'preimage',
      apiUrl: 'https://api.neurcode.com',
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(recorded, {
    eventType: 'apply_rejected_by_reason_class',
    elapsedMs: 12,
    failureStage: 'preimage',
  });
  assert.doesNotMatch(JSON.stringify(recorded), /source|replacement|diff|title|path|repository|command|token|email/i);
});
