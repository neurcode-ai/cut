import type { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalize } from '@neurcode-ai/share-format';
import { DEFAULT_API_URL } from './config';
import {
  browserCliToken,
  fetchHostedComments,
  fetchHostedInbox,
  recordHostedCliProductEvent,
  submitHostedVerificationReceipt,
  type HostedCliFailureReason,
  type HostedInboxPage,
} from './share/hosted';
import { refreshShare, type RefreshDecision } from './share/refresh';
import { loadShareSource } from './share/source';
import {
  humanVerification,
  normalizedVerificationJson,
  verifyShareBundle,
} from './share/verification';
import {
  applyCutReply,
  createCutTry,
  discardCutTry,
  inspectApplyableReply,
  listCutTries,
  renderApplyableDiff,
  renderCutTries,
} from './share/try-apply';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function writeNewOutput(path: string, bytes: string | Buffer): string {
  const target = resolve(path);
  if (existsSync(target)) throw new Error(`Refusing to overwrite existing output: ${target}`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, bytes, { mode: 0o600, flag: 'wx' });
  return target;
}

function assignments<T>(
  values: string[],
  parse: (value: string) => T,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const equals = value.indexOf('=');
    if (equals < 2) throw new Error(`${label} uses <item>=<value>: ${value}`);
    const item = value.slice(0, equals);
    if (!/^i[1-9]\d*$/.test(item) || result.has(item)) {
      throw new Error(`${label} contains an invalid or duplicate item ID: ${item}`);
    }
    result.set(item, parse(value.slice(equals + 1)));
  }
  return result;
}

function decision(value: string): RefreshDecision {
  if (!['keep', 'use', 'remove', 'abort'].includes(value)) {
    throw new Error(`Refresh decision must be keep, use, remove, or abort: ${value}`);
  }
  return value as RefreshDecision;
}

function shareOrigin(value: string): string {
  return new URL(value).origin;
}

function commentHuman(shareId: string, comments: Array<Record<string, unknown>>): string {
  const lines = [`Comments · ${shareId}`, ''];
  if (comments.length === 0) lines.push('No authorized comments.');
  for (const entry of comments) {
    const path = typeof entry.path === 'string' ? entry.path : String(entry.blockId ?? 'item');
    const lineStart = Number(entry.lineStart);
    const lineEnd = Number(entry.lineEnd);
    const anchored = Number.isInteger(lineStart) && lineStart > 0
      ? `${path}:${lineStart}${Number.isInteger(lineEnd) && lineEnd !== lineStart ? `-${lineEnd}` : ''}`
      : path;
    lines.push(`${anchored} — ${String(entry.body ?? '')}`);
  }
  return `${lines.join('\n')}\n`;
}

function terminalSafe(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );
}

function cliFailureReason(error: unknown): HostedCliFailureReason {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (/tty|interactive|confirmation/.test(message)) return 'noninteractive';
  if (/preimage|drift|changed after|digest/.test(message)) return 'preimage';
  if (/repository|worktree|origin|base commit|head/.test(message)) return 'repository';
  if (/path|symlink|submodule|traversal|case collision/.test(message)) return 'path';
  if (/limit|bounded|too large|exceeds|maximum/.test(message)) return 'bounds';
  if (/authorization|authenticate|sign in|forbidden|not found/.test(message)) return 'authority';
  if (/archive|applyable|metadata|format|utf-8|binary/.test(message)) return 'format';
  if (/concurrent|race|lock/.test(message)) return 'concurrency';
  if (/fetch|network|timed? out|econn|enotfound/.test(message)) return 'network';
  return 'unknown';
}

function elapsedSince(startedAt: number): number {
  return Math.min(86_400_000, Math.max(0, performance.now() - startedAt));
}

