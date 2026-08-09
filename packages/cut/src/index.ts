#!/usr/bin/env node

process.env.NEURCODE_CUT_ENTRY_VERSION = '0.4.0';
void import('@neurcode-ai/share').catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
