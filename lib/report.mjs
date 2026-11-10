/**
 * Builds the Markdown summary that can be pasted into a merge request description/comment.
 */
import { renderFailureMarkdown } from './failure-report.mjs';

const CHANGE_LABEL = { major: '🔴 major', minor: '🟡 minor', patch: '🟢 patch', prerelease: '⚪ prerelease' };

/**
 * @param {object} results
 * @param {Array} results.upgraded
 * @param {Array} results.failed
 * @param {Array<{name: string, reason: string}>} results.skipped
 * @param {Array} results.overridesRemoved
 * @param {Array} results.overridesKept
 * @param {string} results.testCommand
 * @returns {string}
 */
export function buildReport({ upgraded, failed, skipped, overridesRemoved, overridesKept, testCommand }) {
  const sections = ['## 📦 Dependency upgrades', ''];

  sections.push(
    `Each package was upgraded **one at a time** and \`${testCommand}\` was run after every change. ` +
      'Only changes with passing tests were kept.',
    '',
  );

  sections.push(`### ✅ Upgraded (${upgraded.length})`, '');
  sections.push(
    upgraded.length
      ? table(
          ['Package', 'From', 'To', 'Change', 'Type'],
          upgraded.map((u) => [code(u.name), u.from, u.to, CHANGE_LABEL[u.change] ?? u.change, u.section]),
        )
      : '_No packages were upgraded._',
    '',
  );

  if (overridesRemoved.length) {
    sections.push(`### 🧹 Obsolete overrides removed (${overridesRemoved.length})`, '');
    sections.push(
      table(
        ['Override', 'Forced version', 'Resolved without override'],
        overridesRemoved.map((o) => [code(o.keyPath.join(' › ')), o.spec, o.resolved]),
      ),
      '',
    );
  }

  if (failed.length) {
    sections.push(`### ⚠️ Not upgraded — needs manual attention (${failed.length})`, '');
    sections.push(
      table(
        ['Package', 'Current', 'Attempted', 'Reason'],
        failed.map((f) => [code(f.name), f.from, f.to, f.reason]),
      ),
      '',
    );
    for (const f of failed.filter((item) => item.failure)) {
      const what = f.failure.kind === 'tests' ? 'test failure details' : 'npm install error';
      sections.push(renderFailureMarkdown(`${f.name} ${f.to}: ${what}`, f.failure), '');
    }
  }

  if (overridesKept.length) {
    sections.push(`### 🔒 Overrides still required (${overridesKept.length})`, '');
    sections.push(
      table(
        ['Override', 'Forced version', 'Why it is kept'],
        overridesKept.map((o) => [code(o.keyPath.join(' › ')), o.spec, o.reason]),
      ),
      '',
    );
  }

  if (skipped.length) {
    sections.push(`<details><summary>⏭️ Skipped (${skipped.length})</summary>`, '');
    sections.push(table(['Package', 'Reason'], skipped.map((s) => [code(s.name), s.reason])), '', '</details>', '');
  }

  return sections.join('\n');
}

/** One-line commit/MR title, e.g. "chore(deps): upgrade 4 packages and remove 1 obsolete override". */
export function buildCommitTitle({ upgraded, overridesRemoved }) {
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const parts = [];
  if (upgraded.length) parts.push(`upgrade ${plural(upgraded.length, 'package')}`);
  if (overridesRemoved.length) parts.push(`remove ${plural(overridesRemoved.length, 'obsolete override')}`);
  return `chore(deps): ${parts.join(' and ') || 'no changes'}`;
}

function table(headers, rows) {
  const escape = (cell) => String(cell ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`),
  ].join('\n');
}

const code = (text) => `\`${text}\``;
