#!/usr/bin/env node
import { run } from '../src/cli.mjs';

const code = await run(process.argv.slice(2), {
  env: process.env,
  fetch: globalThis.fetch,
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
});
process.exitCode = code;
