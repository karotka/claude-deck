import { describe, it, expect } from 'vitest';
import { workItemUrl, shortenItemLinks, linkifyItemKeys } from './work-item-url';

describe('workItemUrl', () => {
  const template = 'https://acme.atlassian.net/browse/{key}';

  it('builds a link from the template alone', () => {
    // The common case: the dashboard has been told where the tracker is but
    // given no token, so there is no fetched item to take a URL from.
    expect(workItemUrl('PROJ-12', template)).toBe('https://acme.atlassian.net/browse/PROJ-12');
  });

  it("prefers the tracker's own URL, which knows its format", () => {
    expect(workItemUrl('PROJ-12', template, 'https://elsewhere/x/PROJ-12'))
      .toBe('https://elsewhere/x/PROJ-12');
  });

  it('has no link without a template', () => {
    expect(workItemUrl('PROJ-12', undefined)).toBeNull();
    expect(workItemUrl('PROJ-12', '')).toBeNull();
  });

  it('refuses a template with nowhere to put the key', () => {
    // Better no link than every key pointing at the same page.
    expect(workItemUrl('PROJ-12', 'https://acme.atlassian.net/browse/')).toBeNull();
  });

  it('encodes the key, which comes out of a transcript', () => {
    expect(workItemUrl('A B/C', template)).toBe('https://acme.atlassian.net/browse/A%20B%2FC');
  });
});

describe('shortenItemLinks', () => {
  const pattern = '[A-Z][A-Z0-9]+-\\d+';

  it('leaves the key where a ticket URL was', () => {
    expect(shortenItemLinks(
      'podivej se na https://acme.atlassian.net/browse/PROJ-9371 a prostuduj',
      pattern,
    )).toBe('podivej se na PROJ-9371 a prostuduj');
  });

  it('takes the query and fragment with it', () => {
    expect(shortenItemLinks('see https://acme.atlassian.net/browse/PROJ-1?focus=x#c1 now', pattern))
      .toBe('see PROJ-1 now');
  });

  it('shortens several in one line', () => {
    expect(shortenItemLinks(
      'https://a/browse/AB-1 and https://b/browse/CD-22',
      pattern,
    )).toBe('AB-1 and CD-22');
  });

  it('leaves a URL that is not a ticket alone', () => {
    const url = 'https://example.com/docs/getting-started';
    expect(shortenItemLinks(url, pattern)).toBe(url);
  });

  it('does not cut a longer key down to a shorter one', () => {
    // PROJ-12 must not match inside PROJ-1234.
    expect(shortenItemLinks('https://a/browse/PROJ-1234', pattern)).toBe('PROJ-1234');
  });

  it('leaves the text alone with no pattern, or a broken one', () => {
    expect(shortenItemLinks('https://a/browse/AB-1', undefined)).toBe('https://a/browse/AB-1');
    expect(shortenItemLinks('https://a/browse/AB-1', '([')).toBe('https://a/browse/AB-1');
  });
});

describe('linkifyItemKeys', () => {
  const pattern = '[A-Z][A-Z0-9]+-\\d+';
  const template = 'https://acme.atlassian.net/browse/{key}';
  const run = (text: string) => linkifyItemKeys(text, pattern, template);

  it('makes a bare key clickable', () => {
    expect(run('Creating PROJ-1200 now'))
      .toBe('Creating [PROJ-1200](https://acme.atlassian.net/browse/PROJ-1200) now');
  });

  it('leaves a key that is already inside a link', () => {
    const already = '[PROJ-1](https://acme.atlassian.net/browse/PROJ-1)';
    expect(run(already)).toBe(already);
  });

  it('leaves a bare URL alone, so it is not linked twice', () => {
    const url = 'https://acme.atlassian.net/browse/PROJ-1';
    expect(run(url)).toBe(url);
  });

  it('leaves code alone, where a key is usually a branch or a filename', () => {
    expect(run('run `git checkout PROJ-44` first'))
      .toBe('run `git checkout PROJ-44` first');
    expect(run('```\nPROJ-1\n```')).toBe('```\nPROJ-1\n```');
  });

  it('links a longer key whole rather than a prefix of it', () => {
    // The failure to avoid is PROJ-1200 matching inside PROJ-12001 and
    // pointing at a different ticket.
    expect(run('PROJ-12001'))
      .toBe('[PROJ-12001](https://acme.atlassian.net/browse/PROJ-12001)');
  });

  it('does not link a key that runs into a word', () => {
    expect(run('PROJ-1x and xPROJ-1')).toBe('PROJ-1x and xPROJ-1');
  });

  it('does nothing without somewhere to point', () => {
    expect(linkifyItemKeys('PROJ-1', pattern, undefined)).toBe('PROJ-1');
    expect(linkifyItemKeys('PROJ-1', undefined, template)).toBe('PROJ-1');
  });
});
