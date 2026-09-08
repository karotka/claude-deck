import { describe, it, expect } from 'vitest';
import { splitPane, arrowsBelongToSession, sessionPromptText } from './terminal';

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


describe('arrowsBelongToSession', () => {
  // The ordinary state: an input line marked with the prompt glyph, framed by
  // rules, carrying whatever has been typed on it.
  const idle = [
    'some output',
    '\u2500\u2500\u2500\u2500\u2500 Claude monitor \u2500',
    '\u276f ',
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    '  Model: Opus 5 | Ctx: 409.0k',
  ].join('\n');

  // A modal: the glyph marks the selected option, and there is no input line.
  const trustDialog = [
    ' Quick safety check: Is this a project you created or one you trust?',
    ' \u276f No, exit',
    '   Yes, I trust this folder',
    ' Enter to confirm \u00b7 Esc to cancel',
  ].join('\n');

  it('leaves the arrows to the history at an ordinary empty prompt', () => {
    expect(arrowsBelongToSession(idle, '')).toBe(false);
  });

  it('gives them to the session while a slash command is being typed', () => {
    // Claude Code opens its command list as soon as the input starts with `/`,
    // and that list is walked with the arrows.
    expect(arrowsBelongToSession(idle, '/mod')).toBe(true);
  });

  it('gives them to the session when a modal is up', () => {
    // These are answered with the arrows and nothing else, and they start on
    // the option that declines.
    expect(arrowsBelongToSession(trustDialog, '')).toBe(true);
  });

  it('keeps them for the history once there is text to recall past', () => {
    expect(arrowsBelongToSession(idle, 'what I was writing')).toBe(false);
  });

  it('is not fooled by a prompt glyph carrying only whitespace', () => {
    expect(arrowsBelongToSession('\u276f    \n', '')).toBe(false);
  });

  it('reads the marker through colour', () => {
    // Panes arrive with their escape sequences; a modal drawn in colour is
    // still a modal.
    expect(arrowsBelongToSession('\u001b[1m \u276f No, exit\u001b[0m', '')).toBe(true);
  });
});

describe('sessionPromptText', () => {
  it('reads what the session prompt is holding', () => {
    const pane = [
      'some output',
      '\u2500\u2500\u2500\u2500\u2500 Claude monitor \u2500',
      '\u276f /mod',
      '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    ].join('\n');
    expect(sessionPromptText(pane)).toBe('/mod');
  });

  it('is empty, not absent, at an empty prompt', () => {
    expect(sessionPromptText('\u276f ')).toBe('');
  });

  it('takes the input line rather than a menu selection above it', () => {
    // A command list marks its selection with the same glyph, and the prompt
    // is always below the list.
    const pane = [
      '  \u276f /model      Set the AI model',
      '    /loop       Run a prompt on an interval',
      '\u276f /mod',
    ].join('\n');
    expect(sessionPromptText(pane)).toBe('/mod');
  });

  it('reads through colour, since panes arrive with their escapes', () => {
    expect(sessionPromptText('\u001b[1m\u276f /mod\u001b[0m')).toBe('/mod');
  });

  it('has nothing to read when there is no prompt line', () => {
    expect(sessionPromptText('Quick safety check: ...')).toBeNull();
  });

  it('does not keep the padding a pane is drawn with', () => {
    expect(sessionPromptText('\u276f /mod          ')).toBe('/mod');
  });
});

describe('sessionPromptText and the TUI\'s own suggestion', () => {
  it('reads an empty prompt as empty, not as the suggestion drawn in it', () => {
    // Claude Code draws a faint hint on an empty input line. Nobody typed it,
    // and showing it as the line's contents put words in the user's box.
    const pane = '\u001b[39m\u276f \u001b[2mTry "how do I log an error?"';
    expect(sessionPromptText(pane)).toBe('');
  });

  it('still reads text that was actually typed', () => {
    expect(sessionPromptText('\u001b[39m\u276f ahoj')).toBe('ahoj');
  });

  it('ignores a glyph with something visible before it', () => {
    // A selected item in a list, drawn indented under a heading, is not the
    // input line.
    expect(sessionPromptText('list: \u276f /model')).toBeNull();
  });
});
