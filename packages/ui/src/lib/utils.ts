import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ContainerLocation, ManagedContainer, Session, WorkItem } from './api';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function formatCost(cost: number): string {
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

export function timeAgo(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  const diffMs = now - then;

  if (diffMs < 0) return 'just now';

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + '\u2026';
}

export function projectName(projectPath: string): string {
  const parts = projectPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || projectPath;
}

/**
 * Headline for a session that runs somewhere other than a plain shell on this
 * machine, naming where. Returns null for local sessions, whose project name is
 * the better headline.
 *
 * Built from the target rather than a per-source branch: whatever a provider
 * put in `label` (or, failing that, the handle it addresses the session by) is
 * what there is to say about where the session lives.
 */
export function containerLabel(session: Session): string | null {
  const target = session.target;
  if (!target || target.kind === 'tmux') return null;
  const name = target.label ?? target.ref;
  return `${capitalize(target.kind)}: ${name}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Split free-form text into unique tags, first-seen order preserved. Commas,
 * spaces and newlines all separate, so a pasted or hand-typed batch works.
 * Tokens that aren't a whole tag are dropped.
 *
 * `pattern` is the server's — what a tag looks like is configuration, and the
 * UI must not carry a second opinion about it. An unset or unparseable pattern
 * accepts nothing rather than falling back to a guess, so a misconfiguration
 * shows as "no valid keys" instead of launching something unintended.
 */
export function parseTags(input: string, pattern: string | undefined): string[] {
  if (!pattern) return [];
  let exact: RegExp;
  try {
    exact = new RegExp(`^(?:${pattern})$`);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const token of input.split(/[\s,]+/)) {
    const tag = token.trim().toUpperCase();
    if (!tag || !exact.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/**
 * Pick the containers whose work item is finished. Used by the Docker page to
 * bulk-close every container whose ticket is done. Containers with no tag, or
 * whose tag has no item fetched yet, are never targets — "unknown" must never
 * read as "safe to remove".
 */
export function containersWithFinishedWork(
  containers: ManagedContainer[],
  items: Record<string, WorkItem>,
): ManagedContainer[] {
  return containers.filter(
    (c) => c.issueKey != null && items[c.issueKey]?.state === 'done',
  );
}

export interface ContainerFilters {
  state: 'all' | 'running' | 'exited';
  location: 'all' | ContainerLocation;
  hiddenOnly: boolean;
}

/** The Docker page's three filters, applied together. */
export function filterContainers(
  containers: ManagedContainer[],
  filters: ContainerFilters,
): ManagedContainer[] {
  return containers.filter((c) => {
    if (filters.state !== 'all' && c.state !== filters.state) return false;
    if (filters.location !== 'all' && c.location !== filters.location) return false;
    if (filters.hiddenOnly && !c.hiddenInApp) return false;
    return true;
  });
}

/**
 * The extra line a confirmation dialog needs when any target lives on the VM:
 * removing there also drops the container's session volume, so the transcript
 * goes with it. Removing locally leaves the volume alone. Empty when no VM
 * container is involved.
 */
export function vmRemovalWarning(targets: ManagedContainer[]): string {
  const onVm = targets.filter((c) => c.location === 'vm').length;
  if (onVm === 0) return '';
  return `\n\nWARNING: ${onVm} of these run on the VM — removing them also deletes each container's session volume, so its transcript is lost.`;
}
