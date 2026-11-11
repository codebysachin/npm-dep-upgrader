/**
 * Reading/writing package.json and snapshotting manifest files so a failed
 * upgrade can be rolled back exactly.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Parsed package.json (untyped JSON). */
export interface Manifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, any>;
  [key: string]: any;
}

export interface ManifestSnapshot {
  restore: () => void;
}

export const MANIFEST_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'];

export const DEPENDENCY_SECTIONS = Object.freeze({
  dependencies: '--save-prod',
  devDependencies: '--save-dev',
  optionalDependencies: '--save-optional',
});

export function readManifest(cwd: string): Manifest {
  return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
}

/** Writes package.json, preserving the file's existing indentation and trailing newline. */
export function writeManifest(cwd: string, manifest: Manifest): void {
  const path = join(cwd, 'package.json');
  const original = readFileSync(path, 'utf8');
  const indent = /^[ \t]+(?=")/m.exec(original)?.[0] ?? '  ';
  const newline = original.endsWith('\n') ? '\n' : '';
  writeFileSync(path, JSON.stringify(manifest, null, indent) + newline);
}

export const hasLockfile = (cwd: string): boolean =>
  existsSync(join(cwd, 'package-lock.json')) || existsSync(join(cwd, 'npm-shrinkwrap.json'));

/** Manifest files present in the project (used for commits). */
export const presentManifestFiles = (cwd: string): string[] => MANIFEST_FILES.filter((f) => existsSync(join(cwd, f)));

/**
 * Captures the raw contents of all manifest files.
 */
export function snapshotManifests(cwd: string): ManifestSnapshot {
  const contents = new Map(
    MANIFEST_FILES.filter((f) => existsSync(join(cwd, f))).map((f) => [f, readFileSync(join(cwd, f))]),
  );
  return {
    restore() {
      for (const [file, data] of contents) writeFileSync(join(cwd, file), data);
    },
  };
}

/** Finds which dependency section declares `name`. */
export function findDependency(manifest: Manifest, name: string): { section: string; spec: string } | null {
  for (const section of Object.keys(DEPENDENCY_SECTIONS)) {
    const spec = manifest[section]?.[name];
    if (spec !== undefined) return { section, spec };
  }
  return null;
}
