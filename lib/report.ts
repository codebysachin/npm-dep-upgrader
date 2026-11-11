/**
 * Builds the Markdown summary that can be pasted into a merge request description/comment.
 * It lists only the changes the MR contains; failed or skipped upgrades are reported in
 * the terminal and the logs instead.
 */

const CHANGE_LABEL: Record<string, string> = { major: '🔴 major', minor: '🟡 minor', patch: '🟢 patch', prerelease: '⚪ prerelease' };

interface ReportUpgrade {
  name: string;
  from: string;
  to: string;
  change: string;
  section: string;
}

interface ReportOverride {
  keyPath: string[];
  spec: string;
  resolved: string;
}

interface ReportInput {
  upgraded: ReportUpgrade[];
  overridesRemoved: ReportOverride[];
  failed?: unknown[];
  skipped?: unknown[];
  overridesKept?: unknown[];
}

export function buildReport({ upgraded, overridesRemoved }: ReportInput): string {
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
export function buildCommitTitle({ upgraded, overridesRemoved }: { upgraded: unknown[]; overridesRemoved: unknown[] }): string {
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const parts = [];
  if (upgraded.length) parts.push(`upgrade ${plural(upgraded.length, 'package')}`);
  if (overridesRemoved.length) parts.push(`remove ${plural(overridesRemoved.length, 'obsolete override')}`);
  return `chore(deps): ${parts.join(' and ') || 'no changes'}`;
}

function table(headers: string[], rows: unknown[][]): string {
  const escape = (cell: unknown) => String(cell ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`),
  ].join('\n');
}

const code = (text: string) => `\`${text}\``;
