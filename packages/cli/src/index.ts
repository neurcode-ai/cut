#!/usr/bin/env node

import { Command } from 'commander';
import { shareCommand } from './command';

const version = '0.1.0';
const program = new Command()
  .name('neurcode-share')
  .description('Create deterministic, reviewable code-context Shares locally or publish them securely')
  .version(version);

shareCommand(program, version);

const first = process.argv[2];
if (first !== 'share' && first !== '--help' && first !== '-h' && first !== '--version' && first !== '-V') {
  process.argv.splice(2, 0, 'share');
}

program.parseAsync().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
