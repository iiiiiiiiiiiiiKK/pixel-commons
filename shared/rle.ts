/**
 * Run-length encoding for the pixel canvas, plus sRGB colour quantisation.
 *
 * The authoritative canvas is stored in the Durable Object SQLite database as an
 * RLE uint8 blob: `[value, runLength, value, runLength, ...]`. Run lengths are
 * capped at 65535 bytes (fits exactly in a Uint16) which keeps every entry a
 * fixed 3 bytes and makes the codec trivial to verify.
 *
 * Encoding 256x256 (65 536 cells) costs ~77 kB on a worst-case random canvas and
 * only a few hundred bytes on a realistic community drawing, so both the R2/R2-style
 * backups and the WebSocket welcome payload stay small.
 */

export const MAX_RUN = 65535;

export function packRle(values: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(values.length / 1) * 3);
  let p = 0;
  let i = 0;
  while (i < values.length) {
    const v = values[i]!;
    let run = 1;
    while (i + run < values.length && values[i + run] === v && run < MAX_RUN) run++;
    out[p++] = v;
    out[p++] = run & 0xff;
    out[p++] = (run >> 8) & 0xff;
    i += run;
  }
  return out.slice(0, p);
}

export function unpackRle(blob: Uint8Array, expectedLength: number): Uint8Array {
  const out = new Uint8Array(expectedLength);
  let p = 0;
  for (let i = 0; i + 2 < blob.length; i += 3) {
    if (p >= expectedLength) break;
    const v = blob[i]!;
    const run = blob[i + 1]! | (blob[i + 2]! << 8);
    if (run === 0) continue;
    const end = Math.min(p + run, expectedLength);
    out.fill(v, p, end);
    p = end;
  }
  return out;
}

/** Expand an RLE blob into a palette-index Uint8Array of length width*height. */
export function decodeCanvas(blob: Uint8Array, expectedLength: number): Uint8Array {
  return unpackRle(blob, expectedLength);
}

export function encodeCanvas(values: Uint8Array): Uint8Array {
  return packRle(values);
}

/** base64url helpers that work identically in workerd and in the browser. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const b64 = typeof btoa === 'function' ? btoa(binary) : '';
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* -------------------------------------------------------------------------- */
/*                              colour handling                                */
/* -------------------------------------------------------------------------- */

export const DEFAULT_PALETTE = [
  '#000000', '#1d2b53', '#7e2553', '#008751',
  '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
  '#ff004d', '#ffa300', '#ffec27', '#00e436',
  '#29adff', '#83769c', '#ff77a8', '#ffccaa',
];

/**
 * Parse a hex colour into an sRGB triplet. Accepts #rgb, #rrggbb and bare forms.
 * Returns null for anything that is not a 3/6 digit hex colour.
 */
export function parseHex(input: string): [number, number, number] | null {
  const hex = input.trim().replace(/^#/, '');
  if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(hex)) return null;
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** Strip the leading '#' and lowercase a validated palette entry. */
export function normaliseHex(input: string): string | null {
  const rgb = parseHex(input);
  if (!rgb) return null;
  return '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** A palette entry that is guaranteed to be `#rrggbb` lower-case. */
export function paletteRgb(palette: string[]): Array<[number, number, number]> {
  return palette.map((hex) => parseHex(hex) ?? [0, 0, 0]);
}

export function canvasIdFor(width: number, height: number, name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'canvas'}-${width}x${height}`;
}
