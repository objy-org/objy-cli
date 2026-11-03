#!/usr/bin/env node
import { main } from '../src/cli.js';

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`\n${error.name === 'AbortError' ? 'Cancelled.' : `Error: ${error.message}`}\n`);
  process.exitCode = error.name === 'AbortError' ? 130 : 1;
}
