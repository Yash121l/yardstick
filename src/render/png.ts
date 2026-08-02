import { deflateSync } from "node:zlib";

/**
 * A minimal greyscale PNG encoder.
 *
 * P7 needs rendered invoices, and the dependency budget for this repo does not
 * stretch to a canvas or image library for one suite. Node ships zlib, which is
 * the only hard part of a PNG, so the encoder is about eighty lines and has no
 * dependencies at all.
 *
 * 8-bit greyscale is deliberate: an invoice is ink on paper, colour would carry
 * no signal, and a single channel keeps the files small enough to send.
 */

export interface Bitmap {
  width: number;
  height: number;
  /** One byte per pixel, 0 = black, 255 = white, row-major. */
  data: Uint8Array;
}

export function createBitmap(width: number, height: number, fill = 255): Bitmap {
  const data = new Uint8Array(width * height);
  data.fill(fill);
  return { width, height, data };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(body)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

export function encodePng(bm: Bitmap): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(bm.width, 0);
  ihdr.writeUInt32BE(bm.height, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(0, 9); // colour type 0 = greyscale
  ihdr.writeUInt8(0, 10); // deflate
  ihdr.writeUInt8(0, 11); // adaptive filtering
  ihdr.writeUInt8(0, 12); // no interlace

  // Each scanline is prefixed with its filter type. Filter 0 (None) keeps the
  // encoder trivial; deflate still compresses the large flat paper areas well.
  const raw = Buffer.alloc((bm.width + 1) * bm.height);
  for (let y = 0; y < bm.height; y++) {
    raw[y * (bm.width + 1)] = 0;
    Buffer.from(bm.data.subarray(y * bm.width, (y + 1) * bm.width)).copy(
      raw,
      y * (bm.width + 1) + 1,
    );
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export function setPixel(bm: Bitmap, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= bm.width || y >= bm.height) return;
  bm.data[y * bm.width + x] = Math.max(0, Math.min(255, Math.round(v)));
}

export function getPixel(bm: Bitmap, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= bm.width || y >= bm.height) return 255;
  return bm.data[y * bm.width + x] as number;
}

export function fillRect(bm: Bitmap, x: number, y: number, w: number, h: number, v: number): void {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) setPixel(bm, i, j, v);
}
