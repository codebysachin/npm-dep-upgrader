#!/usr/bin/env node
/**
 * Upgrades outdated npm dependencies one by one, verifying each with the test
 * suite, and removes package.json overrides that are no longer needed.
 *
 * Uses only Node.js built-in modules — no third-party dependencies.
 * Needs Node.js 22.18 or later, which runs .ts files directly (see package.json "engines").
 * Run `node upgrade-deps.ts --help` for options.
 */
import { main } from './lib/cli.ts';

process.exitCode = await main();
