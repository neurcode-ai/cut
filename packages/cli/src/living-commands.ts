import type { Command } from 'commander';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalize } from '@neurcode-ai/share-format';
import { DEFAULT_API_URL } from './config';
import {
  browserCliToken,
  fetchHostedComments,
  submitHostedVerificationReceipt,
} from './share/hosted';
import { refreshShare, type RefreshDecision } from './share/refresh';
import { loadShareSource } from './share/source';
import {
  humanVerification,
  normalizedVerificationJson,
  verifyShareBundle,
} from './share/verification';

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

export function livingShareCommands(program: Command, toolVersion: string): void {
  program
    .command('verify <share-source>')
    .description('Compare a verified immutable Share with a selected local repository state')
    .option('--repo <path>', 'Repository to compare (default: current repository)')
    .option('--against <revision>', 'Compare with one named Git commit')
    .option('--staged', 'Compare with the staged index')
    .option('--json', 'Emit byte-stable normalized JSON')
    .option('--output <path>', 'Write the verification report to a new file')
    .option('--submit', 'Submit the deterministic receipt to the hosted Share as its signed-in owner')
    .option('--api-url <url>', 'Override the hosted Share API URL')
    .option('--no-auth', 'Do not open browser authentication for a restricted hosted Share')
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
        if (!loaded.hostedUrl) throw new Error('--submit requires a hosted Share URL.');
        const apiUrl = (options.apiUrl || DEFAULT_API_URL).replace(/\/+$/, '');
        const token = loaded.bearerToken
          ?? await browserCliToken(apiUrl, shareOrigin(loaded.hostedUrl), 'receipt');
        await submitHostedVerificationReceipt({
          url: loaded.hostedUrl,
          bearerToken: token,
          receipt: report.receipt as unknown as Record<string, unknown>,
          apiUrl,
        });
        process.stdout.write('Creator-reported verification receipt submitted for this exact Share digest.\n');
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
    .option('--output <path>', 'Write the new local archive', 'neurcode-share-refresh.tar.gz')
    .option('--api-url <url>', 'Override the hosted Share API URL')
    .option('--no-auth', 'Do not open browser authentication for a restricted hosted Share')
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
      if (result.aborted) process.stdout.write('Refresh aborted. The original Share remains unchanged.\n');
    });

  program
    .command('comments <share-url>')
    .description('Read authorized Share comments as repository-addressable feedback')
    .option('--json', 'Emit normalized JSON')
    .option('--output <path>', 'Write comments to a new file')
    .option('--api-url <url>', 'Override the hosted Share API URL')
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
