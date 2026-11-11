/**
 * Minimal console logger with ANSI colours.
 * Colours are disabled when output is not a TTY or NO_COLOR is set
 * (https://no-color.org), so logs stay clean in CI.
 */
import { useColor } from './runtime.ts';

const paint = (code: string) => (text: unknown): string => (useColor() ? `\x1b[${code}m${text}\x1b[0m` : String(text));

export const color = {
  bold: paint('1'),
  dim: paint('2'),
  red: paint('31'),
  green: paint('32'),
  yellow: paint('33'),
  cyan: paint('36'),
  inverseRed: paint('1;41;97'),
};

export const log = {
  step: (msg: string) => console.log(`\n${color.bold(color.cyan('▶'))} ${color.bold(msg)}`),
  info: (msg: string) => console.log(`  ${msg}`),
  success: (msg: string) => console.log(`  ${color.green('✔')} ${msg}`),
  warn: (msg: string) => console.log(`  ${color.yellow('⚠')} ${msg}`),
  error: (msg: string) => console.error(`  ${color.red('✖')} ${msg}`),
  plain: (msg: string = '') => console.log(msg),
};

/**
 * Prints an eye-catching banner. When attached to a terminal it briefly
 * flashes (alternating inverse/normal) and rings the bell so the message
 * is hard to miss.
 */
export async function flashBanner(title: string, lines: string[]): Promise<void> {
  const width = Math.min(Math.max(title.length + 8, 60), process.stdout.columns || 80);
  const bar = '═'.repeat(width);
  const heading = `  ${title}  `.padEnd(width);

  if (useColor()) {
    process.stdout.write('\x07'); // terminal bell
    for (let i = 0; i < 3; i++) {
      process.stdout.write(`\r${color.inverseRed(heading)}`);
      await sleep(180);
      process.stdout.write(`\r${color.bold(color.red(heading))}`);
      await sleep(120);
    }
    process.stdout.write('\r');
  }

  console.error(color.red(bar));
  console.error(color.inverseRed(heading));
  console.error(color.red(bar));
  for (const line of lines) console.error(line);
  console.error(color.red(bar));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
