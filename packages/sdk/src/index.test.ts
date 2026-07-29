import assert from 'node:assert/strict';
import test from 'node:test';
import { ShareClient } from './index';

test('places capability material only in headers', async () => {
  let captured: { url: string; headers: Headers } | undefined;
  const client = new ShareClient({
    apiUrl: 'https://example.invalid',
    fetch: async (input, init) => {
      captured = { url: String(input), headers: new Headers(init?.headers) };
      return new Response('{}', { status: 200 });
    },
  });
  await client.fetch(`shr_${'1234567890'.repeat(2)}`, 'json', { capability: 'secret-capability' });
  assert.equal(captured?.url.includes('secret-capability'), false);
  assert.equal(captured?.headers.get('x-share-capability'), 'secret-capability');
});
