import { describe, it, expect } from 'vitest';
import { splitPane } from './terminal';

const RULE = '─'.repeat(60);
const TITLED = `${'─'.repeat(40)} Browse ML ranker ─`;

function pane(...lines: string[]): string {
  return lines.join('\n') + '\n';
}

describe('splitPane', () => {
  it('separates the conversation from the status footer', () => {
    const { body, status } = splitPane(pane(
      'Some output from Claude.',
      'More output.',
      TITLED,
      '❯ ',
      RULE,
      '  Model: Opus 5 | Ctx: 736.4k | Weekly: 0.0% | Reset: 4hr 30m',
      '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent',
    ));
    expect(body).toBe('Some output from Claude.\nMore output.');
    expect(status).toEqual([
      '  Model: Opus 5 | Ctx: 736.4k | Weekly: 0.0% | Reset: 4hr 30m',
      '  ⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent',
    ]);
  });

  it('drops the TUI\'s own input box, which the panel replaces', () => {
    // Leaving it would show two prompts, one of which cannot be typed into.
    const { body } = splitPane(pane('output', TITLED, '❯ hello', RULE, '  Model: Opus 5'));
    expect(body).not.toContain('❯');
  });

  it('copes with a footer of one line', () => {
    const { status } = splitPane(pane('output', TITLED, '❯ ', RULE, '  Model: Opus 5'));
    expect(status).toEqual(['  Model: Opus 5']);
  });

  it('leaves the pane whole when the shape is not there', () => {
    // Mid-render, or a pane that is just command output. Guessing wrong here
    // would eat the end of the conversation, which is what the reader is
    // looking at.
    const plain = pane('just some output', 'and more');
    expect(splitPane(plain)).toEqual({ body: plain, status: [] });

    const oneRule = pane('output', RULE, '  Model: Opus 5');
    expect(splitPane(oneRule).status).toEqual([]);
  });

  it('is not fooled by a line of dashes inside the conversation', () => {
    // Markdown rules and ASCII art turn up in transcripts constantly.
    const { status } = splitPane(pane('a', '---', 'b', '----------', 'c'));
    expect(status).toEqual([]);
  });

  it('leaves the pane whole when too much sits between the rules', () => {
    const { status } = splitPane(pane(
      'output', RULE, 'a', 'b', 'c', 'd', 'e', RULE, '  Model: Opus 5',
    ));
    expect(status).toEqual([]);
  });

  it('reports no status when the footer is blank', () => {
    const { status } = splitPane(pane('output', TITLED, '❯ ', RULE, '   ', ''));
    expect(status).toEqual([]);
  });

  it('has nothing to say about an empty pane', () => {
    expect(splitPane('')).toEqual({ body: '', status: [] });
  });
});

