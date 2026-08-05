import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Writable } from 'node:stream';
import {
  finalizeShare,
  renderAgentJson,
  renderHtml,
  renderMarkdown,
  writeShareArchive,
  type SecretFinding,
  type ShareBundle,
  type ShareItem,
} from '@neurcode-ai/share-format';
import { DEFAULT_API_URL } from '../config';
import { captureEvidence } from './evidence';
import { createLocalShare } from './create';
import { composerHtml } from './composer-ui';
import { readComposerFile, readComposerRepository } from './composer-data';
import {
  loadComposerDraft,
  newComposerDraft,
  saveComposerDraft,
  type ComposerDiffMode,
  type ComposerDraft,
} from './composer-draft';

interface ReviewCache {
  version: number;
  bundle: ShareBundle;
  archive: Buffer;
  findings: SecretFinding[];
}

interface PendingPublishAuth {
  sessionId: string;
  verifier: string;
  state: string;
  publishToken?: string;
}

export interface ShareComposerOptions {
  cwd?: string;
  toolVersion: string;
  apiUrl?: string;
  shareOrigin?: string;
  draftId?: string;
  preset?: 'handoff';
  openBrowser?: boolean;
  idleTimeoutMs?: number;
}

export interface ShareComposerHandle {
  url: string;
  draftId: string;
  close(): Promise<void>;
  completed: Promise<void>;
}

class HttpError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  response.end(body);
}

function secureHeaders(response: ServerResponse, nonce?: string): void {
  response.setHeader(
    'content-security-policy',
    nonce
      ? `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      : `default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
  );
  response.setHeader('referrer-policy', 'no-referrer');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  response.setHeader('cache-control', 'no-store, max-age=0');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
}

async function readJsonBody(request: IncomingMessage, maxBytes = 128 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new HttpError('Composer request is too large.', 413);
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError('Composer request body is invalid JSON.');
  }
}

function draftForClient(draft: ComposerDraft): Record<string, unknown> {
  return {
    ...draft,
    evidence: draft.evidence
      ? {
          argv: draft.evidence.argv,
          exit: draft.evidence.exit,
          stdoutText: draft.evidence.stdout.toString('utf8'),
          stderrText: draft.evidence.stderr.toString('utf8'),
          startedAt: draft.evidence.startedAt,
          durationMs: draft.evidence.durationMs,
          cwd: draft.evidence.cwd,
          timedOut: draft.evidence.timedOut,
          stdoutTruncated: draft.evidence.stdoutTruncated,
          stderrTruncated: draft.evidence.stderrTruncated,
        }
      : null,
  };
}

function validateDiff(value: any): ComposerDiffMode {
  if (!value || value.kind === 'none') return { kind: 'none' };
  if (value.kind === 'current') return { kind: 'current' };
  if (value.kind === 'staged') return { kind: 'staged' };
  if (
    value.kind === 'commit'
    && typeof value.range === 'string'
    && /^[A-Fa-f0-9]{40,64}\.\.[A-Fa-f0-9]{40,64}$/.test(value.range)
  ) {
    return { kind: 'commit', range: value.range, label: String(value.label ?? 'Commit changes').slice(0, 240) };
  }
  throw new HttpError('Draft diff selection is invalid.');
}

