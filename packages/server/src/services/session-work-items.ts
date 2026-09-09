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

  // Only what the *person* raised. Claude echoing a key is not evidence the
  // session worked on it — a session about ticket handling quotes plenty, and
  // counting those filled the list with tickets it had nothing to do with.
  // Ranking is still by total mentions, since what gets worked on gets repeated.
  const raisedByUser = new Set(extractAllTags(conversation.user).map(t => t.tag));
  const mentioned = extractAllTags(conversation.all).filter(t => t.tag !== primary);

  /*
   * Two ways to earn a place, and the second one needs the tracker.
   *
   * The person raising a key is evidence on its own. So is a key Claude
   * returned to several times *and* the tracker confirms — which is the case
   * this missed entirely: a session asked to open six tickets is told the six
   * keys by Claude, and the person never types any of them, so requiring them
   * to had that session showing none of its own work.
   *
   * Two guards on the second route, and both are needed. Confirmation keeps
   * out what does not exist: a string that merely looks like a key, or one
   * quoted from elsewhere, fails the lookup. The threshold keeps out what does
   * exist but has nothing to do with the session — a key quoted once or twice
   * in passing. A ticket a session actually worked on gets named when it is
   * made, again in the summary, and again when it is linked.
   *
   * It remains a trade rather than a test: a session *about* tickets that
   * dwells on a real one will list it. It appears below the primary, as a
   * mention with its count, which is the honest description of what is known.
   */
  const MENTIONS_WITHOUT_THE_USER = 3;
  const candidates = mentioned
    .filter(t => raisedByUser.has(t.tag)
      || (tracker !== null && t.mentions >= MENTIONS_WITHOUT_THE_USER))
    .slice(0, MAX_SECONDARY);

  if (!tracker) {
    /*
     * Without a tracker these are still worth listing, which they were not
     * before: a session that opened six tickets showed none of them.
     *
     * The rule that hid them conflated two different claims. "This ticket
     * exists, and its status is X" needs a tracker and cannot be had without
     * one. "The person wrote this key in this session" is a fact about the
     * transcript, and it is the one being shown — with its mention count, and
     * without a status badge, so it says what it knows and no more.
     */
    return {
      tags: [
        ...(primary ? [{ tag: primary, mentions: 0 }] : []),
        ...candidates,
      ],
      primary,
      items,
      trackerConfigured: false,
    };
  }

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
