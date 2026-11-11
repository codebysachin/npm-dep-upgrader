/**
 * Parses what the user typed when picking items from a numbered list.
 * Pure logic so it can be unit-tested without a terminal.
 *
 * Accepted input (comma- or space-separated, order is preserved):
 *   3            → item #3
 *   2-5          → items #2 to #5
 *   lodash       → item named "lodash"
 *   all          → every item, in list order
 *   none | n     → nothing
 * ("q" never reaches this parser: the prompt treats it as quitting the script.)
 */

const ALL = new Set(['all', 'a', '*']);
const NONE = new Set(['none', 'n', 'done', 'finish']);

export interface SelectionOptions<T> {
  nameOf: (item: T) => string;
  /** other names that also pick the item */
  aliasesOf?: (item: T) => string[];
  /** true: Enter alone selects nothing; false: Enter alone is invalid. */
  emptyMeansNone?: boolean;
}

export type SelectionResult<T> = { selected: T[] } | { error: string };

export function parseSelection<T>(
  input: string,
  items: T[],
  { nameOf, aliasesOf = () => [], emptyMeansNone }: SelectionOptions<T>,
): SelectionResult<T> {
  const text = input.trim();
  if (!text) return emptyMeansNone ? { selected: [] } : { error: 'Please choose something, "all" or "none".' };

  const lower = text.toLowerCase();
  if (ALL.has(lower)) return { selected: [...items] };
  if (NONE.has(lower)) return { selected: [] };

  const indices: number[] = [];
  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const range = /^(\d+)-(\d+)$/.exec(token);
    if (range) {
      const [start, end] = [Number(range[1]), Number(range[2])];
      if (start > end || start < 1 || end > items.length) return { error: `Range "${token}" is out of bounds (1-${items.length}).` };
      for (let i = start; i <= end; i++) indices.push(i - 1);
    } else if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n < 1 || n > items.length) return { error: `"${token}" is not in the list (1-${items.length}).` };
      indices.push(n - 1);
    } else {
      const index = items.findIndex((item) => nameOf(item) === token || aliasesOf(item).includes(token));
      if (index === -1) return { error: `"${token}" is not in the list.` };
      indices.push(index);
    }
  }

  return { selected: [...new Set(indices)].map((i) => items[i]) };
}