function validateDraftUpdate(current: ComposerDraft, value: any): ComposerDraft {
  if (!value || Number(value.version) !== current.version) {
    throw new HttpError('This local draft changed in another Composer request. Reload and try again.', 409);
  }
  const selections: string[] = Array.isArray(value.selections)
    ? [...new Set<string>(value.selections.map((selection: unknown) => String(selection)))].slice(0, 500)
    : [];
  for (const selection of selections) {
    if (
      selection.length < 1
      || selection.length > 4_096
      || selection.startsWith('-')
      || selection.includes('\0')
      || /(?:^|\/)\.\.(?:\/|$)/.test(selection)
    ) {
      throw new HttpError('Draft contains an unsafe file selection.');
    }
  }
  const notes: Record<string, string> = {};
  if (value.notes && typeof value.notes === 'object' && !Array.isArray(value.notes)) {
    for (const [key, note] of Object.entries(value.notes)) {
      if (typeof note === 'string' && note.trim() && note.length <= 4_000) notes[key.slice(0, 4_200)] = note.trim();
    }
  }
  const order: string[] = Array.isArray(value.order)
    ? [...new Set<string>(value.order.map((key: unknown) => String(key)))].slice(0, 502)
    : [];
  const localItems: ComposerDraft['localItems'] = Array.isArray(value.localItems)
    ? value.localItems.slice(0, 100).map((item: any, index: number) => {
        const source = item?.source === 'uploaded' ? 'uploaded' : 'pasted';
        const path = String(item?.path ?? '').trim().replace(/\\/g, '/');
        const content = typeof item?.content === 'string' ? item.content : '';
        if (
          !path
          || path.length > 4_096
          || path.startsWith('/')
          || path.includes('\0')
          || path.split('/').some((part) => !part || part === '.' || part === '..')
          || content.length === 0
          || Buffer.byteLength(content) > 2 * 1024 * 1024
        ) {
          throw new HttpError(`Pasted or uploaded item ${index + 1} is invalid.`);
        }
        return {
          path,
          content,
          source,
          language: typeof item?.language === 'string' ? item.language.slice(0, 64) : undefined,
        };
      })
    : [];
  if (new Set(localItems.map((item) => item.path)).size !== localItems.length) {
    throw new HttpError('Pasted and uploaded item paths must be unique.');
  }
  const aggregateLocalBytes = localItems.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0);
  if (aggregateLocalBytes > 12 * 1024 * 1024) throw new HttpError('Pasted and uploaded items exceed 12 MiB.');
  const visibility = safeAccess(value.visibility);
  const recipients = Array.isArray(value.recipients)
    ? [...new Set<string>(value.recipients.map((email: unknown) => String(email).trim().toLowerCase()))].slice(0, 100)
    : [];
  if (recipients.some((email) => email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new HttpError('One or more recipient emails are invalid.');
  }
  if (visibility === 'restricted' && recipients.length === 0) {
    throw new HttpError('Email-restricted access requires at least one recipient.');
  }
  const expiryHours = Number(value.expiryHours ?? 168);
  if (!Number.isInteger(expiryHours) || expiryHours < 1 || expiryHours > 720) {
    throw new HttpError('Expiry must be from 1 through 720 hours.');
  }
  return {
    ...current,
    title: String(value.title ?? '').trim().slice(0, 180),
    intent: String(value.intent ?? '').trim().slice(0, 8_000),
    selections,
    diff: validateDiff(value.diff),
    notes,
    order,
    localItems,
    visibility,
    recipients: visibility === 'restricted' ? recipients : [],
    expiryHours,
    updatedAt: new Date().toISOString(),
    version: current.version + 1,
  };
}

function cliNotes(draft: ComposerDraft): string[] {
  const result: string[] = [];
  for (const [key, note] of Object.entries(draft.notes)) {
    let target: string;
    if (key === 'diff') target = 'diff';
    else if (key === 'evidence') target = 'run';
    else if (key.startsWith('selection:')) {
      target = key.slice('selection:'.length).replace(/:\d+-\d+$/, '');
    } else if (key.startsWith('local:')) {
      target = key.slice('local:'.length);
    } else continue;
    result.push(`${target}=${note}`);
  }
  return result;
}

function diffOptions(diff: ComposerDiffMode): { staged: boolean; diff: boolean | string } {
  if (diff.kind === 'staged') return { staged: true, diff: false };
  if (diff.kind === 'current') return { staged: false, diff: true };
  if (diff.kind === 'commit') return { staged: false, diff: diff.range };
  return { staged: false, diff: false };
}

