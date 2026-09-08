import { describe, it, expect } from 'vitest';
import { cloudHandle } from './claude-launcher.js';

/**
 * `cloudHandle` is an injection guard, not a parser: what it returns is typed
 * into a shell, because `claude` is usually a shell function and cannot be run
 * as argv. So the tests that matter are the ones that try to get through it.
 */
describe('cloudHandle', () => {
  it('accepts the URL you copy from the address bar', () => {
    expect(cloudHandle('https://claude.ai/code/session_01BKxRdk93D8eKxw9xqeV9Xd'))
      .toBe('https://claude.ai/code/session_01BKxRdk93D8eKxw9xqeV9Xd');
  });

  it('accepts the bare id, which --cloud also takes', () => {
    expect(cloudHandle('session_01BKxRdk93D8eKxw9xqeV9Xd'))
      .toBe('session_01BKxRdk93D8eKxw9xqeV9Xd');
  });

  it('trims, since a pasted URL often brings whitespace', () => {
    expect(cloudHandle('  https://claude.ai/code/abc123def  '))
      .toBe('https://claude.ai/code/abc123def');
  });

  it('drops a trailing slash rather than passing it on', () => {
    expect(cloudHandle('https://claude.ai/code/abc123def/')).toBe('https://claude.ai/code/abc123def');
  });

  it.each([
    ['a command chained on the end', 'https://claude.ai/code/abc123def; rm -rf ~'],
    ['a substitution', 'https://claude.ai/code/$(whoami)'],
    ['backticks', 'https://claude.ai/code/`id`'],
    ['a pipe', 'https://claude.ai/code/abc123 | sh'],
    ['an ampersand', 'https://claude.ai/code/abc&whoami'],
    ['a newline carrying a second command', 'https://claude.ai/code/abc123def\nwhoami'],
    ['a quote to break out of', "https://claude.ai/code/abc'; whoami; '"],
    ['a redirect', 'https://claude.ai/code/abc123 > /tmp/x'],
  ])('refuses %s', (_label, value) => {
    expect(cloudHandle(value)).toBeNull();
  });

  it.each([
    ['plain http', 'http://claude.ai/code/abc123def'],
    ['another host', 'https://claude.ai.evil.example/code/abc123def'],
    ['a lookalike host', 'https://claudeXai/code/abc123def'],
    ['a path outside /code', 'https://claude.ai/chat/abc123def'],
    ['a deeper path', 'https://claude.ai/code/abc123def/extra'],
    ['a query string', 'https://claude.ai/code/abc123def?x=1'],
  ])('refuses %s', (_label, value) => {
    expect(cloudHandle(value)).toBeNull();
  });

  it('refuses an id too short to be one, and empty input', () => {
    expect(cloudHandle('abc')).toBeNull();
    expect(cloudHandle('')).toBeNull();
    expect(cloudHandle('   ')).toBeNull();
  });

  it('refuses an id long enough to be a payload', () => {
    expect(cloudHandle('a'.repeat(129))).toBeNull();
  });
});
