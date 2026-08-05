#!/usr/bin/env node

import { Command } from 'commander';
import { shareCommand } from './command';
import { livingShareCommands } from './living-commands';

const version = '0.4.0';
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
