/**
 * Interactive terminal prompts (node:readline, no third-party libraries).
 * At every prompt, typing "q" (or "quit") stops the script: `ask` throws QuitError.
 */
import { createInterface } from 'node:readline/promises';
import { AbortError, QuitError } from './errors.mjs';
import { color, log } from './logger.mjs';
import { parseSelection } from './selection.mjs';

const QUIT_ANSWERS = new Set(['q', 'quit', 'exit']);

/**
 * Scripted answers for automated runs (the end-to-end tests): NPM_DEP_UPGRADER_ANSWERS holds a
 * JSON array of strings, used in order, one per question. Running out of answers is an error,
 * so a test never hangs waiting for input.
 */
let scripted;
function scriptedAnswers() {
  if (scripted === undefined) {
    const raw = process.env.NPM_DEP_UPGRADER_ANSWERS;
    scripted = raw ? JSON.parse(raw) : null;
    if (scripted && !Array.isArray(scripted)) throw new Error('NPM_DEP_UPGRADER_ANSWERS must be a JSON array of strings');
  }
  return scripted;
}

/** Prompts are only shown when a person is at the keyboard (or answers are scripted). */
export const canPrompt = () => Boolean(scriptedAnswers()) || Boolean(process.stdin.isTTY && process.stdout.isTTY);

/**
 * Shows a numbered list and asks the user to pick items, re-asking on invalid input.
 * The order the user types is the order the items are returned in.
 *
 * @template T
 * @param {object} params
 * @param {string} params.title
 * @param {T[]} params.items
 * @param {(item: T) => string} params.nameOf
 * @param {(item: T) => string[]} [params.aliasesOf]  other names that also pick the item
 * @param {(item: T) => string} params.describe     one-line description shown in the list
 * @param {string} params.question
 * @param {boolean} params.emptyMeansNone
 * @returns {Promise<T[]>}
 */
export async function selectItems({ title, items, nameOf, aliasesOf, describe, question, emptyMeansNone }) {
  log.plain(`\n${color.bold(title)}`);
  const width = String(items.length).length;
  items.forEach((item, i) => log.info(`${color.cyan(String(i + 1).padStart(width))}) ${describe(item)}`));
  log.plain(color.dim('\n  Type numbers, ranges or names in the order you want them, e.g. "3,1,5-7" or "lodash ms".'));
  log.plain(color.dim('  "all" selects everything, "none" selects nothing, "q" quits.'));

  for (;;) {
    const answer = await ask(`${question} `);
    const result = parseSelection(answer, items, { nameOf, aliasesOf, emptyMeansNone });
    if ('selected' in result) return result.selected;
    log.warn(result.error);
  }
}

/**
 * Yes/no question. Enter alone gives `defaultAnswer` (no, unless stated otherwise).
 * @returns {Promise<boolean>}
 */
export async function confirm(question, { defaultAnswer = false } = {}) {
  for (;;) {
    const answer = (await ask(`${question} ${defaultAnswer ? '[Y/n/q]' : '[y/N/q]'} `)).trim().toLowerCase();
    if (answer === '') return defaultAnswer;
    if (['y', 'yes'].includes(answer)) return true;
    if (['n', 'no'].includes(answer)) return false;
    log.warn('Please answer "y", "n", or "q" to quit.');
  }
}

/**
 * Numbered single choice, with "q) Quit" listed last. Enter alone picks the first choice.
 * @param {string} question
 * @param {Array<{ key: string, label: string }>} choices
 * @returns {Promise<string>} the chosen key
 */
export async function choose(question, choices) {
  choices.forEach((choice, i) => log.info(`${color.cyan(String(i + 1))}) ${choice.label}`));
  log.info(`${color.cyan('q')}) Quit`);
  for (;;) {
    const answer = (await ask(`${question} [1-${choices.length}, Enter = 1, q = quit] `)).trim();
    const index = answer === '' ? 0 : Number(answer) - 1;
    if (Number.isInteger(index) && choices[index]) return choices[index].key;
    log.warn(`Please type a number from 1 to ${choices.length}, or "q" to quit.`);
  }
}

async function ask(question) {
  const answer = scriptedAnswers() ? nextScriptedAnswer(question) : await askTerminal(question);
  if (QUIT_ANSWERS.has(answer.trim().toLowerCase())) throw new QuitError();
  return answer;
}

function nextScriptedAnswer(question) {
  const answers = scriptedAnswers();
  if (!answers.length) throw new Error(`No scripted answer left for: ${question}`);
  const answer = String(answers.shift());
  log.plain(`${color.bold(`  ${question}`)}${answer}`);
  return answer;
}

async function askTerminal(question) {
  // A fresh interface per question, closed straight after, so stdin isn't held open
  // while npm and the tests run.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const aborted = new Promise((_, reject) => rl.once('SIGINT', () => reject(new AbortError())));
  let answer;
  try {
    answer = await Promise.race([rl.question(color.bold(`  ${question}`)), aborted]);
  } finally {
    rl.close();
  }
  return answer;
}
