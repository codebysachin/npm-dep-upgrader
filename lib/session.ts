/**
 * The state one run shares between its phases (set-up, upgrade rounds, overrides, finish).
 * Command-line options stay as parsed; everything the run decides later lives next to them.
 */
import { canPrompt } from './prompt.ts';
import type { Options } from './options.ts';
import type { OverrideLeaf } from './overrides.ts';
import type { RunContext, UpgradeItem } from './workflow.ts';

/** Where the changes are made, decided before anything changes. */
export interface Workspace {
  /** the branch the run starts from (main, or the current branch) */
  baseBranch: string;
  /** the branch the changes land on */
  workBranch: string;
  /** workBranch is a new branch this run creates from main */
  created: boolean;
  /** workBranch already exists without commits of its own and is reset to main */
  reuse: boolean;
}

/** What the run did so far (read when quitting part-way, too). */
export interface Results {
  upgraded: UpgradeItem[];
  failed: UpgradeItem[];
  skipped: Array<{ name: string; reason: string }>;
  overridesRemoved: Array<OverrideLeaf & { resolved: string }>;
  overridesKept: Array<OverrideLeaf & { reason: string }>;
}

export interface Session {
  /** parsed command line (see options.ts) */
  options: Readonly<Options>;
  ctx: RunContext;
  /**
   * questions may be asked: a terminal (or scripted answers) and no --yes.
   * Every "ask or use the default?" decision reads this one flag.
   */
  prompts: boolean;
  workspace: Workspace | null;
  results: Results | null;
}

export function createSession(options: Readonly<Options>, ctx: RunContext): Session {
  return { options, ctx, prompts: canPrompt() && !options.yes, workspace: null, results: null };
}

export const emptyResults = (): Results => ({ upgraded: [], failed: [], skipped: [], overridesRemoved: [], overridesKept: [] });
