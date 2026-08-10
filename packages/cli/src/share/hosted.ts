import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SHARE_LIMITS,
  readShareArchive,
  writeShareArchive,
  type ShareBundle,
} from '@neurcode-ai/share-format';
import { DEFAULT_API_URL } from '../config';

function apiError(status: number, payload: any): Error {
  return new Error(payload?.message || `Hosted Cut request failed (${status}).`);
}

export type HostedCliFailureReason =
  | 'authentication' | 'network' | 'authority' | 'format' | 'repository'
  | 'preimage' | 'path' | 'bounds' | 'noninteractive' | 'concurrency' | 'unknown';

export type HostedCliProductEvent =
  | 'try_started' | 'try_succeeded' | 'try_rejected_by_reason_class'
  | 'apply_started' | 'apply_confirmed' | 'apply_rejected_by_reason_class';

export type HostedAuthorizationPurpose =
  | 'publish' | 'verify' | 'comments' | 'receipt' | 'teams' | 'inbox';

export function hostedAuthorizationUrl(
  source: string,
  state: string,
  purpose: HostedAuthorizationPurpose,
): URL {
  const authorization = new URL(source);
  authorization.searchParams.set('state', state);
  authorization.searchParams.set('purpose', purpose);
  return authorization;
}

/** Strict source-free CLI telemetry: callers cannot attach content or identifiers. */
export async function recordHostedCliProductEvent(input: {
  eventType: HostedCliProductEvent;
  elapsedMs?: number;
  failureStage?: HostedCliFailureReason;
  apiUrl?: string;
}): Promise<void> {
  try {
    const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
    const elapsedMs = input.elapsedMs === undefined
      ? undefined
      : Math.min(86_400_000, Math.max(0, Math.round(input.elapsedMs)));
    await fetch(`${apiUrl}/api/v1/share/product-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventType: input.eventType,
        ...(elapsedMs === undefined ? {} : { elapsedMs }),
        ...(input.failureStage === undefined ? {} : { failureStage: input.failureStage }),
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // Aggregate telemetry is best-effort and never changes Cut behavior.
  }
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

export function hostedTeamSlug(value: unknown): string {
  const slug = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!slug || !/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/.test(slug)) {
    throw new Error('--to requires a team slug shown by `neurcode-cut teams`.');
  }
  return slug;
}

export interface HostedShareLink {
  shareId: string;
  revisionNumber?: number;
  agentLinkId?: string;
  capability?: string;
  agentSecret?: string;
}

export interface HostedReplyTarget {
  shareId: string;
  capability?: string;
}

export function parseHostedReplyTarget(value: string): HostedReplyTarget {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (/^shr_[A-Za-z0-9_-]{20,26}$/.test(trimmed)) return { shareId: trimmed };
  const parsed = parseHostedShareLink(trimmed);
  if (parsed.agentLinkId || parsed.agentSecret || parsed.revisionNumber) {
    throw new Error('--reply-to accepts a canonical hosted Cut URL or ID, not an agent link or historical revision.');
  }
  return { shareId: parsed.shareId, capability: parsed.capability };
}

export function parseHostedShareLink(value: string): HostedShareLink {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16_384) {
    throw new Error('Hosted Cut URL is not a bounded string.');
  }
  const link = new URL(value);
  const localHttp = link.protocol === 'http:'
    && (link.hostname === '127.0.0.1' || link.hostname === 'localhost');
  if ((link.protocol !== 'https:' && !localHttp) || link.username || link.password) {
    throw new Error('Hosted Cut URLs must use HTTPS.');
  }
  const fragment = new URLSearchParams(link.hash.replace(/^#/, ''));
  const agent = link.pathname.match(/^\/agent\/(shr_[A-Za-z0-9_-]{20,26})\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  const normal = link.pathname.match(/^\/(?:c|s)\/(shr_[A-Za-z0-9_-]{20,26})$/i);
  const shareId = agent?.[1] || normal?.[1];
  if (!shareId) throw new Error('Hosted Cut URL is not recognized.');
  const revisionRaw = link.searchParams.get('revision');
  const revisionNumber = revisionRaw === null ? undefined : Number(revisionRaw);
  if (
    revisionRaw !== null
    && (!/^[1-9]\d*$/.test(revisionRaw) || !Number.isSafeInteger(revisionNumber) || revisionNumber! > 100_000)
  ) {
    throw new Error('Hosted Cut revision must be a positive bounded integer.');
  }
  const capability = fragment.get('cap') ?? undefined;
  const agentSecret = fragment.get('token') ?? undefined;
  if (agent && !agentSecret) throw new Error('Scoped agent link is missing its fragment token.');
  return {
    shareId,
    revisionNumber,
    agentLinkId: agent?.[2],
    capability,
    agentSecret,
  };
}

export function hostedAccessHeaders(link: HostedShareLink): Record<string, string> {
  const headers: Record<string, string> = { 'x-neurcode-share-consumer': 'agent' };
  if (link.capability) headers['x-share-capability'] = link.capability;
  if (link.agentLinkId) headers['x-share-agent-link'] = link.agentLinkId;
  if (link.agentSecret) headers['x-share-agent-secret'] = link.agentSecret;
  return headers;
}

async function boundedResponseBytes(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new Error('Hosted Cut response exceeds the bounded size limit.');
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body as any) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > limit) throw new Error('Hosted Cut response exceeds the bounded size limit.');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function browserCliToken(
  apiUrl: string,
  shareOrigin: string,
  purpose: HostedAuthorizationPurpose = 'publish',
): Promise<string> {
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
      response.end('Cut by Neurcode CLI authorized. Return to the terminal.');
      complete(exchanged.publishToken);
    } catch (error) {
      response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      response.end('Cut by Neurcode CLI authorization failed.');
      fail(error instanceof Error ? error : new Error('Cut by Neurcode CLI authorization failed.'));
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
      purpose,
    }),
  });
  const authorization = hostedAuthorizationUrl(
    initialized.authorizationUrl
      || `${shareOrigin}/authorize-publish?session=${encodeURIComponent(initialized.sessionId)}`,
    state,
    purpose,
  );
  process.stdout.write(`Sign in to authorize Cut ${purpose}:\n${authorization.toString()}\n`);
  try {
    const open = (await import('open')).default;
    await open(authorization.toString());
  } catch {
    // The printed URL is the safe fallback for headless environments.
  }
  const timeout = setTimeout(() => {
    server.close();
    fail(new Error('Cut CLI authorization expired. Local files were preserved.'));
  }, 10 * 60 * 1000);
  timeout.unref();
  try {
    return await tokenPromise;
  } finally {
    clearTimeout(timeout);
    if (server.listening) server.close();
  }
}

export async function fetchHostedArchive(input: {
  url: string;
  apiUrl?: string;
  bearerToken?: string;
}): Promise<{ bundle: ShareBundle; archive: Buffer; link: HostedShareLink }> {
  const link = parseHostedShareLink(input.url);
  const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const headers = hostedAccessHeaders(link);
  if (input.bearerToken) headers.authorization = `Bearer ${input.bearerToken}`;
  const endpoint = input.bearerToken
    ? `${apiUrl}/api/v1/share/cli/shares/${encodeURIComponent(link.shareId)}/archive`
    : `${apiUrl}/api/v1/shares/${encodeURIComponent(link.shareId)}/archive`;
  const revision = link.revisionNumber ? `?revision=${link.revisionNumber}` : '';
  const response = await fetch(`${endpoint}${revision}`, { headers, cache: 'no-store' });
  if (!response.ok) {
    let payload: any = null;
    try { payload = await response.json(); } catch {}
    throw apiError(response.status, payload);
  }
  const archive = await boundedResponseBytes(response, SHARE_LIMITS.compressedPackBytes);
  const bundle = readShareArchive(archive);
  return { archive, bundle, link };
}

export async function fetchHostedComments(input: {
  url: string;
  bearerToken: string;
  apiUrl?: string;
}): Promise<{ shareId: string; comments: Array<Record<string, unknown>> }> {
  const link = parseHostedShareLink(input.url);
  if (link.revisionNumber) {
    throw new Error('Comments are currently available only for the current Cut revision.');
  }
  const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const response = await fetch(
    `${apiUrl}/api/v1/share/cli/shares/${encodeURIComponent(link.shareId)}/comments`,
    {
      headers: {
        ...hostedAccessHeaders(link),
        authorization: `Bearer ${input.bearerToken}`,
      },
      cache: 'no-store',
    },
  );
  let payload: any = null;
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw apiError(response.status, payload);
  return {
    shareId: link.shareId,
    comments: Array.isArray(payload?.items) ? payload.items : [],
  };
}

export interface HostedInboxItem {
  id: string;
  title: string;
  url: string;
  relationship: 'created' | 'received' | 'team';
  state: 'waiting' | 'answered';
  author: 'You' | 'Cut creator';
  team: { name: string; slug: string } | null;
  createdAt: string;
  latestActivityAt: string;
  feedback: { comments: number; replies: number };
}

export interface HostedInboxPage {
  schemaVersion: 1;
  items: HostedInboxItem[];
  nextCursor: string | null;
  limit: number;
  status: 'all' | 'waiting' | 'answered';
  team: { name: string; slug: string } | null;
}

function inboxString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new Error(`Hosted Cut inbox returned an invalid ${label}.`);
  }
  return value;
}

function inboxCount(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000) {
    throw new Error(`Hosted Cut inbox returned an invalid ${label}.`);
  }
  return Number(value);
}

function inboxDate(value: unknown, label: string): string {
  const result = inboxString(value, label, 64);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(result) || Number.isNaN(Date.parse(result))) {
    throw new Error(`Hosted Cut inbox returned an invalid ${label}.`);
  }
  return result;
}

function inboxTeam(value: unknown): HostedInboxPage['team'] {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Hosted Cut inbox returned an invalid team.');
  }
  const record = value as Record<string, unknown>;
  return {
    name: inboxString(record.name, 'team name', 180),
    slug: hostedTeamSlug(record.slug),
  };
}

export function normalizeHostedInbox(value: unknown): HostedInboxPage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Hosted Cut inbox response was invalid.');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.items) || record.items.length > 100) {
    throw new Error('Hosted Cut inbox response was invalid.');
  }
  const status = record.status;
  if (status !== 'all' && status !== 'waiting' && status !== 'answered') {
    throw new Error('Hosted Cut inbox returned an invalid status.');
  }
  const limit = inboxCount(record.limit, 'limit');
  if (limit < 1 || limit > 100 || record.items.length > limit) {
    throw new Error('Hosted Cut inbox returned an invalid limit.');
  }
  const nextCursor = record.nextCursor === null
    ? null
    : inboxString(record.nextCursor, 'cursor', 512);
  if (nextCursor !== null && !/^[A-Za-z0-9_-]+$/.test(nextCursor)) {
    throw new Error('Hosted Cut inbox returned an invalid cursor.');
  }
  const items = record.items.map((raw): HostedInboxItem => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Hosted Cut inbox returned an invalid item.');
    }
    const item = raw as Record<string, unknown>;
    const id = inboxString(item.id, 'Cut ID', 32);
    if (!/^shr_[A-Za-z0-9_-]{20,26}$/.test(id)) {
      throw new Error('Hosted Cut inbox returned an invalid Cut ID.');
    }
    if (item.relationship !== 'created' && item.relationship !== 'received' && item.relationship !== 'team') {
      throw new Error('Hosted Cut inbox returned an invalid relationship.');
    }
    if (item.state !== 'waiting' && item.state !== 'answered') {
      throw new Error('Hosted Cut inbox returned an invalid item state.');
    }
    if (item.author !== 'You' && item.author !== 'Cut creator') {
      throw new Error('Hosted Cut inbox returned an invalid author.');
    }
    const url = inboxString(item.url, 'browser URL', 2_048);
    const parsedUrl = new URL(url);
    const localHttp = parsedUrl.protocol === 'http:'
      && (parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost');
    if (
      (parsedUrl.protocol !== 'https:' && !localHttp)
      || parsedUrl.username
      || parsedUrl.password
      || parsedUrl.search
      || parsedUrl.hash
      || parsedUrl.pathname !== `/c/${id}`
    ) throw new Error('Hosted Cut inbox returned an unsafe browser URL.');
    const feedback = item.feedback;
    if (!feedback || typeof feedback !== 'object' || Array.isArray(feedback)) {
      throw new Error('Hosted Cut inbox returned invalid feedback counts.');
    }
    return {
      id,
      title: inboxString(item.title, 'title', 180),
      url,
      relationship: item.relationship,
      state: item.state,
      author: item.author,
      team: inboxTeam(item.team),
      createdAt: inboxDate(item.createdAt, 'creation time'),
      latestActivityAt: inboxDate(item.latestActivityAt, 'activity time'),
      feedback: {
        comments: inboxCount((feedback as Record<string, unknown>).comments, 'comment count'),
        replies: inboxCount((feedback as Record<string, unknown>).replies, 'reply count'),
      },
    };
  });
  return {
    schemaVersion: 1,
    items,
    nextCursor,
    limit,
    status,
    team: inboxTeam(record.team),
  };
}

export async function fetchHostedInbox(input: {
  bearerToken: string;
  apiUrl?: string;
  status?: 'waiting' | 'answered';
  team?: string;
  limit?: number;
  cursor?: string;
}): Promise<HostedInboxPage> {
  const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (input.status) params.set('status', input.status);
  if (input.team) params.set('team', hostedTeamSlug(input.team));
  if (input.limit !== undefined) {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new Error('Cut inbox limit must be an integer from 1 through 100.');
    }
    params.set('limit', String(input.limit));
  }
  if (input.cursor) {
    if (input.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) {
      throw new Error('--cursor is not a bounded Cut inbox cursor.');
    }
    params.set('cursor', input.cursor);
  }
  const response = await fetch(`${apiUrl}/api/v1/share/inbox?${params.toString()}`, {
    headers: { authorization: `Bearer ${input.bearerToken}` },
    cache: 'no-store',
  });
  const bytes = await boundedResponseBytes(response, 512 * 1024);
  let payload: unknown;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch {
    throw new Error('Hosted Cut inbox returned invalid JSON.');
  }
  if (!response.ok) throw apiError(response.status, payload);
  return normalizeHostedInbox(payload);
}

export async function submitHostedVerificationReceipt(input: {
  url: string;
  bearerToken: string;
  receipt: Record<string, unknown>;
  apiUrl?: string;
}): Promise<Record<string, unknown>> {
  const link = parseHostedShareLink(input.url);
  if (link.revisionNumber) {
    throw new Error('Verification receipts may be submitted only for the current Cut revision.');
  }
  const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  return jsonFetch(
    `${apiUrl}/api/v1/share/cli/shares/${encodeURIComponent(link.shareId)}/verification-receipts`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.bearerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(input.receipt),
    },
  );
}

export async function publishHostedShare(input: {
  bundle: ShareBundle;
  apiUrl?: string;
  shareOrigin?: string;
  visibility: 'unlisted' | 'restricted' | 'public';
  recipients: string[];
  expiryHours: number;
  replyTo?: HostedReplyTarget;
  teamSlug?: string;
}): Promise<{ url: string; share: Record<string, unknown> }> {
  const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const shareOrigin = (input.shareOrigin || process.env.NEURCODE_SHARE_WEB_URL || 'https://cut.neurcode.com').replace(/\/+$/, '');
  const publishToken = await browserCliToken(apiUrl, shareOrigin, 'publish');
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
      'idempotency-key': createHash('sha256').update(`cli-finalize\0${upload.uploadId}\0${digest}\0${input.replyTo?.shareId ?? ''}\0${input.teamSlug ?? ''}`).digest('hex'),
      ...(input.replyTo?.capability ? { 'x-share-capability': input.replyTo.capability } : {}),
    },
    body: JSON.stringify({
      visibility: input.visibility,
      recipients: input.recipients,
      expiryHours: input.expiryHours,
      ...(input.replyTo ? { replyToShareId: input.replyTo.shareId } : {}),
      ...(input.teamSlug ? { teamSlug: input.teamSlug } : {}),
    }),
  });
  return finalized;
}

export async function listHostedTeams(input: {
  apiUrl?: string;
  shareOrigin?: string;
} = {}): Promise<Array<{ id: string; name: string; slug: string; role: 'owner' | 'member' }>> {
  const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const shareOrigin = (input.shareOrigin || process.env.NEURCODE_SHARE_WEB_URL || 'https://cut.neurcode.com').replace(/\/+$/, '');
  const publishToken = await browserCliToken(apiUrl, shareOrigin, 'teams');
  const result = await jsonFetch(`${apiUrl}/api/v1/share/teams`, {
    method: 'GET',
    headers: { authorization: `Bearer ${publishToken}` },
  });
  return Array.isArray(result?.items) ? result.items : [];
}

export async function fetchHostedShare(input: {
  url: string;
  apiUrl?: string;
  out?: string;
  stdout?: string;
}): Promise<void> {
  const linkUrl = new URL(input.url);
  const apiUrl = (input.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const parsedLink = parseHostedShareLink(input.url);
  const fragment = new URLSearchParams(linkUrl.hash.replace(/^#/, ''));
  const agent = parsedLink.agentLinkId;
  const shareId = parsedLink.shareId;
  const requested = (fragment.get('format') || input.stdout || (input.out?.endsWith('.tar.gz') ? 'archive' : 'json')).toLowerCase();
  const format = requested === 'md' ? 'markdown' : requested;
  if (!['markdown', 'json', 'archive'].includes(format)) throw new Error('Fetch format must be markdown, json, or archive.');
  const headers = hostedAccessHeaders(parsedLink);
  if (agent) {
    headers['x-share-agent-link'] = agent;
  }
  const revision = parsedLink.revisionNumber ? `?revision=${parsedLink.revisionNumber}` : '';
  const response = await fetch(`${apiUrl}/api/v1/shares/${encodeURIComponent(shareId)}/${format}${revision}`, {
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
    process.stdout.write(`Verified Cut fetched · ${target}\n`);
  } else {
    process.stdout.write(bytes);
  }
}
