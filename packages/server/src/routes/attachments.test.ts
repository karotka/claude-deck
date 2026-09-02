import { describe, it, expect } from 'vitest';
import { safeAttachmentName } from './attachments.js';

describe('safeAttachmentName', () => {
  it('keeps a plain filename, extension and all', () => {
    // The extension matters: it is how Claude Code knows what it is being
    // handed when the path lands in the prompt.
    expect(safeAttachmentName('screenshot.png')).toBe('screenshot.png');
  });

  it('cannot escape the directory it is written into', () => {
    expect(safeAttachmentName('../../../etc/passwd')).toBe('passwd');
    expect(safeAttachmentName('/etc/shadow')).toBe('shadow');
    expect(safeAttachmentName('..')).toBe('dropped-file');
    expect(safeAttachmentName('.')).toBe('dropped-file');
  });

  it('flattens anything a shell might act on', () => {
    // The path is typed into a terminal afterwards, so a name carrying quotes
    // or semicolons is not something to pass along verbatim.
    expect(safeAttachmentName('a b;rm -rf $HOME.png')).toBe('a_b_rm_-rf__HOME.png');
    expect(safeAttachmentName("it's a `photo`.jpg")).toBe('it_s_a__photo_.jpg');
  });

  it('falls back rather than producing an empty name', () => {
    expect(safeAttachmentName('')).toBe('dropped-file');
    expect(safeAttachmentName('///')).toBe('dropped-file');
  });

  it('truncates a name long enough to trouble the filesystem', () => {
    expect(safeAttachmentName('x'.repeat(400)).length).toBe(120);
  });
});
