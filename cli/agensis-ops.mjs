#!/usr/bin/env node
// Thin shell around runOpsCommand: wire up the real streams and turn the
// returned code into a process exit. Everything testable lives in src/.

import { runOpsCommand } from './src/index.mjs';

const code = await runOpsCommand(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  isTTY: Boolean(process.stdout.isTTY),
});
process.exit(code);
