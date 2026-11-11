#!/usr/bin/env node
/**
 * Upgrades outdated npm dependencies one by one, verifying each with the test
 * suite, and removes package.json overrides that are no longer needed.
 *
 * Uses only Node.js built-in modules — no third-party dependencies.
 * Run `node upgrade-deps.ts --help` for options.
 */
import { main } from './lib/cli.ts';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 11)) {
  console.error(`Node.js >= 18.11 is required (found ${process.versions.node}).`);
  process.exit(1);
}

process.exitCode = await main();
