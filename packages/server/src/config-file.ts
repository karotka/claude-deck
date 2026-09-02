import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The optional `claude-deck.config.json`.
 *
 * Environment variables cover every scalar setting and always win, which is
 * enough for a single install with one Jira and one launch script. What they
 * cannot express is a *list* of things — several launchers, a workflow's phases
 * — without inventing a delimiter-separated encoding that nobody can read. Those
 * live here; everything else stays available in both places so an existing .env
 * keeps working untouched.
 *
 * The file is optional, and so is every key in it.
 */

/** How to recognise the short identifier a session belongs to. */
export interface TagConfig {
  /**
   * Regular expression source (no anchors, no flags) matching one tag. The
   * default is the Jira/Linear key shape. Anchored forms are derived from it,
   * so a pattern with its own `^`/`$` will not behave.
   */
  pattern?: string;
}

/** A file whose presence marks a workflow step as done. */
export type PhaseSignal =
  /** A path under the item's directory. */
  | string
  /** Any one of these paths. */
  | string[]
  /** Every group directory (see WorkflowConfig.groups) must carry this file. */
  | { everyGroup: string };

export interface PhaseConfig {
  label: string;
  signal: PhaseSignal;
  /**
   * Part of the linear chain, so reaching a later phase implies this one. Side
   * tracks that may happen at any time — or never — set this false and are
   * skipped when working out the current phase. Defaults to true.
   */
  linear?: boolean;
}

/**
 * Repeated sub-units of an item's work, one directory each: the repos a change
 * touches, the services it is rolled out to, whatever the workflow's unit is.
 */
export interface GroupsConfig {
  /** Directory under the item holding one subdirectory per group. */
  dir: string;
  /** Display name for one group, e.g. "repo". */
  noun?: string;
  /** Column label → file whose presence ticks it. */
  signals: Record<string, string>;
}

export interface WorkflowConfig {
  phases: PhaseConfig[];
  groups?: GroupsConfig;
}

export interface LauncherConfig {
  /** Stable id; also the value the launch API takes. */
  id: string;
  /** Button text. */
  label: string;
  /**
   * Command to run, with `{{tag}}` substituted. Passed to the shell as an
   * argv array, so no quoting rules apply and nothing is re-parsed.
   */
  command: string[];
  /** Placeholder for the input, e.g. "Issue key". */
  inputLabel?: string;
  /** Longer help text under the input. */
  description?: string;
  /** Name prefix for the container this launcher produces, if it makes one. */
  containerPrefix?: string;
  /** tmux session name prefix for the launch itself. */
  launchPrefix?: string;
  /** Runs the work somewhere other than this machine. */
  remote?: boolean;
}

export interface DeckConfigFile {
  tag?: TagConfig;
  workflow?: WorkflowConfig;
  launchers?: LauncherConfig[];
}

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// src/ in dev, dist/ after a build — two levels up either way.
const repoRoot = path.resolve(moduleDir, '../..');

export const CONFIG_FILE_NAME = 'claude-deck.config.json';

/** Where a config file is looked for, in order. First one that exists wins. */
export function configFileCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const explicit = env.CLAUDE_DECK_CONFIG?.trim();
  if (explicit) {
    return [explicit.startsWith('~/') ? path.join(os.homedir(), explicit.slice(2)) : explicit];
  }
  return [
    path.join(process.cwd(), CONFIG_FILE_NAME),
    path.join(repoRoot, CONFIG_FILE_NAME),
  ];
}

export interface LoadedConfigFile {
  /** Absent when no file was found — which is a supported way to run. */
  path: string | null;
  values: DeckConfigFile;
}

/**
 * Read the config file, if there is one.
 *
 * A malformed file throws rather than being silently ignored: a typo in a
 * launcher definition should stop the server with the parse error, not start it
 * with the launcher quietly missing.
 */
export function loadConfigFile(env: NodeJS.ProcessEnv = process.env): LoadedConfigFile {
  for (const candidate of configFileCandidates(env)) {
    let raw: string;
    try {
      raw = fs.readFileSync(candidate, 'utf-8');
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `${candidate} is not valid JSON: ${err instanceof Error ? err.message : err}`,
      );
    }
    return { path: candidate, values: validate(parsed, candidate) };
  }
  return { path: null, values: {} };
}

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

/**
 * Check the shapes the rest of the server relies on. Not a full schema — the
 * point is to turn "my launcher doesn't appear" into a startup error naming the
 * key, rather than a silent no-op three screens later.
 */
function validate(parsed: unknown, file: string): DeckConfigFile {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail(file, 'must contain a JSON object');
  }
  const values = parsed as DeckConfigFile;

  if (values.tag?.pattern !== undefined) {
    if (typeof values.tag.pattern !== 'string') fail(file, 'tag.pattern must be a string');
    try {
      new RegExp(values.tag.pattern);
    } catch (err) {
      fail(file, `tag.pattern is not a valid regular expression: ${err}`);
    }
  }

  if (values.workflow !== undefined) {
    const phases = values.workflow.phases;
    if (!Array.isArray(phases) || phases.length === 0) {
      fail(file, 'workflow.phases must be a non-empty array');
    }
    for (const [i, phase] of phases.entries()) {
      if (typeof phase?.label !== 'string' || !phase.label) {
        fail(file, `workflow.phases[${i}].label must be a non-empty string`);
      }
      if (!isPhaseSignal(phase.signal)) {
        fail(
          file,
          `workflow.phases[${i}].signal must be a path, a list of paths, or {"everyGroup": path}`,
        );
      }
    }
    const groups = values.workflow.groups;
    if (groups !== undefined) {
      if (typeof groups.dir !== 'string' || !groups.dir) {
        fail(file, 'workflow.groups.dir must be a non-empty string');
      }
      if (!groups.signals || typeof groups.signals !== 'object') {
        fail(file, 'workflow.groups.signals must be an object of label → filename');
      }
    }
    const needsGroups = phases.some(
      p => typeof p.signal === 'object' && !Array.isArray(p.signal),
    );
    if (needsGroups && !groups) {
      fail(file, 'a phase uses "everyGroup" but workflow.groups is not configured');
    }
  }

  if (values.launchers !== undefined) {
    if (!Array.isArray(values.launchers)) fail(file, 'launchers must be an array');
    const ids = new Set<string>();
    for (const [i, launcher] of values.launchers.entries()) {
      if (typeof launcher?.id !== 'string' || !launcher.id) {
        fail(file, `launchers[${i}].id must be a non-empty string`);
      }
      if (ids.has(launcher.id)) fail(file, `launchers[${i}].id "${launcher.id}" is not unique`);
      ids.add(launcher.id);
      if (typeof launcher.label !== 'string' || !launcher.label) {
        fail(file, `launchers[${i}].label must be a non-empty string`);
      }
      if (
        !Array.isArray(launcher.command) ||
        launcher.command.length === 0 ||
        launcher.command.some(part => typeof part !== 'string')
      ) {
        fail(file, `launchers[${i}].command must be a non-empty array of strings`);
      }
    }
  }

  return values;
}

function isPhaseSignal(signal: unknown): signal is PhaseSignal {
  if (typeof signal === 'string') return !!signal;
  if (Array.isArray(signal)) return signal.length > 0 && signal.every(s => typeof s === 'string');
  if (signal && typeof signal === 'object') {
    return typeof (signal as { everyGroup?: unknown }).everyGroup === 'string';
  }
  return false;
}
