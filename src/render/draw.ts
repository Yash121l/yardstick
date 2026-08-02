import { GLYPH_H, GLYPH_W, glyph } from "./font.js";
import { type Bitmap, fillRect, getPixel, setPixel } from "./png.js";

/**
 * Drawing primitives for the P7 invoice renderer: text, rules, boxes, and the
 * degradations that turn a clean scan into something photographed on a desk.
 */

export interface TextOpts {
  /** Pixels per font pixel. 3 gives a 15x21 glyph, comfortably legible. */
  scale?: number;
  /** Ink value, 0 = black. */
  ink?: number;
  /** Extra pixels between glyph cells, in font pixels. */
  tracking?: number;
}

export function textWidth(text: string, opts: TextOpts = {}): number {
  const scale = opts.scale ?? 3;
  const tracking = opts.tracking ?? 1;
  return text.length * (GLYPH_W + tracking) * scale;
}

export function drawText(
  bm: Bitmap,
  x: number,
  y: number,
  text: string,
  opts: TextOpts = {},
): void {
  const scale = opts.scale ?? 3;
  const ink = opts.ink ?? 20;
  const tracking = opts.tracking ?? 1;
  let cx = x;
  for (const ch of text) {
    const g = glyph(ch);
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (!g[gy]?.[gx]) continue;
        fillRect(bm, cx + gx * scale, y + gy * scale, scale, scale, ink);
      }
    }
    cx += (GLYPH_W + tracking) * scale;
  }
}

/** Right-align `text` so it ends at `rightX`. */
export function drawTextRight(
  bm: Bitmap,
  rightX: number,
  y: number,
  text: string,
  opts: TextOpts = {},
): void {
  drawText(bm, rightX - textWidth(text, opts), y, text, opts);
}

export function hLine(bm: Bitmap, x: number, y: number, w: number, ink = 90, thick = 1): void {
  fillRect(bm, x, y, w, thick, ink);
}

export function box(bm: Bitmap, x: number, y: number, w: number, h: number, ink = 90): void {
  fillRect(bm, x, y, w, 1, ink);
  fillRect(bm, x, y + h - 1, w, 1, ink);
  fillRect(bm, x, y, 1, h, ink);
  fillRect(bm, x + w - 1, y, 1, h, ink);
}

/**
 * Deterministic value noise. Seeded so a fixture renders identically on every
 * machine; a fixture that differs run to run cannot be a fixture.
 */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0xffffffff;
}

/** Sensor grain. */
export function addNoise(bm: Bitmap, amount: number, seed: number): void {
  for (let y = 0; y < bm.height; y++) {
    for (let x = 0; x < bm.width; x++) {
      const n = (hash2(x, y, seed) - 0.5) * 2 * amount;
      setPixel(bm, x, y, getPixel(bm, x, y) + n);
    }
  }
}

/**
 * A soft diagonal brightness ramp, as if lit from one side. Uneven lighting is
 * the single most common thing that separates a photographed receipt from a
 * flatbed scan.
 */
export function addLightingGradient(bm: Bitmap, strength: number, angle: number): void {
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const diag = Math.abs(dx) * bm.width + Math.abs(dy) * bm.height;
  for (let y = 0; y < bm.height; y++) {
    for (let x = 0; x < bm.width; x++) {
      const t = (x * dx + y * dy) / diag;
      setPixel(bm, x, y, getPixel(bm, x, y) - strength * t);
    }
  }
}

/** 3x3 box blur, one pass per call. Approximates a slightly missed focus. */
export function blur(bm: Bitmap): void {
  const src = new Uint8Array(bm.data);
  const at = (x: number, y: number) =>
    src[
      Math.min(bm.height - 1, Math.max(0, y)) * bm.width + Math.min(bm.width - 1, Math.max(0, x))
    ] as number;
  for (let y = 0; y < bm.height; y++) {
    for (let x = 0; x < bm.width; x++) {
      let sum = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) sum += at(x + i, y + j);
      bm.data[y * bm.width + x] = Math.round(sum / 9);
    }
  }
}

/**
 * Rotate about the centre with bilinear sampling.
 *
 * Sampling backwards from the destination avoids the holes a forward map
 * leaves, and bilinear keeps small text readable at the angles a hand-held
 * photo produces. Anything outside the source reads as the paper colour.
 */
export function rotate(bm: Bitmap, degrees: number, background = 245): Bitmap {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(-rad);
  const sin = Math.sin(-rad);
  const cx = bm.width / 2;
  const cy = bm.height / 2;
  const out: Bitmap = {
    width: bm.width,
    height: bm.height,
    data: new Uint8Array(bm.width * bm.height).fill(background),
  };

  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const ox = x - cx;
      const oy = y - cy;
      const sx = ox * cos - oy * sin + cx;
      const sy = ox * sin + oy * cos + cy;
      if (sx < 0 || sy < 0 || sx >= bm.width - 1 || sy >= bm.height - 1) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      const v =
        getPixel(bm, x0, y0) * (1 - fx) * (1 - fy) +
        getPixel(bm, x0 + 1, y0) * fx * (1 - fy) +
        getPixel(bm, x0, y0 + 1) * (1 - fx) * fy +
        getPixel(bm, x0 + 1, y0 + 1) * fx * fy;
      out.data[y * out.width + x] = Math.round(v);
    }
  }
  return out;
}

/**
 * A guard against text drawn on top of other text.
 *
 * Overlapping labels are the characteristic failure of hand-laid-out fixtures:
 * "SUBTOTAL" and "INR 48,434.80" collide into "SUBTOTAINR", the model reads it
 * wrong, and the suite reports a vision failure that is really a layout bug.
 * The renderer registers every string it draws; the generator asserts nothing
 * collided before writing the file.
 */
export class LayoutGuard {
  private readonly placed: Array<{
    x0: number;
    y0: number;
    x1: number;
    y1: number;
    text: string;
  }> = [];
  readonly collisions: string[] = [];

  /**
   * Exact rectangle intersection, not row bands. Banding by a fixed height
   * flags two lines 28px apart with 14px glyphs, which is a clean layout, and
   * a guard that cries wolf gets switched off.
   */
  place(x0: number, y0: number, x1: number, y1: number, text: string): void {
    if (text.trim() === "") return;
    for (const o of this.placed) {
      if (x0 < o.x1 && o.x0 < x1 && y0 < o.y1 && o.y0 < y1) {
        this.collisions.push(`"${text}" overlaps "${o.text}" at (${Math.round(x0)},${y0})`);
      }
    }
    this.placed.push({ x0, y0, x1, y1, text });
  }
}

/** Largest scale at or below `max` whose rendering fits `maxWidth`. */
export function fitScale(text: string, maxWidth: number, max = 4, min = 1): number {
  for (let s = max; s > min; s--) if (textWidth(text, { scale: s }) <= maxWidth) return s;
  return min;
}
