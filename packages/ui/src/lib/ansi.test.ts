import { describe, it, expect } from 'vitest';
import { parseAnsi, stripAnsi } from './ansi';

const E = '\x1b';

describe('parseAnsi', () => {
  it('splits a line into styled runs', () => {
    const [line] = parseAnsi(`plain ${E}[31mred${E}[0m plain`);
    expect(line.plain).toBe('plain red plain');
    expect(line.spans.map(s => s.text)).toEqual(['plain ', 'red', ' plain']);
    expect(line.spans[0].style).toBeUndefined();
    expect(line.spans[1].style?.color).toBeDefined();
    expect(line.spans[2].style).toBeUndefined();
  });

  it('carries style across lines', () => {
    // A TUI sets a colour and then draws several rows in it; resetting per line
    // would drop the colour off every wrapped answer after its first row.
    const lines = parseAnsi(`${E}[32mfirst\nsecond${E}[0m\nthird`);
    expect(lines[0].spans[0].style?.color).toBe(lines[1].spans[0].style?.color);
    expect(lines[2].spans[0].style).toBeUndefined();
  });

  it('reads 256-colour and truecolor', () => {
    const [a] = parseAnsi(`${E}[38;5;79mteal`);
    expect(a.spans[0].style?.color).toMatch(/^rgb\(/);
    const [b] = parseAnsi(`${E}[38;2;10;20;30mexact`);
    expect(b.spans[0].style?.color).toBe('rgb(10, 20, 30)');
  });

  it('consumes an extended colour\'s parameters instead of misreading them', () => {
    // `38;5;79` must not also be read as "3" (italic) or "5" (blink).
    const [line] = parseAnsi(`${E}[38;5;79mx`);
    expect(line.spans[0].style?.fontStyle).toBeUndefined();
  });

  it('handles bold, dim, italic and underline, and their resets', () => {
    const [line] = parseAnsi(`${E}[1;2;3;4mall${E}[22;23;24mnone`);
    expect(line.spans[0].style).toMatchObject({
      fontWeight: 'bold', opacity: 0.6, fontStyle: 'italic', textDecoration: 'underline',
    });
    expect(line.spans[1].style).toBeUndefined();
  });

  it('treats a bare ESC[m as a reset', () => {
    const [line] = parseAnsi(`${E}[31mred${E}[mplain`);
    expect(line.spans[1].style).toBeUndefined();
  });

  it('resets background separately from foreground', () => {
    const [line] = parseAnsi(`${E}[31;42mboth${E}[49mfg only`);
    expect(line.spans[1].style?.color).toBeDefined();
    expect(line.spans[1].style?.backgroundColor).toBeUndefined();
  });

  it('keeps the plain text exactly, escapes and all removed', () => {
    const [line] = parseAnsi(`${E}[38;5;79mModel: Opus 5${E}[0m | ${E}[1;33mauto${E}[0m`);
    expect(line.plain).toBe('Model: Opus 5 | auto');
  });

  it('copes with no escapes at all', () => {
    const lines = parseAnsi('one\ntwo');
    expect(lines.map(l => l.plain)).toEqual(['one', 'two']);
    expect(lines[0].spans[0].style).toBeUndefined();
  });

  it('produces an empty line rather than a stray span', () => {
    expect(parseAnsi('')).toEqual([{ plain: '', spans: [] }]);
  });
});

describe('stripAnsi', () => {
  it('removes escapes, leaving the text', () => {
    expect(stripAnsi(`${E}[38;5;79mModel${E}[0m | ${E}[2Kauto`)).toBe('Model | auto');
  });
});