export function inboxHuman(page: HostedInboxPage): string {
  const destination = page.team ? `team ${terminalSafe(page.team.slug)}` : 'personal and team';
  const lines = [`Cut Inbox · ${terminalSafe(page.status)} · ${destination}`, ''];
  if (page.items.length === 0) {
    lines.push('No authorized Cut conversations match this view.');
  }
  for (const item of page.items) {
    const team = item.team ? ` · ${terminalSafe(item.team.slug)}` : '';
    lines.push(`${item.state.toUpperCase()} · ${terminalSafe(item.title)}`);
    lines.push(`  ${terminalSafe(item.author)} · ${terminalSafe(item.relationship)}${team} · ${terminalSafe(item.latestActivityAt)}`);
    lines.push(`  ${item.feedback.replies} repl${item.feedback.replies === 1 ? 'y' : 'ies'} · ${item.feedback.comments} comment${item.feedback.comments === 1 ? '' : 's'}`);
    lines.push(`  ${terminalSafe(item.url)}`);
  }
  if (page.nextCursor) {
    lines.push('', `Next page: cut inbox --cursor ${terminalSafe(page.nextCursor)}`);
  }
  return `${lines.join('\n')}\n`;
}

export function livingShareCommands(program: Command, toolVersion: string): void {
  program
    .command('inbox')
    .description('List authorized Cut conversations that are waiting or answered')
    .option('--team <slug>', 'Show one active team destination')
    .option('--status <state>', 'Show waiting or answered Cuts')
    .option('--limit <number>', 'Maximum page size from 1 through 100', '25')
    .option('--cursor <cursor>', 'Continue from a previous bounded page cursor')
    .option('--json', 'Emit the stable Cut Inbox schema as canonical JSON')
    .option('--api-url <url>', 'Override the hosted Cut API URL')
    .action(async (options) => {
      if (options.status !== undefined && options.status !== 'waiting' && options.status !== 'answered') {
        throw new Error('--status must be waiting or answered.');
      }
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        throw new Error('--limit must be an integer from 1 through 100.');
      }
      const apiUrl = (options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
      const shareOriginValue = process.env.NEURCODE_SHARE_WEB_URL || 'https://cut.neurcode.com';
      const token = await browserCliToken(apiUrl, new URL(shareOriginValue).origin, 'inbox');
      const page = await fetchHostedInbox({
        bearerToken: token,
        apiUrl,
        status: options.status,
        team: options.team,
        limit,
        cursor: options.cursor,
      });
      process.stdout.write(options.json ? `${canonicalize(page)}\n` : inboxHuman(page));
    });

  program
    .command('try [share-source]')
    .description('Preview an applyable Cut reply in a retained isolated Git worktree')
    .option('--repo <path>', 'Repository to try against (default: current repository)')
    .option('--list', 'List retained isolated try worktrees')
    .option('--discard <try-id>', 'Discard one retained isolated try worktree')
    .option('--api-url <url>', 'Override the hosted Cut API URL')
    .option('--no-auth', 'Do not open browser authentication for a restricted hosted Cut')
    .action(async (source: string | undefined, options) => {
      if (options.list === true) {
        if (source || options.discard) throw new Error('--list cannot be combined with a Cut source or --discard.');
        process.stdout.write(renderCutTries(listCutTries()));
        return;
      }
      if (options.discard) {
        if (source) throw new Error('--discard cannot be combined with a Cut source.');
        discardCutTry(options.discard);
        process.stdout.write(`Discarded retained Cut try ${options.discard}.\n`);
        return;
      }
      if (!source) throw new Error('cut try requires a hosted Cut URL or local archive.');
      const startedAt = performance.now();
      void recordHostedCliProductEvent({ eventType: 'try_started', apiUrl: options.apiUrl });
      try {
        const loaded = await loadShareSource({
          source,
          apiUrl: options.apiUrl,
          authenticateHosted: options.auth !== false,
        });
        const metadata = inspectApplyableReply(loaded.bundle);
        const record = createCutTry({
          bundle: loaded.bundle,
          metadata,
          repoPath: resolve(options.repo ?? process.cwd()),
        });
        void recordHostedCliProductEvent({
          eventType: 'try_succeeded',
          elapsedMs: elapsedSince(startedAt),
          apiUrl: options.apiUrl,
        });
        process.stdout.write(`Reply Cut verified\nParent Cut and item binding verified\nRepository matches\nBase revision matches\n`);
        process.stdout.write(`${metadata.edits.length} proposed edit(s) across ${new Set(metadata.edits.map((edit) => edit.path)).size} file(s)\n\n`);
        process.stdout.write(renderApplyableDiff(metadata));
        process.stdout.write(`\nTemporary sparse worktree created\nTry ID: ${record.tryId}\nWorktree: ${record.worktreePath}\n`);
        process.stdout.write(`Inspect it there with git diff. Cut did not copy unrelated working files or run commands, tests, hooks, commits, or pushes.\n`);
        process.stdout.write(`Discard later with: cut try --discard ${record.tryId}\n`);
      } catch (error) {
        void recordHostedCliProductEvent({
          eventType: 'try_rejected_by_reason_class',
          elapsedMs: elapsedSince(startedAt),
          failureStage: cliFailureReason(error),
          apiUrl: options.apiUrl,
        });
        throw error;
      }
    });

  program
    .command('apply <share-source>')
    .description('Interactively apply an exact, verified Cut reply without committing or running code')
    .option('--repo <path>', 'Repository to apply against (default: current repository)')
    .option('--api-url <url>', 'Override the hosted Cut API URL')
    .option('--no-auth', 'Do not open browser authentication for a restricted hosted Cut')
    .action(async (source: string, options) => {
      const startedAt = performance.now();
      void recordHostedCliProductEvent({ eventType: 'apply_started', apiUrl: options.apiUrl });
      try {
        const loaded = await loadShareSource({
          source,
          apiUrl: options.apiUrl,
          authenticateHosted: options.auth !== false,
        });
        const metadata = inspectApplyableReply(loaded.bundle);
        const result = await applyCutReply({
          bundle: loaded.bundle,
          metadata,
          repoPath: resolve(options.repo ?? process.cwd()),
        });
        void recordHostedCliProductEvent({
          eventType: 'apply_confirmed',
          elapsedMs: elapsedSince(startedAt),
          apiUrl: options.apiUrl,
        });
        process.stdout.write(`Applied ${result.changedPaths.length} path(s) without committing, pushing, running hooks, or executing code.\n`);
        process.stdout.write(`Recovery material: ${result.recoveryPath}\n`);
      } catch (error) {
        void recordHostedCliProductEvent({
          eventType: 'apply_rejected_by_reason_class',
          elapsedMs: elapsedSince(startedAt),
          failureStage: cliFailureReason(error),
          apiUrl: options.apiUrl,
        });
        throw error;
      }
    });

  program
    .command('verify <share-source>')
    .description('Compare a verified immutable Cut with a selected local repository state')
    .option('--repo <path>', 'Repository to compare (default: current repository)')
    .option('--against <revision>', 'Compare with one named Git commit')
    .option('--staged', 'Compare with the staged index')
    .option('--json', 'Emit byte-stable normalized JSON')
    .option('--output <path>', 'Write the verification report to a new file')
    .option('--submit', 'Submit the deterministic receipt to the hosted Cut as its signed-in owner')
    .option('--api-url <url>', 'Override the hosted Cut API URL')
    .option('--no-auth', 'Do not open browser authentication for a restricted hosted Cut')
    .action(async (source: string, options) => {
      const loaded = await loadShareSource({
        source,
        apiUrl: options.apiUrl,
        authenticateHosted: options.auth !== false,
      });
      const report = verifyShareBundle({
        bundle: loaded.bundle,
        repoPath: resolve(options.repo ?? process.cwd()),
        against: options.against,
        staged: options.staged === true,
        toolVersion,
        entirelyLocal: loaded.entirelyLocal,
      });
      const rendered = options.json === true
        ? normalizedVerificationJson(report)
        : humanVerification(report);
      if (options.output) {
        const target = writeNewOutput(options.output, rendered);
        process.stdout.write(`Verification report written · ${target}\n`);
      } else {
        process.stdout.write(rendered);
      }
      if (options.submit === true) {
        if (!loaded.hostedUrl) throw new Error('--submit requires a hosted Cut URL.');
        const apiUrl = (options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
        const token = loaded.bearerToken
          ?? await browserCliToken(apiUrl, shareOrigin(loaded.hostedUrl), 'receipt');
        await submitHostedVerificationReceipt({
          url: loaded.hostedUrl,
          bearerToken: token,
          receipt: report.receipt as unknown as Record<string, unknown>,
          apiUrl,
        });
        process.stdout.write('Creator-reported verification receipt submitted for this exact Cut digest.\n');
      }
    });

  program
    .command('refresh <share-source>')
    .description('Prepare a reviewed local immutable successor without changing or publishing the original')
    .option('--repo <path>', 'Repository to compare (default: current repository)')
    .option('--against <revision>', 'Refresh from one named Git commit')
    .option('--staged', 'Refresh from the staged index')
    .option('--decision <item=decision>', 'keep, use, remove, or abort a non-current item', collect, [])
    .option('--replacement <item=path[:start-end]>', 'Explicit current material for a use decision', collect, [])
    .option('--acknowledge-finding <id>', 'Acknowledge one exact scanner finding', collect, [])
    .option('--output <path>', 'Write the new local archive', 'neurcode-cut-refresh.tar.gz')
    .option('--api-url <url>', 'Override the hosted Cut API URL')
    .option('--no-auth', 'Do not open browser authentication for a restricted hosted Cut')
    .option('--yes', 'Confirm non-interactively after the full decision and disclosure review')
    .action(async (source: string, options) => {
      const loaded = await loadShareSource({
        source,
        apiUrl: options.apiUrl,
        authenticateHosted: options.auth !== false,
      });
      const repoPath = resolve(options.repo ?? process.cwd());
      const report = verifyShareBundle({
        bundle: loaded.bundle,
        repoPath,
        against: options.against,
        staged: options.staged === true,
        toolVersion,
        entirelyLocal: loaded.entirelyLocal,
      });
      process.stdout.write(humanVerification(report));
      const result = await refreshShare({
        bundle: loaded.bundle,
        report,
        repoPath,
        against: options.against,
        staged: options.staged === true,
        output: options.output,
        decisions: assignments(options.decision ?? [], decision, '--decision'),
        replacements: assignments(options.replacement ?? [], String, '--replacement'),
        acknowledgeFindings: options.acknowledgeFinding ?? [],
        yes: options.yes === true,
        toolVersion,
      });
      if (result.aborted) process.stdout.write('Refresh aborted. The original Cut remains unchanged.\n');
    });

  program
    .command('comments <share-url>')
    .description('Read authorized Cut comments as repository-addressable feedback')
    .option('--json', 'Emit normalized JSON')
    .option('--output <path>', 'Write comments to a new file')
    .option('--api-url <url>', 'Override the hosted Cut API URL')
    .action(async (url: string, options) => {
      const apiUrl = (options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
      const token = await browserCliToken(apiUrl, shareOrigin(url), 'comments');
      const result = await fetchHostedComments({
        url,
        bearerToken: token,
        apiUrl,
      });
      const rendered = options.json === true
        ? `${canonicalize({ schemaVersion: 1, ...result })}\n`
        : commentHuman(result.shareId, result.comments);
      if (options.output) {
        const target = writeNewOutput(options.output, rendered);
        process.stdout.write(`Comments written · ${target}\n`);
      } else {
        process.stdout.write(rendered);
      }
    });
}
