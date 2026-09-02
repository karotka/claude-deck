import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { isTag } from './tagging.js';
import type { GroupsConfig, PhaseConfig, PhaseSignal, WorkflowConfig } from '../config-file.js';

/**
 * Progress read off a directory of files.
 *
 * An agent workflow that writes artifacts as it goes — analysis.md, then a
 * design, then a PR link per repo — has its state on disk already, and this
 * turns that into a progress view. Which files mean what used to be hardcoded:
 * six named phases, four filenames per repo, and a hand-written completion rule
 * involving `investigation.md`. That described exactly one team's workflow and
 * nobody else's.
 *
 * Now the workflow is declared in claude-deck.config.json and this file only
 * knows how to evaluate a declaration. With none configured, the feature is off.
 */

export interface PhaseState {
  label: string;
  done: boolean;
  /** Part of the linear chain (see WorkflowConfig). */
  linear: boolean;
}

export interface GroupState {
  name: string;
  /** Signal label → whether its file is present. Keys come from the config. */
  signals: Record<string, boolean>;
  /**
   * Contents of the last signal file that has any, so a PR link or a summary
   * can be shown inline. Null when nothing readable was found.
   */
  detail: string | null;
}

export interface WorkItemArtifacts {
  tag: string;
  dir: string;
  /** Index into `phases` of the phase currently in progress. */
  phase: number;
  phaseLabel: string;
  phases: PhaseState[];
  groups: GroupState[];
  /** What one group is called, from the config; absent when unset. */
  groupNoun?: string;
}

/** A file that exists and isn't empty. An empty stub means "not done yet". */
async function hasContent(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).size > 0;
  } catch {
    return false;
  }
}

async function readOrNull(p: string): Promise<string | null> {
  try {
    return await fsp.readFile(p, 'utf-8');
  } catch {
    return null;
  }
}

async function readGroups(dir: string, groups: GroupsConfig): Promise<GroupState[]> {
  const groupsDir = path.join(dir, groups.dir);
  let names: string[];
  try {
    names = await fsp.readdir(groupsDir);
  } catch {
    return [];
  }

  const result: GroupState[] = [];
  for (const name of names.sort()) {
    const groupDir = path.join(groupsDir, name);
    try {
      if (!(await fsp.stat(groupDir)).isDirectory()) continue;
    } catch {
      continue;
    }

    const signals: Record<string, boolean> = {};
    let detail: string | null = null;
    for (const [label, file] of Object.entries(groups.signals)) {
      const filePath = path.join(groupDir, file);
      const present = await hasContent(filePath);
      signals[label] = present;
      if (present) detail = (await readOrNull(filePath))?.trim() || detail;
    }
    result.push({ name, signals, detail });
  }
  return result;
}

/**
 * Whether one phase's signal is satisfied.
 *
 * `{everyGroup: file}` is the interesting case: the phase is done when every
 * group carries that file — and never when there are no groups at all, since
 * "all zero of them shipped" is not progress.
 */
async function signalMet(
  dir: string,
  signal: PhaseSignal,
  groups: GroupState[],
  groupsConfig: GroupsConfig | undefined,
): Promise<boolean> {
  if (typeof signal === 'string') return hasContent(path.join(dir, signal));
  if (Array.isArray(signal)) {
    for (const candidate of signal) {
      if (await hasContent(path.join(dir, candidate))) return true;
    }
    return false;
  }
  if (!groupsConfig) return false;
  const label = Object.entries(groupsConfig.signals)
    .find(([, file]) => file === signal.everyGroup)?.[0];
  if (!label) return false;
  return groups.length > 0 && groups.every(g => g.signals[label]);
}

/**
 * Evaluate one item's directory against the configured workflow.
 *
 * Two rules make the result read the way a person would read it:
 *
 * - Reaching a later linear phase implies the earlier ones. A pushed PR means
 *   the design was agreed, whether or not anyone wrote the file that says so —
 *   otherwise a workflow that skips a step shows as stuck at step two forever.
 * - Non-linear phases are side tracks. They can happen at any time, or never,
 *   and never hold up the current-phase calculation.
 */
export async function readArtifacts(
  dir: string,
  tag: string,
  workflow: WorkflowConfig,
): Promise<WorkItemArtifacts> {
  const groups = workflow.groups ? await readGroups(dir, workflow.groups) : [];

  const phases: PhaseState[] = [];
  for (const phase of workflow.phases as PhaseConfig[]) {
    phases.push({
      label: phase.label,
      linear: phase.linear !== false,
      done: await signalMet(dir, phase.signal, groups, workflow.groups),
    });
  }

  const linearIdx = phases.map((p, i) => (p.linear ? i : -1)).filter(i => i >= 0);
  const lastDone = linearIdx.filter(i => phases[i].done).pop();
  if (lastDone !== undefined) {
    for (const i of linearIdx) if (i < lastDone) phases[i].done = true;
  }

  // The current phase is the first linear one still outstanding; if none are,
  // the work is finished and we stay on the last linear phase rather than
  // running off the end.
  const lastLinear = linearIdx[linearIdx.length - 1] ?? 0;
  const current = linearIdx.find(i => !phases[i].done) ?? lastLinear;

  return {
    tag,
    dir,
    phase: current,
    phaseLabel: phases[current]?.label ?? '',
    phases,
    groups,
    ...(workflow.groups?.noun ? { groupNoun: workflow.groups.noun } : {}),
  };
}

/**
 * Every item with an artifact directory.
 *
 * Returns nothing at all unless both halves are configured — a directory to
 * read and a workflow describing what is in it. Neither has a sensible default:
 * the filenames belong to whatever writes them.
 */
export async function scanArtifacts(): Promise<WorkItemArtifacts[]> {
  const dir = config.issueSessionsDir;
  const workflow = config.workflow;
  if (!dir || !workflow) return [];

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }

  const items: WorkItemArtifacts[] = [];
  for (const name of entries) {
    if (!isTag(name)) continue;
    const itemDir = path.join(dir, name);
    try {
      if (!(await fsp.stat(itemDir)).isDirectory()) continue;
      items.push(await readArtifacts(itemDir, name.toUpperCase(), workflow));
    } catch {
      continue;
    }
  }

  // Least-progressed first: what still needs attention sits at the top.
  items.sort((a, b) => a.phase - b.phase || a.tag.localeCompare(b.tag));
  return items;
}
