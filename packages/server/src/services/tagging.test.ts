import { describe, it, expect, vi, afterEach } from 'vitest';

/** Re-import tagging.ts with a given TAG_PATTERN in the environment. */
async function withPattern(pattern?: string) {
  if (pattern === undefined) delete process.env.TAG_PATTERN;
  else process.env.TAG_PATTERN = pattern;
  vi.resetModules();
  return import('./tagging.js');
}

afterEach(() => {
  delete process.env.TAG_PATTERN;
  vi.resetModules();
});

describe('the default pattern', () => {
  it('recognises a whole tag and rejects a partial one', async () => {
    const { isTag } = await withPattern();
    expect(isTag('PROJ-1234')).toBe(true);
    expect(isTag('proj-1234')).toBe(true);
    expect(isTag('PROJ-')).toBe(false);
    expect(isTag('1234')).toBe(false);
    // Anchored: a tag inside a sentence is not itself a tag.
    expect(isTag('resolve PROJ-1234 now')).toBe(false);
  });

  it('takes the first tag in free text, so a later mention cannot win', async () => {
    const { extractTag } = await withPattern();
    expect(extractTag('resolve PROJ-8008, related to OPS-1')).toBe('PROJ-8008');
    expect(extractTag('just chatting')).toBeNull();
    expect(extractTag(null)).toBeNull();
  });

  it('matches a tag run into the next word, as real prompts do', async () => {
    // "resolve PROJ-9114check the messages" happens; requiring a word boundary
    // after the tag loses the match and the session goes unattributed.
    const { extractTag } = await withPattern();
    expect(extractTag('resolve PROJ-9114check agent messages')).toBe('PROJ-9114');
  });

  it('parses a pasted batch, deduped and in first-seen order', async () => {
    const { parseTags } = await withPattern();
    expect(parseTags('PROJ-1, proj-1\nOPS-3 nonsense PROJ-')).toEqual(['PROJ-1', 'OPS-3']);
    expect(parseTags('')).toEqual([]);
  });
});

describe('a configured pattern', () => {
  it('changes what the whole app treats as a tag', async () => {
    // The point of the refactor: one setting, and the container matcher, the
    // launch validator and the tracker lookup all follow.
    const { isTag, extractTag, parseTags } = await withPattern('#\\d+');
    expect(isTag('#42')).toBe(true);
    expect(isTag('PROJ-1234')).toBe(false);
    expect(extractTag('fixes #42 and #7')).toBe('#42');
    expect(parseTags('#42 #7 PROJ-1')).toEqual(['#42', '#7']);
  });
});

describe('extractAllTags', () => {
  it('ranks by how often a tag comes up, not where it first appears', async () => {
    // What a session is really working on gets mentioned over and over; a
    // coincidence gets mentioned once. That is the only signal that separates
    // them, because shape cannot.
    const { extractAllTags } = await withPattern();
    const text = 'ONCE-1 then PROJ-9 and PROJ-9 again, PROJ-9 once more';
    expect(extractAllTags(text)).toEqual([
      { tag: 'PROJ-9', mentions: 3 },
      { tag: 'ONCE-1', mentions: 1 },
    ]);
  });

  it('does not mine keys out of the middle of a UUID', async () => {
    // The whole reason this is bounded where extractTag is not: over a full
    // transcript, "e4065434-b688-44a4-9e43" yielded "B688-44" and "A4-9".
    const { extractAllTags } = await withPattern();
    expect(extractAllTags('id e4065434-b688-44a4-9e43-f69c49c4dc99 here')).toEqual([]);
  });

  it('does not mine keys out of a longer hyphenated token', async () => {
    const { extractAllTags } = await withPattern();
    expect(extractAllTags('see FOO-1-BAR and v1.2.3-rc1 and 9.9-beta2')).toEqual([]);
  });

  it('cannot tell a key from a lookalike, and does not pretend to', async () => {
    // "release-2" is a real key by shape: correct prefix, correct suffix,
    // whitespace either side. So is a directory named "claude-502". Nothing
    // short of asking a tracker separates them, which is why the caller ranks
    // by mentions and defers to one when it has it.
    const { extractAllTags } = await withPattern();
    expect(extractAllTags('see release-2').map(t => t.tag)).toEqual(['RELEASE-2']);
  });

  it('finds a key surrounded by ordinary punctuation', async () => {
    const { extractAllTags } = await withPattern();
    expect(extractAllTags('(PROJ-1), [PROJ-2]; "PROJ-3" /PROJ-4/').map(t => t.tag))
      .toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3', 'PROJ-4']);
  });

  it('follows the configured pattern like everything else', async () => {
    const { extractAllTags } = await withPattern('#\\d+');
    expect(extractAllTags('fixes #42, see #42 and #7').map(t => t.tag)).toEqual(['#42', '#7']);
  });

  it('has nothing to say about empty input', async () => {
    const { extractAllTags } = await withPattern();
    expect(extractAllTags('')).toEqual([]);
    expect(extractAllTags(null)).toEqual([]);
  });
});

describe('tagFromName', () => {
  it('strips the configured prefix and upper-cases the rest', async () => {
    const { tagFromName } = await withPattern();
    expect(tagFromName('jira-agent-proj-9152', 'jira-agent-')).toBe('PROJ-9152');
  });

  it('yields nothing for a name that does not carry the prefix', async () => {
    // Sessions the app launches itself use a different prefix precisely so they
    // never produce a tag and never get matched to someone's ticket.
    const { tagFromName } = await withPattern();
    expect(tagFromName('cm-7a574cae', 'jira-agent-')).toBe('');
  });

  it('does not validate against the pattern', async () => {
    // The name is authoritative about what it was created for. Rejecting it
    // here would disconnect a container from its own card the moment someone's
    // naming scheme and tag pattern drift apart.
    const { tagFromName } = await withPattern();
    expect(tagFromName('jira-agent-weird_name', 'jira-agent-')).toBe('WEIRD_NAME');
  });
});

describe('messageClaimsTag', () => {
  it('accepts a prompt that names the tag, however it is cased or run together', async () => {
    const { messageClaimsTag } = await withPattern();
    expect(messageClaimsTag('resolve proj-9114check messages', 'PROJ-9114')).toBe(true);
  });

  it('rejects an unrelated prompt, which is what stops a wrong card appearing', async () => {
    // Containers that bind-mount the host ~/.claude hand back the newest *host*
    // session. Attributing that to the container shows someone else's work.
    const { messageClaimsTag } = await withPattern();
    expect(messageClaimsTag('resolve PROJ-2', 'PROJ-1')).toBe(false);
    expect(messageClaimsTag(null, 'PROJ-1')).toBe(false);
    expect(messageClaimsTag('resolve PROJ-1', '')).toBe(false);
  });
});