function itemLabel(item: ShareItem): string {
  if (item.kind === 'file') return item.path;
  if (item.kind === 'excerpt') return `${item.path}:${item.range.start}-${item.range.end}`;
  if (item.kind === 'diff') return `Complete unified diff · ${item.files.length} files · +${item.addedLines} −${item.removedLines}`;
  return `argv: ${item.argv.join(' ')} · stdout ${item.stdout ? 'captured' : 'empty'} · stderr ${item.stderr ? 'captured' : 'empty'}`;
}

function absolutePathWarnings(bundle: ShareBundle): string[] {
  const pattern = /(?:\/(?:Users|home|private\/var|tmp)\/[^\s"'`<>]+|[A-Za-z]:\\[^\s"'`<>]+)/g;
  const warnings = new Set<string>();
  for (const item of bundle.cut.pack.items) {
    const hashes = item.kind === 'file' || item.kind === 'diff'
      ? [item.blob]
      : item.kind === 'excerpt'
        ? [item.blob, ...(item.context ? [item.context.blob] : [])]
        : [item.stdout, item.stderr].filter((value): value is string => Boolean(value));
    for (const hash of hashes) {
      const content = bundle.blobs.get(hash)?.toString('utf8') ?? '';
      for (const match of content.match(pattern) ?? []) warnings.add(`${item.id}: ${match.slice(0, 240)}`);
    }
  }
  return [...warnings].slice(0, 100);
}

function emptyWritable(): Writable {
  return new Writable({ write(_chunk, _encoding, callback) { callback(); } });
}

async function reviewDraft(
  cwd: string,
  draft: ComposerDraft,
  toolVersion: string,
): Promise<ReviewCache> {
  if (!draft.title) throw new HttpError('Add a clear title before review.');
  if (!draft.intent) throw new HttpError('Add the actual question or intent before review.');
  const diff = diffOptions(draft.diff);
  const result = await createLocalShare({
    selections: draft.selections,
    ...diff,
    run: undefined,
    capturedEvidence: draft.evidence ?? undefined,
    runTimeoutSeconds: 60,
    title: draft.title,
    message: draft.intent,
    notes: cliNotes(draft),
    forceInclude: [],
    stripContext: [],
    acknowledgeFindings: [],
    out: undefined,
    preview: false,
    copy: false,
    stdout: undefined,
    dryRun: true,
    yes: false,
    toolVersion,
    cwd,
    itemOrder: draft.order,
    browserItems: draft.localItems,
    reviewOutput: emptyWritable(),
  });
  const state = result.reviewState;
  if (!state) throw new Error('Local disclosure review did not produce a state.');
  state.draft.manifest.security = {
    class: 'asserted',
    acknowledgedFindings: [],
    consent: 'interactive',
  };
  const bundle: ShareBundle = { cut: finalizeShare(state.draft), blobs: state.blobs };
  const archive = writeShareArchive(bundle);
  return { version: draft.version, bundle, archive, findings: state.findings };
}

function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function safeAccess(value: unknown): 'unlisted' | 'restricted' | 'public' {
  return value === 'restricted' || value === 'public' ? value : 'unlisted';
}

export async function launchShareComposer(options: ShareComposerOptions): Promise<ShareComposerHandle> {
  const cwd = options.cwd ?? process.cwd();
  const apiUrl = (options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
  const shareOrigin = (options.shareOrigin || process.env.NEURCODE_SHARE_WEB_URL || 'https://cut.neurcode.com').replace(/\/+$/, '');
  const repository = readComposerRepository(cwd);
  let draft = options.draftId ? loadComposerDraft(cwd, options.draftId) : newComposerDraft(options.preset);
  saveComposerDraft(cwd, draft);
  const sessionToken = randomBytes(24).toString('base64url');
  const csrfToken = randomBytes(24).toString('base64url');
  const basePath = `/session/${sessionToken}`;
  let reviewCache: ReviewCache | null = null;
  let pendingAuth: PendingPublishAuth | null = null;
  let lastActivity = Date.now();
  let expectedOrigin = '';

  let resolveCompleted!: () => void;
  const completed = new Promise<void>((resolve) => { resolveCompleted = resolve; });
  const server = createServer(async (request, response) => {
    try {
      lastActivity = Date.now();
      secureHeaders(response);
      const host = request.headers.host ?? '';
      if (host !== expectedOrigin.replace(/^http:\/\//, '')) throw new HttpError('Invalid loopback Host header.', 403);
      const requestUrl = new URL(request.url ?? '/', expectedOrigin);
      const isCallback = requestUrl.pathname === '/share/auth/callback';
      if (!isCallback && !requestUrl.pathname.startsWith(basePath)) throw new HttpError('Composer session was not found.', 404);
      if (request.method !== 'GET') {
        if (request.headers.origin !== expectedOrigin) throw new HttpError('Invalid loopback Origin header.', 403);
        if (request.headers['x-neurcode-share-csrf'] !== csrfToken) throw new HttpError('Composer CSRF check failed.', 403);
      }

      if (isCallback && request.method === 'GET') {
        if (!pendingAuth) throw new HttpError('No Cut publishing authorization is pending.', 409);
        const code = requestUrl.searchParams.get('code') ?? '';
        const state = requestUrl.searchParams.get('state') ?? '';
        const sessionId = requestUrl.searchParams.get('session') ?? '';
        if (state !== pendingAuth.state || sessionId !== pendingAuth.sessionId || !code) {
          throw new HttpError('Publishing authorization callback did not match this Composer.', 403);
        }
        const exchange = await fetch(`${apiUrl}/api/v1/share/publish-auth/exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            sessionId,
            code,
            verifier: pendingAuth.verifier,
          }),
        });
        if (!exchange.ok) throw new HttpError('Secure publishing authorization could not be exchanged.', 502);
        const payload = await exchange.json() as { publishToken: string };
        pendingAuth.publishToken = payload.publishToken;
        const body = `<!doctype html><meta charset="utf-8"><title>Cut by Neurcode authorized</title><body><h1>Publishing authorized</h1><p>Return to the local Cut Composer. You can close this window.</p></body>`;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        response.end(body);
        return;
      }

      const relative = requestUrl.pathname.slice(basePath.length);
      if ((relative === '' || relative === '/') && request.method === 'GET') {
        const nonce = randomBytes(18).toString('base64url');
        secureHeaders(response, nonce);
        const body = composerHtml({ nonce, basePath, csrfToken });
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        response.end(body);
        return;
      }
      if (relative === '/api/bootstrap' && request.method === 'GET') {
        json(response, 200, { repository, draft: draftForClient(draft) });
        return;
      }
      if (relative === '/api/file' && request.method === 'GET') {
        try {
          json(response, 200, readComposerFile(cwd, requestUrl.searchParams.get('path') ?? ''));
        } catch (error) {
          throw new HttpError(
            error instanceof Error ? error.message : 'The requested repository file is unavailable.',
            400,
          );
        }
        return;
      }
      if (relative === '/api/draft' && request.method === 'POST') {
        const body = await readJsonBody(request);
        draft = validateDraftUpdate(draft, body.draft);
        saveComposerDraft(cwd, draft);
        reviewCache = null;
        json(response, 200, draftForClient(draft));
        return;
      }
      if (relative === '/api/evidence' && request.method === 'POST') {
        const body = await readJsonBody(request);
        if (Number(body.version) !== draft.version) throw new HttpError('Draft changed before command execution.', 409);
        const command = typeof body.command === 'string' ? body.command.trim() : '';
        const timeoutSeconds = Number(body.timeoutSeconds);
        if (!command || command.length > 4_096) throw new HttpError('Command must be 1 to 4,096 characters.');
        if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
          throw new HttpError('Command timeout must be from 1 through 600 seconds.');
        }
        draft.evidence = await captureEvidence({
          command,
          repoRoot: repository.repository.root,
          timeoutMs: Math.floor(timeoutSeconds * 1_000),
          stream: false,
        });
        draft.order = [...draft.order.filter((key) => key !== 'evidence'), 'evidence'];
        draft.updatedAt = new Date().toISOString();
        draft.version += 1;
        saveComposerDraft(cwd, draft);
        reviewCache = null;
        json(response, 200, draftForClient(draft));
        return;
      }
      if (relative === '/api/review' && request.method === 'POST') {
        const body = await readJsonBody(request);
        if (Number(body.version) !== draft.version) throw new HttpError('Draft changed before review.', 409);
        reviewCache = await reviewDraft(cwd, draft, options.toolVersion);
        const bundle = reviewCache.bundle;
        const warnings = absolutePathWarnings(bundle);
        json(response, 200, {
          version: reviewCache.version,
          digest: reviewCache.findings.length ? null : bundle.cut.manifest.digest,
          findings: reviewCache.findings,
          items: bundle.cut.pack.items.map((item) => ({
            id: item.id,
            kind: item.kind,
            provenance: item.provenance,
            bytes: item.bytes,
            label: itemLabel(item),
          })),
          origin: bundle.cut.manifest.origin.remote,
          commit: bundle.cut.manifest.origin.head,
          branch: bundle.cut.manifest.origin.branch,
          aggregateBytes: [...bundle.blobs.values()].reduce((sum, content) => sum + content.length, 0),
          absolutePathWarnings: warnings,
          access: draft.visibility,
          expiryHours: draft.expiryHours,
          recipients: draft.recipients,
          previewHtml: reviewCache.findings.length ? null : renderHtml(bundle),
          previewMarkdown: reviewCache.findings.length ? null : renderMarkdown(bundle),
        });
        return;
      }
      if (relative === '/api/export' && request.method === 'POST') {
        const body = await readJsonBody(request);
        if (!reviewCache || Number(body.version) !== reviewCache.version || body.confirmed !== true) {
          throw new HttpError('Complete the current disclosure review before export.', 409);
        }
        if (reviewCache.findings.length) throw new HttpError('Exact security findings block export.', 422);
        const format = body.format;
        let bytes: Buffer;
        let type: string;
        let filename: string;
        if (format === 'archive') {
          bytes = reviewCache.archive; type = 'application/gzip'; filename = 'neurcode-cut.tar.gz';
        } else if (format === 'json') {
          bytes = Buffer.from(renderAgentJson(reviewCache.bundle)); type = 'application/json; charset=utf-8'; filename = 'neurcode-cut.json';
        } else if (format === 'markdown') {
          bytes = Buffer.from(renderMarkdown(reviewCache.bundle)); type = 'text/markdown; charset=utf-8'; filename = 'neurcode-cut.md';
        } else throw new HttpError('Export format is not supported.');
        response.writeHead(200, {
          'content-type': type,
          'content-length': bytes.length,
          'content-disposition': `attachment; filename="${filename}"`,
          'cache-control': 'no-store',
        });
        response.end(bytes);
        return;
      }
      if (relative === '/api/publish' && request.method === 'POST') {
        const body = await readJsonBody(request);
        if (!reviewCache || Number(body.version) !== reviewCache.version || body.confirmed !== true) {
          throw new HttpError('Complete the current disclosure review before publishing.', 409);
        }
        if (reviewCache.findings.length) throw new HttpError('Exact security findings block publishing.', 422);
        if (!pendingAuth?.publishToken) {
          const verifier = randomBytes(48).toString('base64url');
          const state = randomBytes(32).toString('base64url');
          const init = await fetch(`${apiUrl}/api/v1/share/publish-auth/init`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              stateHash: createHash('sha256').update(state).digest('hex'),
              pkceChallenge: pkceChallenge(verifier),
              callbackUrl: `${expectedOrigin}/share/auth/callback`,
            }),
          });
          if (!init.ok) throw new HttpError('Secure browser publishing authentication is unavailable.', 502);
          const payload = await init.json() as { sessionId: string; authorizationUrl?: string };
          pendingAuth = { sessionId: payload.sessionId, verifier, state };
          const authorizationUrl = new URL(
            payload.authorizationUrl
              || `${shareOrigin}/login?publish_session=${encodeURIComponent(payload.sessionId)}`,
          );
          authorizationUrl.searchParams.set('state', state);
          json(response, 200, { authorizationUrl: authorizationUrl.toString() });
          return;
        }
        const access = draft.visibility;
        const expiryHours = draft.expiryHours;
        const recipients = draft.recipients;
        const uploadKey = createHash('sha256').update(`upload\0${draft.id}\0${reviewCache.bundle.cut.manifest.digest}`).digest('hex');
        const upload = await fetch(`${apiUrl}/api/v1/share/uploads`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${pendingAuth.publishToken}`,
            'content-type': 'application/json',
            'idempotency-key': uploadKey,
          },
          body: JSON.stringify({ archiveBase64: reviewCache.archive.toString('base64') }),
        });
        if (!upload.ok) throw new HttpError('The hosted server rejected this Cut upload.', upload.status);
        const uploaded = await upload.json() as { uploadId: string };
        const finalizeKey = createHash('sha256').update(`finalize\0${draft.id}\0${uploaded.uploadId}`).digest('hex');
        const finalized = await fetch(`${apiUrl}/api/v1/share/uploads/${encodeURIComponent(uploaded.uploadId)}/finalize`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${pendingAuth.publishToken}`,
            'content-type': 'application/json',
            'idempotency-key': finalizeKey,
          },
          body: JSON.stringify({ visibility: access, expiryHours, recipients }),
        });
        if (!finalized.ok) throw new HttpError('The hosted server could not finalize this Cut.', finalized.status);
        const published = await finalized.json();
        json(response, 200, published);
        return;
      }
      if (relative === '/api/publish-status' && request.method === 'GET') {
        json(response, 200, { authorized: Boolean(pendingAuth?.publishToken) });
        return;
      }
      if (relative === '/api/close' && request.method === 'POST') {
        json(response, 200, { closed: true });
        setImmediate(() => server.close());
        return;
      }
      throw new HttpError('Composer route was not found.', 404);
    } catch (error) {
      const status = error instanceof HttpError ? error.statusCode : 500;
      json(response, status, {
        code: status >= 500 ? 'COMPOSER_INTERNAL_ERROR' : 'COMPOSER_REQUEST_REJECTED',
        message: error instanceof Error ? error.message : 'Composer request failed.',
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback Composer did not receive a TCP port.');
  expectedOrigin = `http://127.0.0.1:${address.port}`;
  const url = `${expectedOrigin}${basePath}/`;
  server.once('close', resolveCompleted);
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity >= (options.idleTimeoutMs ?? 30 * 60 * 1_000)) server.close();
  }, 30_000);
  idleTimer.unref();
  completed.finally(() => clearInterval(idleTimer));

  if (options.openBrowser !== false) {
    try {
      const open = (await import('open')).default;
      await open(url);
    } catch {
      process.stdout.write(`Open the local Cut Composer:\n${url}\n`);
    }
  }
  process.stdout.write(`Cut Composer · ${url}\nLocal draft · ${draft.id}\nNothing uploads until you choose Publish.\n`);
  return {
    url,
    draftId: draft.id,
    close: async () => {
      if (!server.listening) return;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    completed,
  };
}

export async function startShareComposer(options: ShareComposerOptions): Promise<void> {
  const handle = await launchShareComposer(options);
  await handle.completed;
}
