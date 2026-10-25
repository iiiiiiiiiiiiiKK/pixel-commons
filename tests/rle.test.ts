import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PALETTE,
  MAX_RUN,
  base64UrlToBytes,
  bytesToBase64Url,
  canvasIdFor,
  decodeCanvas,
  encodeCanvas,
  normaliseHex,
  packRle,
  paletteRgb,
  parseHex,
  unpackRle,
} from '../shared/rle';

describe('packRle / unpackRle', () => {
  it('round-trips a uniform canvas', () => {
    const values = new Uint8Array(256 * 256);
    const packed = packRle(values);
    // 65 536 cells exceed the uint16 run cap (65 535), so exactly two runs are emitted.
    expect(packed.length).toBe(6);
    expect(packed[0]).toBe(0);
    expect(packed[1]! | (packed[2]! << 8)).toBe(65535);
    expect(packed[3]).toBe(0);
    expect(packed[4]! | (packed[5]! << 8)).toBe(1);
    expect(Array.from(unpackRle(packed, values.length))).toEqual(Array.from(values));
  });

  it('round-trips alternating noise exactly', () => {
    const values = new Uint8Array(1000);
    for (let i = 0; i < values.length; i++) values[i] = i % 7;
    const packed = packRle(values);
    const restored = unpackRle(packed, values.length);
    expect(Array.from(restored)).toEqual(Array.from(values));
  });

  it('caps runs at the uint16 boundary', () => {
    const values = new Uint8Array(MAX_RUN * 2 + 10);
    const packed = packRle(values);
    // Two full runs plus a short tail.
    expect(packed.length).toBe(9);
    expect(Array.from(unpackRle(packed, values.length))).toEqual(Array.from(values));
  });

  it('never exceeds the target length when the blob is malformed', () => {
    const packed = new Uint8Array([5, 0xff, 0xff, 5, 0xff, 0xff]);
    const restored = unpackRle(packed, 10);
    expect(restored.length).toBe(10);
  });

  it('preserves palette indices through encodeCanvas/decodeCanvas', () => {
    const values = new Uint8Array(64 * 64);
    for (let i = 0; i < values.length; i++) values[i] = (i * 13) % 16;
    const restored = decodeCanvas(encodeCanvas(values), values.length);
    expect(Array.from(restored)).toEqual(Array.from(values));
  });
});

describe('base64url', () => {
  it('round-trips binary data without padding characters', () => {
    const bytes = new Uint8Array(500);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 37) % 256;
    const encoded = bytesToBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlToBytes(encoded))).toEqual(Array.from(bytes));
  });

  it('handles empty input', () => {
    expect(bytesToBase64Url(new Uint8Array(0))).toBe('');
    expect(base64UrlToBytes('').length).toBe(0);
  });
});

describe('colour helpers', () => {
  it('parses 3 and 6 digit hex', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('0f0')).toEqual([0, 255, 0]);
    expect(parseHex('#29ADFF')).toEqual([41, 173, 255]);
  });

  it('rejects invalid colours', () => {
    expect(parseHex('not-a-colour')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('')).toBeNull();
  });

  it('normalises to lower-case #rrggbb', () => {
    expect(normaliseHex('#ABC')).toBe('#aabbcc');
    expect(normaliseHex('FF004D')).toBe('#ff004d');
    expect(normaliseHex('zzz')).toBeNull();
  });

  it('expands the default palette into RGB triplets', () => {
    const rgb = paletteRgb(DEFAULT_PALETTE);
    expect(rgb.length).toBe(DEFAULT_PALETTE.length);
    expect(rgb[0]).toEqual([0, 0, 0]);
    expect(rgb[8]).toEqual([255, 0, 77]);
  });

  it('has a 16 entry PICO-8 style default palette', () => {
    expect(DEFAULT_PALETTE.length).toBe(16);
    for (const hex of DEFAULT_PALETTE) expect(hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('slugifies canvas ids', () => {
    expect(canvasIdFor(256, 256, 'Pixel Commons')).toBe('pixel-commons-256x256');
    expect(canvasIdFor(64, 32, '  Ünïcode  ')).toBe('n-code-64x32');
  });
});
