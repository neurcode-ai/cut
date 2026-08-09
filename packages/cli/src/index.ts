#!/usr/bin/env node

import { Command } from 'commander';
import { shareCommand } from './command';
import { livingShareCommands } from './living-commands';

const engineVersion = '0.8.0';
const version = process.env.NEURCODE_CUT_ENTRY_VERSION === '0.5.0'
  ? '0.5.0'
  : engineVersion;
const program = new Command()
  .name('neurcode-cut')
  .description('Turn the exact code that matters into one Cut for people and AI agents')
  .version(version);

shareCommand(program, version);
livingShareCommands(program, version);

const first = process.argv[2];
if (
  first !== 'cut'
  && first !== 'share'
  && first !== 'verify'
  && first !== 'refresh'
  && first !== 'comments'
  && first !== 'teams'
  && first !== 'inbox'
  && first !== 'try'
  && first !== 'apply'
  && first !== '--help'
  && first !== '-h'
  && first !== '--version'
  && first !== '-V'
) {
  process.argv.splice(2, 0, 'cut');
}

program.parseAsync().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
