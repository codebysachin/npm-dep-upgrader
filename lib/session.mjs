/**
 * The state one run shares between its phases (set-up, upgrade rounds, overrides, finish).
 * Command-line options stay as parsed; everything the run decides later lives next to them.
 */
import { canPrompt } from './prompt.mjs';

/**
 * @typedef {object} Workspace   where the changes are made, decided before anything changes
 * @property {string} baseBranch   the branch the run starts from (main, or the current branch)
 * @property {string} workBranch   the branch the changes land on
 * @property {boolean} created     workBranch is a new branch this run creates from main
 * @property {boolean} reuse       workBranch already exists without commits of its own and is reset to main
 */

/**
 * @typedef {object} Results   what the run did so far (read when quitting part-way, too)
 * @property {object[]} upgraded
 * @property {object[]} failed
 * @property {Array<{name: string, reason: string}>} skipped
 * @property {object[]} overridesRemoved
 * @property {object[]} overridesKept
 */

/**
 * @typedef {object} Session
 * @property {Readonly<object>} options                 parsed command line (see options.mjs)
 * @property {import('./workflow.mjs').RunContext} ctx
 * @property {boolean} prompts    questions may be asked: a terminal (or scripted answers) and no --yes.
 *                                Every "ask or use the default?" decision reads this one flag.
 * @property {Workspace|null} workspace
 * @property {Results|null} results
 */

/** @returns {Session} */
export function createSession(options, ctx) {
  return { options, ctx, prompts: canPrompt() && !options.yes, workspace: null, results: null };
}

/** @returns {Results} */
export const emptyResults = () => ({ upgraded: [], failed: [], skipped: [], overridesRemoved: [], overridesKept: [] });
