/* GIF89a 编码器 —— 只为「白纸上一种墨色」这一种内容写的。
 *
 * 所以比通用编码器简单得多：调色板固定是白到墨的一条灰阶（抗锯齿出来的像素本
 * 来就是白和墨的混色，一条灰阶就够，不用做八叉树量化）；每一帧只写「跟上一帧
 * 不一样」的那个矩形 —— 笔画只会一直加上去、不会消失，所以差异矩形通常只有一
 * 笔那么大，一整段话的 GIF 才不至于几十 MB。
 *
 * 跟导出 ZIP 那边同一个取舍：宁可自己写这一百多行，也不为一个格式拉一个依赖。
 */

export type Rgb = [number, number, number];

export type InkPalette = {
  inks: Rgb[];
  levels: number;
  colors: Rgb[];
};

const WHITE: Rgb = [255, 255, 255];

/** 白 → 墨 的一条灰阶。levels 必须是 2 的幂（GIF 的全局色表只认这个）。 */
export function inkRamp(ink: Rgb, levels = 32): Rgb[] {
  const out: Rgb[] = [];
  for (let i = 0; i < levels; i++) {
    const t = i / (levels - 1);
    out.push([
      Math.round(WHITE[0] + (ink[0] - WHITE[0]) * t),
      Math.round(WHITE[1] + (ink[1] - WHITE[1]) * t),
      Math.round(WHITE[2] + (ink[2] - WHITE[2]) * t),
    ]);
  }
  return out;
}

/** 画布像素 -> 单一墨色渐变下标；多色场景使用下面的 toInkPaletteIndices。 */
export function toRampIndices(data: Uint8ClampedArray, ink: Rgb, levels = 32): Uint8Array {
  const span = 255 - (ink[0] + ink[1] + ink[2]) / 3 || 1;
  const out = new Uint8Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const luma = (data[i] + data[i + 1] + data[i + 2]) / 3;
    const t = Math.min(1, Math.max(0, (255 - luma) / span));
    out[p] = Math.round(t * (levels - 1));
  }
  return out;
}

/**
 * 给一段可能包含多种墨色的动画准备调色板。
 * 每种墨色占一条「白 → 墨」的渐变，仍然保留手写线条的抗锯齿，而不是把所有字
 * 压回第一种颜色。颜色很多时自动减少每条渐变的档数，保证 GIF 调色板不超过 256 色。
 */
export function inkPalette(inks: Rgb[], requestedLevels = 32): InkPalette {
  const unique = new Map<string, Rgb>();
  for (const ink of inks) {
    const normalized: Rgb = [Math.round(ink[0]), Math.round(ink[1]), Math.round(ink[2])];
    unique.set(normalized.join(","), normalized);
  }
  if (!unique.size) unique.set("27,27,25", [27, 27, 25]);

  // 128 种颜色 × 2 档已经是 GIF 的上限；实际编辑场景通常只有几种颜色。
  const paletteInks = Array.from(unique.values()).slice(0, 128);
  const maxLevels = Math.max(2, Math.floor(256 / paletteInks.length));
  const levelLimit = Math.max(2, Math.min(requestedLevels, maxLevels));
  const levels = 2 ** Math.floor(Math.log2(levelLimit));
  const colors = paletteInks.flatMap((ink) => inkRamp(ink, levels));
  const tableSize = 2 ** Math.ceil(Math.log2(Math.max(2, colors.length)));
  while (colors.length < tableSize) colors.push(WHITE);
  return { inks: paletteInks, levels, colors };
}

/** 把白底上的多种墨色像素映射到对应的渐变调色板。 */
export function toInkPaletteIndices(data: Uint8ClampedArray, palette: InkPalette): Uint8Array {
  const out = new Uint8Array(data.length / 4);
  const vectors = palette.inks.map((ink) => {
    const vector: Rgb = [255 - ink[0], 255 - ink[1], 255 - ink[2]];
    return { ink, vector, length: Math.max(1, vector[0] ** 2 + vector[1] ** 2 + vector[2] ** 2) };
  });
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const pixel: Rgb = [data[i], data[i + 1], data[i + 2]];
    let bestInk = 0;
    let bestAlpha = 0;
    let bestDistance = Infinity;
    for (let inkIndex = 0; inkIndex < vectors.length; inkIndex++) {
      const { vector, length } = vectors[inkIndex];
      const alpha = Math.min(1, Math.max(0, (
        (255 - pixel[0]) * vector[0]
        + (255 - pixel[1]) * vector[1]
        + (255 - pixel[2]) * vector[2]
      ) / length));
      const distance = (
        (pixel[0] - (255 - vector[0] * alpha)) ** 2
        + (pixel[1] - (255 - vector[1] * alpha)) ** 2
        + (pixel[2] - (255 - vector[2] * alpha)) ** 2
      );
      if (distance < bestDistance) {
        bestDistance = distance;
        bestInk = inkIndex;
        bestAlpha = alpha;
      }
    }
    out[p] = bestInk * palette.levels + Math.round(bestAlpha * (palette.levels - 1));
  }
  return out;
}

