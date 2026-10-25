/**
 * Minimal, dependency-free PNG encoder (8-bit truecolour, no interlacing).
 *
 * PNG is used for two things:
 *  1. `/api/export.png` — lets anyone download the community artwork.
 *  2. `/api/history/snapshot.png` — renders a past snapshot of the canvas.
 *
 * Cloudflare Workers expose `CompressionStream('deflate')`, whose output stream is
 * exactly the zlib wrapper PNG requires for the IDAT chunk, so the encoder stays
 * around 60 lines and needs no bundled wasm.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcBuf = new Uint8Array(4 + data.length);
  crcBuf.set(out.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc32(crcBuf));
  return out;
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([raw as unknown as ArrayBuffer]).stream().pipeThrough(new CompressionStream('deflate'));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Encode an RGB buffer (3 bytes per pixel, row-major) into a PNG file.
 */
export async function encodePng(rgb: Uint8Array, width: number, height: number): Promise<Uint8Array> {
  const stride = width * 3;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    raw.set(rgb.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = await deflate(raw);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', new Uint8Array(0)),
  ];

  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Expand palette indices into an RGB buffer using the canvas palette.
 * Scale > 1 produces a nearest-neighbour upscaled image (crisp pixels).
 */
export function paletteToRgb(
  indices: Uint8Array,
  width: number,
  height: number,
  palette: Array<[number, number, number]>,
  scale = 1,
): { rgb: Uint8Array; width: number; height: number } {
  const outW = width * scale;
  const outH = height * scale;
  const rgb = new Uint8Array(outW * outH * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const colour = palette[indices[y * width + x]!] ?? [0, 0, 0];
      for (let sy = 0; sy < scale; sy++) {
        const rowStart = ((y * scale + sy) * outW + x * scale) * 3;
        for (let sx = 0; sx < scale; sx++) {
          const p = rowStart + sx * 3;
          rgb[p] = colour[0]!;
          rgb[p + 1] = colour[1]!;
          rgb[p + 2] = colour[2]!;
        }
      }
    }
  }
  return { rgb, width: outW, height: outH };
}
