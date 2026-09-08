import { describe, it, expect } from 'vitest';
import { trustedFrom, bestLaunchDir } from './trusted-dirs.js';

describe('trustedFrom', () => {
  it('keeps only the directories actually marked trusted', () => {
    expect(trustedFrom({
      projects: {
        '/a': { hasTrustDialogAccepted: true },
        '/b': { hasTrustDialogAccepted: false },
        '/c': {},
      },
    })).toEqual(['/a']);
  });

  it('will not take a truthy value for the flag', () => {
    // It gates whether a folder gets read, edited and executed in. Only the
    // literal answer counts.
    expect(trustedFrom({ projects: { '/a': { hasTrustDialogAccepted: 'yes' } } })).toEqual([]);
    expect(trustedFrom({ projects: { '/a': { hasTrustDialogAccepted: 1 } } })).toEqual([]);
  });

  it('ignores entries that are not absolute paths', () => {
    expect(trustedFrom({
      projects: { 'not-a-path': { hasTrustDialogAccepted: true } },
    })).toEqual([]);
  });

  it('says nothing rather than throwing on a shape it does not know', () => {
    // An undocumented internal: less detail is fine, a crash is not.
    expect(trustedFrom(null)).toEqual([]);
    expect(trustedFrom({})).toEqual([]);
    expect(trustedFrom({ projects: 'nope' })).toEqual([]);
  });
});

describe('bestLaunchDir', () => {
  it('keeps the configured directory when starting there will work', () => {
    expect(bestLaunchDir('/a', ['/b', '/a'])).toBe('/a');
  });

  it('offers a trusted one when the configured directory is not', () => {
    // The home directory is the usual case: an obvious fallback, almost never
    // trusted, and the worst thing to be asked to trust.
    expect(bestLaunchDir('/Users/me', ['/Users/me/git'])).toBe('/Users/me/git');
  });

  it('falls back to the configured one when nothing is trusted', () => {
    expect(bestLaunchDir('/a', [])).toBe('/a');
  });
});
