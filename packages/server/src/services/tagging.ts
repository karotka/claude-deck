import { config } from '../config.js';

/**
 * The one place that knows what a tag looks like.
 *
 * A tag is the short identifier a session belongs to — a Jira key by default,
 * but that is only the default. Six places used to carry their own copy of
 * `/[A-Z][A-Z0-9]+-\d+/`: the container matcher, the tmux matcher, the launch
 * validator, the tracker's key normaliser, the artifact directory filter, and
 * the UI's paste parser. Changing the scheme meant finding all six and hoping.
 * They all call in here now, and the pattern comes from configuration.
 */

/** Cache the compiled forms; the pattern is fixed for the process's lifetime. */
let compiled: { source: string; exact: RegExp; search: RegExp } | null = null;

function regexes(): { exact: RegExp; search: RegExp } {
  if (compiled?.source !== config.tagPattern) {
    compiled = {
      source: config.tagPattern,
      exact: new RegExp(`^(?:${config.tagPattern})$`),
      // \b would not fire for a pattern ending in a non-word character, and a
      // real prompt runs the tag straight into the next word often enough
      // ("resolve PROJ-9114check the messages") that requiring one loses matches.
      search: new RegExp(`(?:${config.tagPattern})`),
    };
  }
  return compiled;
}

/** Whether the whole string is a tag. */
export function isTag(value: string): boolean {
  return regexes().exact.test(value.trim().toUpperCase());
}

/**
 * The first tag in free-form text, or null. Used to tie a session to a piece of
 * work through its opening prompt ("resolve PROJ-8008" → "PROJ-8008"). Only the
 * first match, so a later mention of something else cannot win.
 */
export function extractTag(text: string | null | undefined): string | null {
  if (!text) return null;
  return regexes().search.exec(text.toUpperCase())?.[0] ?? null;
}

/**
 * The tag a resource name carries once its prefix is taken off:
 * "jira-agent-proj-9152" with prefix "jira-agent-" → "PROJ-9152". Empty when
 * the name doesn't start with the prefix, which is how sessions launched by the
 * app itself — deliberately given a different prefix — produce no tag.
 *
 * Deliberately not validated against the pattern: the name is authoritative
 * about what it was created for, and rejecting it here would silently
 * disconnect a container from its own card if someone's naming scheme and tag
 * pattern ever drift apart.
 */
export function tagFromName(name: string, prefix: string): string {
  return name.startsWith(prefix) ? name.slice(prefix.length).toUpperCase() : '';
}

/**
 * Split free-form input into unique tags, first-seen order preserved. Commas,
 * spaces and newlines all separate, so a pasted batch works. Tokens that aren't
 * a whole tag are dropped.
 */
export function parseTags(input: string): string[] {
  const seen = new Set<string>();
  for (const token of input.split(/[\s,]+/)) {
    const tag = token.trim().toUpperCase();
    if (tag && isTag(tag)) seen.add(tag);
  }
  return [...seen];
}

/** One candidate tag found in a transcript, with how often it came up. */
export interface TagMention {
  tag: string;
  mentions: number;
}

/**
 * Every tag mentioned in a body of text, most-mentioned first.
 *
 * Two things separate this from `extractTag`, which answers "what is this
 * session *about*" from a single short prompt:
 *
 * - **Word boundaries.** `extractTag` deliberately matches unbounded, because a
 *   real prompt runs the key into the next word ("resolve PROJ-9114check"). Over
 *   a whole transcript that is a disaster: a UUID like
 *   e4065434-b688-44a4-9e43 yields "B688-44" and "A4-9", and a path yields
 *   worse. Requiring that no letter, digit or dash sits on either side removes
 *   those without losing a real key, which is always surrounded by punctuation
 *   or space.
 * - **Counts.** Shape alone cannot tell a key from a lookalike — "CLAUDE-502"
 *   is a directory name here and matches any pattern a real key does. What
 *   separates them is that the work a session is actually doing gets mentioned
 *   dozens of times and a coincidence gets mentioned once, so the caller ranks
 *   rather than filters, and defers to a tracker when there is one.
 */
export function extractAllTags(text: string | null | undefined): TagMention[] {
  if (!text) return [];
  // Fresh per call: /g carries lastIndex, so a shared regex would skip matches
  // on the next call.
  const bounded = new RegExp(
    `(?<![A-Za-z0-9-])(?:${config.tagPattern})(?![A-Za-z0-9-])`,
    'g',
  );
  const counts = new Map<string, number>();
  for (const match of text.toUpperCase().matchAll(bounded)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, mentions]) => ({ tag, mentions }))
    .sort((a, b) => b.mentions - a.mentions || a.tag.localeCompare(b.tag));
}

/**
 * Whether a session's opening prompt claims the given tag.
 *
 * Guards against the shared-`~/.claude` bind mount: some containers mount the
 * host's, so "the newest session read from inside the container" is really the
 * newest *host* session — often an unrelated one. Attributing that to the
 * container both shows a wrong card and poisons the sticky-assignment map.
 *
 * Substring rather than a bounded match, for the same reason `search` above is
 * unbounded: real prompts run the tag into the next word.
 */
export function messageClaimsTag(
  firstUserMessage: string | null | undefined,
  tag: string,
): boolean {
  if (!tag) return false;
  return (firstUserMessage ?? '').toUpperCase().includes(tag.toUpperCase());
}
