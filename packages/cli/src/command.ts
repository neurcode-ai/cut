import type { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { createLocalShare } from './share/create';
import { startShareComposer } from './share/composer';
import { discoverShareRepository } from './share/git-reader';
import { proposeGitWorkingSet } from './share/working-set';
import {
  expiryHours,
  fetchHostedShare,
  parseHostedReplyTarget,
  publishHostedShare,
  type HostedReplyTarget,
} from './share/hosted';

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function replyTarget(value: unknown): Promise<HostedReplyTarget | undefined> {
  if (value === undefined) return undefined;
  if (value !== '-') return parseHostedReplyTarget(String(value));
  if (process.stdin.isTTY) {
    throw new Error('--reply-to - expects one Cut URL or ID piped on stdin. This keeps capability URLs out of shell history.');
  }
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (line.length > 16_384) throw new Error('The stdin reply target exceeds 16,384 characters.');
      if (line.trim()) return parseHostedReplyTarget(line);
    }
  } finally {
    lines.close();
  }
  throw new Error('--reply-to - did not receive a Cut URL or ID on stdin.');
}

export function shareCommand(program: Command, toolVersion: string): void {
  program
    .command('cut [selections...]')
    .alias('share')
    .description('Turn exact source, diffs, and observed command output into a safe local Cut')
    .option('--staged', 'Include the staged unified diff')
    .option('--diff [A..B]', 'Include the working-tree diff, or a commit range with --diff=A..B')
    .option('--run <command>', 'Run a bounded command and include its observed output')
    .option('--run-timeout <seconds>', 'Evidence timeout in seconds (1 to 600)', '60')
    .option('-m, --message <text>', 'Cut title and short intent')
    .option('--note <file=text>', 'Attach a short asserted note to a selected file, diff, or run', collect, [])
    .option('--force-include <file>', 'Override an ignored or credential-like exclusion for this exact named file', collect, [])
    .option('--strip-context <file-or-id>', 'Omit the fixed ±20-line context for an excerpt', collect, [])
    .option('--acknowledge-finding <id>', 'Acknowledge one exact secret-scan finding', collect, [])
    .option('--expire <duration>', 'Hosted expiry in hours or a bounded duration such as 7d')
    .option('--publish', 'Publish after the local disclosure review')
    .option('--reply-to <cut-url-or-id>', 'Link a hosted publication as a reply; use - to read the target from stdin')
    .option('--visibility <mode>', 'Hosted access: unlisted, restricted, or public', 'unlisted')
    .option('--recipient <email>', 'Allow a signed-in email for restricted access', collect, [])
    .option('--api-url <url>', 'Override the hosted Cut API URL')
    .option('--no-browser', 'Use the guided terminal fallback instead of the local browser Composer')
    .option('--draft <id>', 'Resume a local browser Composer draft by ID')
    .option('--handoff', 'Start a Cut-format interrupted-session handoff preset')
    .option('--out <file>', 'Write .tar.gz, .md, .json, or .html')
    .option('--preview [file]', 'Write a self-contained local HTML preview')
    .option('--copy [format]', 'Copy Markdown (default) or JSON to the clipboard')
    .option('--stdout <format>', 'Write only md or json payload to stdout; disclosure review stays on stderr')
    .option('--dry-run', 'Print “Review what will be shared” and write nothing')
    .option('--yes', 'Confirm non-interactively after printing the full disclosure review')
    .addHelpText(
      'after',
      '\nExamples:\n'
        + '  neurcode-cut src/queue.ts:20-80 tests/queue.test.ts -m "race in drain loop?" --preview\n'
        + '  neurcode-cut --diff --run "npm test -- queue" --yes --out cut.tar.gz\n'
        + '  neurcode-cut --diff=main..HEAD --yes --out context.md\n'
        + '  npx @neurcode-ai/cut@0.3.0                    # local browser Composer\n'
        + '  neurcode-cut --no-browser                     # guided terminal fallback\n'
        + '  neurcode-cut --handoff                        # Cut-format handoff preset\n'
        + '  printf \'%s\\n\' "$CUT_REPLY_URL" | neurcode-cut src/reply.ts --reply-to - --publish\n'
        + '\nCapability-bearing URLs can be retained in shell history when passed as arguments. Prefer --reply-to - with piped stdin.\n'
        + '\nLocal creation never requires an account. Publish authenticates only after “Review what will be shared.”\n',
    )
    .action(async (selections: string[], options) => {
      if (selections?.[0] === 'fetch') {
        if (!selections[1] || selections.length > 2) {
          throw new Error('Usage: neurcode-cut fetch <cut-or-agent-link> [--out file] [--stdout md|json]');
        }
        await fetchHostedShare({
          url: selections[1],
          apiUrl: options.apiUrl,
          out: options.out,
          stdout: options.stdout,
        });
        return;
      }
      const replyTo = await replyTarget(options.replyTo);
      const timeout = Number(options.runTimeout);
      if (!Number.isFinite(timeout) || timeout < 0.001 || timeout > 600) {
        throw new Error('--run-timeout must be between 0.001 and 600 seconds.');
      }
      // Explicit headless or export flags mean the caller wants no browser.
      const headlessRequested = options.browser === false
        || Boolean(options.out)
        || Boolean(options.preview)
        || Boolean(options.copy)
        || Boolean(options.stdout)
        || options.dryRun === true;
      const zeroArgumentRequested = (selections?.length ?? 0) === 0
        && options.staged !== true
        && options.diff === undefined
        && !options.run
        && options.handoff !== true
        && !options.draft;
      const browserComposer = options.browser !== false
        && zeroArgumentRequested
        && !options.out
        && !options.preview
        && !options.copy
        && !options.stdout
        && !options.dryRun;
      // --handoff is a Cut-format preset, not a second UI. It opens the visual
      // Composer only when nothing forces headless mode; with --no-browser or any
      // export flag it falls through to the terminal/headless path below and the
      // preset is applied as "share the current working-tree diff".
      const handoffComposer = options.handoff === true && !headlessRequested;
      if (browserComposer || handoffComposer || options.draft) {
        await startShareComposer({
          toolVersion,
          apiUrl: options.apiUrl,
          draftId: options.draft,
          preset: options.handoff === true
            ? 'handoff'
            : zeroArgumentRequested
              ? 'working-set'
              : undefined,
          replyTo,
        });
        return;
      }

      let terminalSelections = selections ?? [];
      let terminalStaged = options.staged === true;
      let terminalDiff: boolean | string = typeof options.diff === 'string'
        ? options.diff
        : options.diff === true;
      let terminalRun = options.run as string | undefined;
      let terminalMessage = options.message as string | undefined;
      let terminalOut = options.out as string | undefined;
      let terminalPreview = options.preview as boolean | string | undefined;
      let terminalDiffPaths: string[] | undefined;
      let proposedExclusions: string[] | undefined;

      // Headless --handoff preset: capture the current working-tree diff when the
      // caller did not name their own selections, so agents can produce a handoff
      // Cut non-interactively (e.g. --handoff --yes --out handoff.tar.gz).
      if (
        options.handoff === true
        && terminalSelections.length === 0
        && !terminalStaged
        && terminalDiff === false
        && !terminalRun
      ) {
        terminalDiff = true;
        if (!terminalMessage) terminalMessage = 'Continue this work';
      }

      if (zeroArgumentRequested) {
        const proposal = proposeGitWorkingSet();
        if (proposal.initialItemCount === 0) {
          throw new Error('No changed, staged, or untracked files were found in the current Git subtree.');
        }
        terminalSelections = proposal.selections;
        terminalDiff = proposal.diffPaths.length > 0;
        terminalDiffPaths = proposal.diffPaths;
        proposedExclusions = proposal.exclusions;
        const nonInteractive = options.yes === true || !process.stdin.isTTY;
        if (nonInteractive && !terminalMessage?.trim()) {
          throw new Error('A noninteractive zero-argument Cut requires --message <text>.');
        }
        if (!process.stdin.isTTY && options.yes !== true) {
          throw new Error('A noninteractive zero-argument Cut requires --yes after explicit disclosure options.');
        }
        if (options.browser === false && process.stdin.isTTY) {
          const repository = discoverShareRepository();
          process.stdout.write(
            `\nCut by Neurcode · proposed Git working set\n`
            + `${repository.name} · ${repository.branch || 'detached'} · ${repository.dirty ? 'local changes' : 'clean'}\n`
            + `${proposal.initialItemCount} proposed item(s) in ${proposal.scope || '.'}\n`
            + proposal.selections.map((path, index) => `  ${index + 1}  ${path}\n`).join('')
            + (proposal.diffPaths.length
              ? `  ${proposal.selections.length + 1}  Relevant staged/worktree diff (${proposal.diffPaths.length} path(s))\n`
              : '')
            + proposal.exclusions.map((exclusion) => `  Excluded: ${exclusion}\n`).join('')
            + '\n',
          );
        }
      }

      if (options.browser === false && zeroArgumentRequested && process.stdin.isTTY) {
        process.stdout.write(
          'Each proposed item remains removable in “Review what will be shared.”\n',
        );
        const prompt = createInterface({ input: process.stdin, output: process.stdout });
        try {
          if (!terminalMessage?.trim()) {
            terminalMessage = (await prompt.question('What should the recipient understand or help with? ')).trim();
          }
          if (!terminalMessage) throw new Error('A Cut needs a question or intent.');
          if (!terminalOut && !terminalPreview && !options.copy && !options.stdout && options.publish !== true) {
            terminalOut = 'neurcode-cut.tar.gz';
            terminalPreview = true;
          }
        } finally {
          prompt.close();
        }
      }

      const publishVisibility = options.visibility as 'unlisted' | 'restricted' | 'public';
      const publishRecipients = (options.recipient ?? []) as string[];
      const publishExpiryHours = expiryHours(options.expire);
      if (options.expire && options.publish !== true) {
        throw new Error('--expire applies to hosted publishing and requires --publish.');
      }
      if (options.publish === true && !['unlisted', 'restricted', 'public'].includes(publishVisibility)) {
        throw new Error('--visibility must be unlisted, restricted, or public.');
      }
      if (options.publish === true && publishVisibility === 'restricted' && publishRecipients.length === 0) {
        throw new Error('--visibility restricted requires at least one --recipient <email>.');
      }
      const result = await createLocalShare({
        selections: terminalSelections,
        staged: terminalStaged,
        diff: terminalDiff,
        run: terminalRun,
        runTimeoutSeconds: timeout,
        message: terminalMessage,
        notes: options.note ?? [],
        forceInclude: options.forceInclude ?? [],
        stripContext: options.stripContext ?? [],
        diffPaths: terminalDiffPaths,
        proposedExclusions,
        acknowledgeFindings: options.acknowledgeFinding ?? [],
        expire: options.expire,
        out: terminalOut,
        preview: terminalPreview,
        copy: options.copy,
        stdout: options.stdout,
        dryRun: options.dryRun === true,
        yes: options.yes === true,
        toolVersion,
        hostedPublish: options.publish === true
          ? {
              visibility: publishVisibility,
              expiryHours: publishExpiryHours,
              recipientCount: publishRecipients.length,
              reply: Boolean(replyTo),
            }
          : undefined,
      });
      if (replyTo && options.publish !== true) {
        process.stderr.write('Local artifact created. Reply relationships are hosted metadata and are applied only during hosted publication.\n');
      }
      if (options.publish === true) {
        if (!result.bundle) throw new Error('Publishing requires a completed local disclosure review.');
        if (result.bundle.cut.manifest.security.acknowledgedFindings.length > 0) {
          throw new Error(
            'Hosted publishing is blocked while exact secret or sensitive-file findings remain. Remove or redact every finding before upload.',
          );
        }
        const published = await publishHostedShare({
          bundle: result.bundle,
          apiUrl: options.apiUrl,
          visibility: publishVisibility,
          recipients: publishRecipients,
          expiryHours: publishExpiryHours,
          replyTo,
        });
        process.stdout.write(`Published securely · ${published.url}\n`);
      }
    });
}