class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private bits = 0;

  write(code: number, size: number) {
    this.cur |= code << this.bits;
    this.bits += size;
    while (this.bits >= 8) {
      this.bytes.push(this.cur & 0xff);
      this.cur >>= 8;
      this.bits -= 8;
    }
  }

  finish() {
    if (this.bits > 0) this.bytes.push(this.cur & 0xff);
    this.cur = 0;
    this.bits = 0;
    return this.bytes;
  }
}

/** 变长 LZW —— 码表满了发 clear 重来，这是 GIF 规定的那一版，不是通用 LZW。 */
function lzw(pixels: Uint8Array, minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out = new BitWriter();
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let table = new Map<number, number>();

  out.write(clear, codeSize);
  if (!pixels.length) {
    out.write(eoi, codeSize);
    return out.finish();
  }

  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i];
    const key = prefix * 4096 + k;
    const hit = table.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    out.write(prefix, codeSize);
    if (next === 4096) {
      out.write(clear, codeSize);
      table = new Map();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    } else {
      if (next >= 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    prefix = k;
  }
  out.write(prefix, codeSize);
  out.write(eoi, codeSize);
  return out.finish();
}

type PendingFrame = { pixels: Uint8Array; x: number; y: number; w: number; h: number; delay: number };

export class GifWriter {
  private chunks: number[][] = [];
  private prev: Uint8Array | null = null;
  private pending: PendingFrame | null = null;
  private minCodeSize: number;

  constructor(private width: number, private height: number, palette: Rgb[]) {
    let bits = 1;
    while (1 << bits < palette.length) bits++;
    if (1 << bits !== palette.length || bits > 8) {
      throw new Error("GIF 色表必须是 2–256 之间的 2 的幂");
    }
    this.minCodeSize = Math.max(2, bits);

    const head: number[] = [];
    for (const ch of "GIF89a") head.push(ch.charCodeAt(0));
    head.push(width & 0xff, width >> 8, height & 0xff, height >> 8);
    head.push(0x80 | ((bits - 1) << 4) | (bits - 1), 0, 0);
    for (const [r, g, b] of palette) head.push(r, g, b);
    // NETSCAPE2.0：循环播放，0 = 无限
    head.push(0x21, 0xff, 0x0b);
    for (const ch of "NETSCAPE2.0") head.push(ch.charCodeAt(0));
    head.push(0x03, 0x01, 0, 0, 0);
    this.chunks.push(head);
  }

  /** 加一帧全画幅下标图。画面没动的帧不会被写出去，而是把上一帧的停留时间加长。 */
  add(indices: Uint8Array, delayMs: number) {
    if (indices.length !== this.width * this.height) throw new Error("帧尺寸不对");
    if (!this.prev) {
      this.pending = { pixels: indices.slice(), x: 0, y: 0, w: this.width, h: this.height, delay: delayMs };
      this.prev = indices.slice();
      return;
    }
    const rect = this.diff(this.prev, indices);
    if (!rect) {
      if (this.pending) this.pending.delay += delayMs;
      return;
    }
    this.flush();
    const { x, y, w, h } = rect;
    const patch = new Uint8Array(w * h);
    for (let row = 0; row < h; row++) {
      patch.set(indices.subarray((y + row) * this.width + x, (y + row) * this.width + x + w), row * w);
    }
    this.pending = { pixels: patch, x, y, w, h, delay: delayMs };
    this.prev.set(indices);
  }

  private diff(a: Uint8Array, b: Uint8Array) {
    let x0 = this.width, y0 = this.height, x1 = -1, y1 = -1;
    for (let y = 0; y < this.height; y++) {
      const row = y * this.width;
      for (let x = 0; x < this.width; x++) {
        if (a[row + x] === b[row + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        y1 = y;
      }
    }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  private flush() {
    const frame = this.pending;
    this.pending = null;
    if (!frame) return;
    const delay = Math.max(2, Math.round(frame.delay / 10));   // GIF 的单位是 1/100 秒
    const out: number[] = [];
    // 图形控制扩展：disposal = 1（留在原地），后面的帧只补差异矩形
    out.push(0x21, 0xf9, 0x04, 0x04, delay & 0xff, delay >> 8, 0, 0);
    out.push(0x2c, frame.x & 0xff, frame.x >> 8, frame.y & 0xff, frame.y >> 8,
             frame.w & 0xff, frame.w >> 8, frame.h & 0xff, frame.h >> 8, 0);
    out.push(this.minCodeSize);
    const bytes = lzw(frame.pixels, this.minCodeSize);
    for (let i = 0; i < bytes.length; i += 255) {
      const block = bytes.slice(i, i + 255);
      out.push(block.length, ...block);
    }
    out.push(0);
    this.chunks.push(out);
  }

  finish(): Uint8Array<ArrayBuffer> {
    this.flush();
    this.chunks.push([0x3b]);
    let size = 0;
    for (const chunk of this.chunks) size += chunk.length;
    const bytes = new Uint8Array(new ArrayBuffer(size));
    let at = 0;
    for (const chunk of this.chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    return bytes;
  }
}
