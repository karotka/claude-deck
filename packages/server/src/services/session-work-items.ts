import { extractAllTags, type TagMention } from './tagging.js';
import type { Tracker, WorkItem } from '../trackers/types.js';

/**
 * How many secondary items to show. A long session touches dozens; a sidebar
 * that lists all of them is a wall, not a list, and the ones worth seeing are
 * the ones that come up most.
 */
export const MAX_SECONDARY = 8;

/** What a session said, split by who said it. */
export interface Conversation {
  /** Text from the person. */
  user: string;
  /** Everything said, theirs and Claude's. */
  all: string;
}

export interface SessionWorkItems {
  /** The primary first (with mentions 0, since it isn't derived from mentions). */
  tags: TagMention[];
  primary: string | null;
  items: Record<string, WorkItem>;
  trackerConfigured: boolean;
}

/**
 * The work a session touches: the item it was started for, plus the ones it
 * keeps coming back to.
 *
 * The two are found completely differently, which is why they are treated
 * differently:
 *
 * - The **primary** is not guessed. It comes from the name of the container or
 *   tmux session the work runs in, so it is reported whether or not a tracker
 *   exists and whether or not the transcript ever says it.
 * - Everything **else** is a string that looks like a key, and looking like one
 *   is not enough. A directory called `claude-502`, a `release-2`, a fragment of
 *   a UUID — nothing local separates those from a real key. So a secondary has
 *   to clear two bars: a tracker has to recognise it, and the session has to
 *   have come back to it. Without a tracker there are no secondaries at all,
 *   because there would be no way to be right.
 */
export async function sessionWorkItems(
  primary: string | null,
  conversation: Conversation,
  tracker: Tracker | null,
): Promise<SessionWorkItems> {
  const items: Record<string, WorkItem> = {};

  if (!tracker) {
    return {
      tags: primary ? [{ tag: primary, mentions: 0 }] : [],
      primary,
      items,
      trackerConfigured: false,
    };
  }

  // Only what the *person* raised. Claude echoing a key is not evidence the
  // session worked on it — a session about ticket handling quotes plenty, and
  // counting those filled the list with tickets it had nothing to do with.
  // Ranking is still by total mentions, since what gets worked on gets repeated.
  const raisedByUser = new Set(extractAllTags(conversation.user).map(t => t.tag));
  const candidates = extractAllTags(conversation.all)
    .filter(t => t.tag !== primary && raisedByUser.has(t.tag))
    .slice(0, MAX_SECONDARY);

  const lookup = [...(primary ? [primary] : []), ...candidates.map(t => t.tag)];
  if (lookup.length > 0) {
    for (const [tag, item] of await tracker.lookup(lookup)) items[tag] = item;
  }

  return {
    // The primary stays even when the tracker doesn't know it: the container is
    // named after it, which is a fact about this machine, not a claim about the
    // tracker's contents.
    tags: [
      ...(primary ? [{ tag: primary, mentions: 0 }] : []),
      ...candidates.filter(t => items[t.tag]),
    ],
    primary,
    items,
    trackerConfigured: true,
  };
}
