/**
 * Interactive terminal prompts (node:readline, no third-party libraries).
 */
import { createInterface } from 'node:readline/promises';
import { AbortError } from './errors.mjs';
import { color, log } from './logger.mjs';
import { parseSelection } from './selection.mjs';

/** Prompts are only shown when a person is at the keyboard. */
export const canPrompt = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

/**
 * Shows a numbered list and asks the user to pick items, re-asking on invalid input.
 * The order the user types is the order the items are returned in.
 *
 * @template T
 * @param {object} params
 * @param {string} params.title
 * @param {T[]} params.items
 * @param {(item: T) => string} params.nameOf
 * @param {(item: T) => string} params.describe     one-line description shown in the list
 * @param {string} params.question
 * @param {boolean} params.emptyMeansNone
 * @returns {Promise<T[]>}
 */
export async function selectItems({ title, items, nameOf, describe, question, emptyMeansNone }) {
  log.plain(`\n${color.bold(title)}`);
  const width = String(items.length).length;
  items.forEach((item, i) => log.info(`${color.cyan(String(i + 1).padStart(width))}) ${describe(item)}`));
  log.plain(color.dim('\n  Type numbers, ranges or names in the order you want them, e.g. "3,1,5-7" or "lodash ms".'));
  log.plain(color.dim('  "all" selects everything, "none" selects nothing.'));

  for (;;) {
    const answer = await ask(`${question} `);
    const result = parseSelection(answer, items, { nameOf, emptyMeansNone });
    if ('selected' in result) return result.selected;
    log.warn(result.error);
  }
}

/**
 * Yes/no question. Only an explicit "y"/"yes" counts as yes; Enter alone means no.
 * @returns {Promise<boolean>}
 */
export async function confirm(question) {
  for (;;) {
    const answer = (await ask(`${question} [y/N] `)).trim().toLowerCase();
    if (['y', 'yes'].includes(answer)) return true;
    if (['', 'n', 'no'].includes(answer)) return false;
    log.warn('Please answer "y" or "n".');
  }
}

async function ask(question) {
  // A fresh interface per question, closed straight after, so stdin isn't held open
  // while npm and the tests run.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const aborted = new Promise((_, reject) => rl.once('SIGINT', () => reject(new AbortError())));
  try {
    return await Promise.race([rl.question(color.bold(`  ${question}`)), aborted]);
  } finally {
    rl.close();
  }
}
