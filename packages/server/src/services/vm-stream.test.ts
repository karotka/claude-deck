import { describe, it, expect } from 'vitest';
import { splitFrames } from './vm-stream.js';

const M = '@@@VMFRAME@@@';

describe('splitFrames', () => {
  it('drops the connection preamble before the first marker', () => {
    // gcloud/ssh narrate before the loop's first frame ever lands.
    const { frames, rest } = splitFrames(`WARNING: consider installing NumPy\n${M}\npane one\n${M}\n`);

    expect(frames).toEqual(['pane one\n']);
    expect(rest).toBe(`${M}\n`);
  });

  it('holds back the trailing frame until the next marker proves it complete', () => {
    // A pane arrives over several TCP chunks; rendering the tail would show a
    // half-drawn terminal every second.
    const { frames, rest } = splitFrames(`${M}\nfull frame\n${M}\nhalf-writ`);

    expect(frames).toEqual(['full frame\n']);
    expect(rest).toBe(`${M}\nhalf-writ`);
  });

  it('emits nothing while only a partial first frame has arrived', () => {
    const { frames, rest } = splitFrames(`${M}\nstill writing`);

    expect(frames).toEqual([]);
    expect(rest).toBe(`${M}\nstill writing`);
  });

  it('returns every complete frame when several arrive in one chunk', () => {
    const { frames } = splitFrames(`${M}\na\n${M}\nb\n${M}\nc\n${M}\n`);

    expect(frames).toEqual(['a\n', 'b\n', 'c\n']);
  });

  it('reassembles a frame split across chunk boundaries', () => {
    const first = splitFrames(`${M}\nline one\n`);
    expect(first.frames).toEqual([]);

    const second = splitFrames(first.rest + `line two\n${M}\n`);
    expect(second.frames).toEqual(['line one\nline two\n']);
  });

  it('survives a marker itself being split across chunks', () => {
    const first = splitFrames(`${M}\npane\n@@@VMF`);
    expect(first.frames).toEqual([]);

    const second = splitFrames(first.rest + `RAME@@@\nnext pane\n${M}\n`);
    expect(second.frames).toEqual(['pane\n', 'next pane\n']);
  });

  it('passes through a buffer with no markers at all', () => {
    expect(splitFrames('no markers here')).toEqual({ frames: [], rest: 'no markers here' });
  });

  it('yields an empty frame for an empty pane rather than dropping it', () => {
    expect(splitFrames(`${M}\n${M}\n`).frames).toEqual(['']);
  });
});
