/**
 * Builds the Markdown summary that can be pasted into a merge request description/comment.
 * It lists only the changes the MR contains; failed or skipped upgrades are reported in
 * the terminal and the logs instead.
 */

const CHANGE_LABEL = { major: '🔴 major', minor: '🟡 minor', patch: '🟢 patch', prerelease: '⚪ prerelease' };

/**
 * @param {object} results
 * @param {Array} results.upgraded
 * @param {Array} results.overridesRemoved
 * @returns {string}
 */
export function buildReport({ upgraded, overridesRemoved }) {
  const sections = ['## 📦 Dependency upgrades', ''];

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
