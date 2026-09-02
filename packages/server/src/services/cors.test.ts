import { describe, it, expect } from 'vitest';
import { isAllowedOrigin } from './cors.js';

describe('isAllowedOrigin', () => {
  it('allows requests that carry no Origin at all', () => {
    expect(isAllowedOrigin(undefined, 'localhost:3456')).toBe(true);
  });

  it('allows the UI dev server on another local port', () => {
    expect(isAllowedOrigin('http://localhost:5173', 'localhost:3456')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:5173', 'localhost:3456')).toBe(true);
  });

  it('allows a same-origin request when bound to a LAN address', () => {
    expect(isAllowedOrigin('http://192.168.1.5:3456', '192.168.1.5:3456')).toBe(true);
  });

  it('rejects a site trying to reach the API from the outside', () => {
    expect(isAllowedOrigin('https://evil.example', 'localhost:3456')).toBe(false);
    expect(isAllowedOrigin('https://evil.example', '192.168.1.5:3456')).toBe(false);
  });

  it('rejects a different port on the LAN address it is bound to', () => {
    expect(isAllowedOrigin('http://192.168.1.5:9999', '192.168.1.5:3456')).toBe(false);
  });

  it('rejects an unparseable Origin rather than trusting it', () => {
    expect(isAllowedOrigin('not-a-url', 'localhost:3456')).toBe(false);
  });
});
