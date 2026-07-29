import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  readShareArchive,
  writeShareArchive,
  type ShareBundle,
} from '@neurcode-ai/share-format';
import { DEFAULT_API_URL } from '../config';

function apiError(status: number, payload: any): Error {
  return new Error(payload?.message || `Hosted Share request failed (${status}).`);
}

async function jsonFetch(url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  let body: any = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) throw apiError(response.status, body);
  return body;
}

export function expiryHours(value: string | undefined): number {
  if (!value) return 168;
  const match = value.trim().toLowerCase().match(/^(\d+)(h|d)?$/);
  if (!match) throw new Error('--expire must be hours or a duration such as 24h or 7d.');
  const hours = Number(match[1]) * (match[2] === 'd' ? 24 : 1);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    throw new Error('--expire must be from 1 hour through 30 days.');
  }
  return hours;
}

async function browserPublishToken(apiUrl: string, shareOrigin: string): Promise<string> {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  let expectedHost = '';
  let complete!: (value: string) => void;
  let fail!: (error: Error) => void;
  const tokenPromise = new Promise<string>((resolvePromise, rejectPromise) => {
    complete = resolvePromise;
    fail = rejectPromise;
  });
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.host !== expectedHost || request.method !== 'GET') throw new Error('Invalid loopback callback.');
      const url = new URL(request.url || '/', `http://${expectedHost}`);
      if (url.pathname !== '/share/auth/callback') throw new Error('Invalid loopback callback path.');
      if (url.searchParams.get('state') !== state) throw new Error('Publishing state did not match.');
      const sessionId = url.searchParams.get('session') || '';
      const code = url.searchParams.get('code') || '';
      const exchanged = await jsonFetch(`${apiUrl}/api/v1/share/publish-auth/exchange`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, code, verifier }),
      });
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
        'cache-control': 'no-store',
      });
      response.end('Publishing authorized. Return to the Neurcode terminal.');
      complete(exchanged.publishToken);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Publishing authorization failed.');
      fail(error instanceof Error ? error : new Error('Publishing authorization failed.'));
    } finally {
      setImmediate(() => server.close());
    }
  });
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start secure loopback authentication.');
  expectedHost = `127.0.0.1:${address.port}`;
  const callbackUrl = `http://${expectedHost}/share/auth/callback`;
  const initialized = await jsonFetch(`${apiUrl}/api/v1/share/publish-auth/init`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      stateHash: createHash('sha256').update(state).digest('hex'),
      pkceChallenge: createHash('sha256').update(verifier).digest('base64url'),
      callbackUrl,
    }),
  });
  const authorization = new URL(
    initialized.authorizationUrl
      || `${shareOrigin}/authorize-publish?session=${encodeURIComponent(initialized.sessionId)}`,
  );
  authorization.searchParams.set('state', state);
  process.stdout.write(`Sign in to publish:\n${authorization.toString()}\n`);
  try {
    const open = (await import('open')).default;
    await open(authorization.toString());
  } catch {
    // The printed URL is the safe fallback for headless environments.
  }
  const timeout = setTimeout(() => {
    server.close();
    fail(new Error('Publishing authorization expired. The local Share was preserved.'));
  }, 10 * 60 * 1000);
  timeout.unref();
  try {
    return await tokenPromise;
  } finally {
    clearTimeout(timeout);
    if (server.listening) server.close();
  }
}

export async function publishHostedShare(input: {
  bundle: ShareBundle;
  apiUrl?: string;
  shareOrigin?: string;
  visibility: 'unlisted' | 'restricted' | 'public';
  recipients: string[];
  expiryHours: number;
}): Promise<{ url: string; share: Record<string, unknown> }> {
  const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const shareOrigin = (input.shareOrigin || process.env.NEURCODE_SHARE_WEB_URL || 'https://share.neurcode.com').replace(/\/+$/, '');
  const publishToken = await browserPublishToken(apiUrl, shareOrigin);
  const archive = writeShareArchive(input.bundle);
  const digest = input.bundle.cut.manifest.digest;
  const upload = await jsonFetch(`${apiUrl}/api/v1/share/uploads`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${publishToken}`,
      'content-type': 'application/json',
      'idempotency-key': createHash('sha256').update(`cli-upload\0${digest}`).digest('hex'),
    },
    body: JSON.stringify({ archiveBase64: archive.toString('base64') }),
  });
  const finalized = await jsonFetch(`${apiUrl}/api/v1/share/uploads/${encodeURIComponent(upload.uploadId)}/finalize`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${publishToken}`,
      'content-type': 'application/json',
      'idempotency-key': createHash('sha256').update(`cli-finalize\0${upload.uploadId}\0${digest}`).digest('hex'),
    },
    body: JSON.stringify({
      visibility: input.visibility,
      recipients: input.recipients,
      expiryHours: input.expiryHours,
    }),
  });
  return finalized;
}

export async function fetchHostedShare(input: {
  url: string;
  apiUrl?: string;
  out?: string;
  stdout?: string;
}): Promise<void> {
  const link = new URL(input.url);
  const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const fragment = new URLSearchParams(link.hash.replace(/^#/, ''));
  const agent = link.pathname.match(/^\/agent\/(shr_[A-Za-z0-9_-]+)\/([0-9a-f-]{36})$/i);
  const normal = link.pathname.match(/^\/s\/(shr_[A-Za-z0-9_-]+)$/i);
  const shareId = agent?.[1] || normal?.[1];
  if (!shareId) throw new Error('Share fetch URL is not recognized.');
  const requested = (fragment.get('format') || input.stdout || (input.out?.endsWith('.tar.gz') ? 'archive' : 'json')).toLowerCase();
  const format = requested === 'md' ? 'markdown' : requested;
  if (!['markdown', 'json', 'archive'].includes(format)) throw new Error('Fetch format must be markdown, json, or archive.');
  const headers: Record<string, string> = { 'x-neurcode-share-consumer': 'agent' };
  const capability = fragment.get('cap');
  if (capability) headers['x-share-capability'] = capability;
  if (agent) {
    const secret = fragment.get('token');
    if (!secret) throw new Error('Scoped agent link is missing its fragment token.');
    headers['x-share-agent-link'] = agent[2];
    headers['x-share-agent-secret'] = secret;
  }
  const response = await fetch(`${apiUrl}/api/v1/shares/${encodeURIComponent(shareId)}/${format}`, {
    headers,
  });
  if (!response.ok) {
    let payload: any = null;
    try { payload = await response.json(); } catch {}
    throw apiError(response.status, payload);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (format === 'archive') {
    readShareArchive(bytes);
  }
  if (input.out) {
    const target = resolve(input.out);
    writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
    process.stdout.write(`Verified Share fetched · ${target}\n`);
  } else {
    process.stdout.write(bytes);
  }
}
