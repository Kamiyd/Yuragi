/* 排一行字：摆正 -> 逐字大小 -> 落格。

   这一层要的是「写偏了」，不是「画偏了」：手气全部来自这里的可控抖动，
   不来自字库里某个字画得偏了 —— 所以先按字面框把字拉回格子中央，再叠大小和位移。

   汉字一字一格等宽；拉丁每个字母各带 adv，绕基线缩放。两套的支点不一样，
   绕错了一行字的下沿会变成波浪。 */
import type { Point } from "./dpath";
import type { Poly } from "./flatten";
import { fmtFixed } from "./num";
import { jit } from "./rng";

export const PUNCT = new Set("，。？！、～…—·,.?!".split(""));

export const TRACK = 7.0;      // 拉丁字距
export const WORD = 26.0;      // 拉丁词距
export const BASELINE = 48.0;  // 拉丁基线
const DEAD = 1.5;              // 摆正死区
const CAP = 5.0;               // 摆正拉回量上限
const ROT = 1.5;               // 逐字旋转，度

export type PolysOf = (name: string | null, index: number) => Poly[];
export type SeedFor = (name: string | null, index: number) => number;
export type LocalFor = (name: string | null, index: number) => boolean;

export type LayoutItem = {
  name: string | null;
  sx: number;
  sy: number;
  rot: number;
  s: number;
  tf: string;
  face: [number, number, number, number];
  cx?: number;
  cy?: number;
  ax?: number;
  ay?: number;
  adv?: number;
  x?: number;
  dy?: number;
  baseline_dy?: number;
  source_index?: number;
};

export function bbox(polys: Poly[]): [number, number, number, number] {
  let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
  let seen = false;
  for (const [poly] of polys) {
    for (const p of poly) {
      seen = true;
      if (p[0] < x0) x0 = p[0];
      if (p[0] > x1) x1 = p[0];
      if (p[1] < y0) y0 = p[1];
      if (p[1] > y1) y1 = p[1];
    }
  }
  return seen ? [x0, y0, x1, y1] : [0, 0, 0, 0];
}

const VARIANT_SUFFIX = /^(.*?)(\d+)$/;

/** 取字形的可见字符；`露2` / `露3` 是同一个字的显式画法变体。 */
export function baseName(name: string): string {
  const text = String(name);
  const match = VARIANT_SUFFIX.exec(text);
  return match && match[1] ? match[1] : text;
}

function variantSortKey(name: string): [number, number, string] {
  const match = VARIANT_SUFFIX.exec(String(name));
  if (!match || !match[1]) return [0, 1, String(name)];
  return [1, Number(match[2]), String(name)];
}

function compareVariant(a: string, b: string): number {
  const ka = variantSortKey(a);
  const kb = variantSortKey(b);
  if (ka[0] !== kb[0]) return ka[0] - kb[0];
  if (ka[1] !== kb[1]) return ka[1] - kb[1];
  return ka[2] < kb[2] ? -1 : ka[2] > kb[2] ? 1 : 0;
}

/** 返回某个字的局部种子；没有局部覆盖时返回 null。 */
export function localSeed(seedMap: Record<string, number> | null | undefined, name: string | null): number | null {
  if (!seedMap || name === null || !Object.prototype.hasOwnProperty.call(seedMap, name)) return null;
  const value = Number(seedMap[name]);
  return Number.isFinite(value) ? Math.trunc(value) : null;
}

/** 局部种子优先，否则沿用当前行的全局种子。 */
export function effectiveSeed(seedMap: Record<string, number> | null | undefined,
                              name: string | null, fallback: number): number {
  const value = localSeed(seedMap, name);
  return value === null ? Math.trunc(fallback) : value;
}

/** 给底层笔迹一个稳定的局部分流；没有局部种子时保持旧结果。 */
export function handSeed(base: number, local: number | null = null): number {
  return local === null ? Math.trunc(base) : Math.trunc(base) + Math.trunc(local) * 1000003;
}

/** 文案 -> 字库里的内部名字。每次出现按变体顺序循环选择。 */
export function pick(text: string, avail: Iterable<string>): Array<[string | null, string, boolean]> {
  const variants = new Map<string, string[]>();
  for (const name of avail) {
    const base = baseName(name);
    const bucket = variants.get(base);
    if (bucket) bucket.push(name); else variants.set(base, [name]);
  }
  for (const names of variants.values()) names.sort(compareVariant);

  const seen = new Map<string, number>();
  const picked: Array<[string | null, string, boolean]> = [];
  for (const ch of Array.from(text)) {
    const options = variants.get(ch);
    if (!options || !options.length) { picked.push([null, ch, true]); continue; }
    const occurrence = seen.get(ch) ?? 0;
    picked.push([options[occurrence % options.length], ch, true]);
    seen.set(ch, occurrence + 1);
  }
  return picked;
}

/** 摆正：字面中心拉回格心，留死区、拉回量封顶。 */
export function align(polys: Poly[], cell: number): [number, number, [number, number, number, number]] {
  const [x0, y0, x1, y1] = bbox(polys);
  const ax = (x0 + x1) / 2;
  const ay = (y0 + y1) / 2;
  const c = cell / 2;
  const pull = (a: number) => {
    let d = c - a;
    if (Math.abs(d) <= DEAD) return a;
    d = Math.sign(d) * Math.min(Math.abs(d) - DEAD, CAP);
    return a + d;
  };
  return [pull(ax), pull(ay), [x0, y0, x1, y1]];
}

/** 相邻两个字至少差 3.5% —— 不摇大小就是一版字帖。 */
function scaleWithGap(prevRef: number | null, ampK: number, i: number, seed: number): number {
  let salt = 0;
  for (;;) {
    const s = 1 + jit(0.09 * ampK, i, seed, 17, salt);
    if (prevRef === null || Math.abs(s - prevRef) >= 0.035 * ampK || salt > 8) return s;
    salt += 1;
  }
}

export type HanLayoutOptions = {
  cell?: number;
  seed?: number;
  ampK?: number;
  punct?: Set<string>;
  seedFor?: SeedFor | null;
  localFor?: LocalFor | null;
  track?: number;
};

/** 汉字：一字一格。返回每个字的 transform 和实际占位框。 */
export function hanLayout(names: Array<string | null>, polysOf: PolysOf,
                          options: HanLayoutOptions = {}): LayoutItem[] {
  const { cell = 64, seed = 0, ampK = 1, punct = PUNCT, seedFor = null, localFor = null, track = 0 } = options;
  const out: LayoutItem[] = [];
  // 邻字间距约束参考全局种子的基准尺寸。这样局部重摇一个字时，
  // 不会因为 prev_s 被改写而把后面的字也连带换一版。
  let prevRefS: number | null = null;
  names.forEach((name, i) => {
    const itemSeed = seedFor ? seedFor(name, i) : seed;
    const polys = name ? polysOf(name, i) : [];
    const isPunct = punct.has((name ?? "").slice(0, 1));
    let ax: number;
    let ay: number;
    let face: [number, number, number, number];
    if (polys.length && !isPunct) {
      [ax, ay, face] = align(polys, cell);
    } else {
      const [x0, y0, x1, y1] = polys.length ? bbox(polys) : [0, 0, cell, cell];
      ax = (x0 + x1) / 2;
      ay = (y0 + y1) / 2;
      face = [x0, y0, x1, y1];
    }

    const refS = scaleWithGap(prevRefS, ampK, i, seed);
    let s: number;
    if (localFor && localFor(name, i)) {
      // 局部锁定字不能受全局种子或邻字约束牵连；否则全局换种子时，
      // 仅仅为了找一个"不相邻"的盐，锁定字自己的尺寸也会跟着跳。
      s = 1 + jit(0.09 * ampK, i, itemSeed, 17, 0);
    } else {
      s = scaleWithGap(prevRefS, ampK, i, itemSeed);
    }
    prevRefS = refS;
    const f = jit(0.035 * ampK, i, itemSeed, 91);          // 压扁抻长，面积不变
    const sx = s * (1 + f);
    const sy = s * (1 - f);
    const rot = jit(ROT * ampK, i, itemSeed, 43);
    const cx = (cell + track) * i + cell / 2 + jit(1.1 * ampK, i, itemSeed, 7);
    const cy = cell / 2 + jit(1.1 * ampK, i, itemSeed, 29);
    out.push({
      name, sx, sy, rot, cx, cy, ax, ay, face, s,
      tf: `translate(${fmtFixed(cx, 2)} ${fmtFixed(cy, 2)}) rotate(${fmtFixed(rot, 2)}) `
        + `scale(${fmtFixed(sx, 4)} ${fmtFixed(sy, 4)}) translate(${fmtFixed(-ax, 2)} ${fmtFixed(-ay, 2)})`,
    });
  });
  return out;
}

export type LatinLayoutOptions = {
  seed?: number;
  ampK?: number;
  baseline?: number;
  track?: number;
  word?: number;
  seedFor?: SeedFor | null;
  localFor?: LocalFor | null;
};

const DESCENDERS = new Set([",", ".", "y", "g", "p", "q", "j"]);

/** 拉丁：各带 adv，绕基线缩放，排版时按字面底边压到基线上。 */
export function latinLayout(names: Array<string | null>, polysOf: PolysOf,
                            advs: Record<string, number>,
                            options: LatinLayoutOptions = {}): [LayoutItem[], number] {
  const { seed = 0, ampK = 1, baseline = BASELINE, track = TRACK, word = WORD,
          seedFor = null, localFor = null } = options;
  const out: LayoutItem[] = [];
  let x = 0;
  let prevRefS: number | null = null;
  names.forEach((name, i) => {
    const itemSeed = seedFor ? seedFor(name, i) : seed;
    if (name === " ") { x += word + track; return; }
    const polys = name ? polysOf(name, i) : [];
    const adv = name !== null && advs[name] !== undefined ? Number(advs[name]) : 28.0;
    const [x0, y0, x1, y1] = polys.length ? bbox(polys) : [0, 0, adv, baseline];
    const descend = name !== null && DESCENDERS.has(name);
    const dy = descend ? 0 : baseline - y1;     // 压到基线；带下伸部的不动

    const refS = scaleWithGap(prevRefS, ampK, i, seed);
    let s: number;
    if (localFor && localFor(name, i)) s = 1 + jit(0.09 * ampK, i, itemSeed, 17, 0);
    else s = scaleWithGap(prevRefS, ampK, i, itemSeed);
    prevRefS = refS;
    const f = jit(0.035 * ampK, i, itemSeed, 91);
    const sx = s * (1 + f);
    const sy = s * (1 - f);
    const rot = jit(ROT * ampK, i, itemSeed, 43);
    out.push({
      name, source_index: i, sx, sy, rot, adv, x, dy, face: [x0, y0, x1, y1], s,
      tf: `translate(${fmtFixed(x + (adv * sx) / 2, 2)} ${fmtFixed(baseline, 2)}) rotate(${fmtFixed(rot, 2)}) `
        + `scale(${fmtFixed(sx, 4)} ${fmtFixed(sy, 4)}) `
        + `translate(${fmtFixed(-adv / 2, 2)} ${fmtFixed(dy - baseline, 2)})`,
    });
    x += adv * sx + track;
  });
  return [out, x - track];
}

/** 把每个字的 transform 算一遍，取整行的真实包围盒。 */
export function bounds(layout: LayoutItem[], polysOf: PolysOf, cell = 64): [number, number, number, number] {
  let X0 = 1e9;
  let Y0 = 1e9;
  let X1 = -1e9;
  let Y1 = -1e9;
  layout.forEach((g, i) => {
    const sourceIndex = g.source_index ?? i;
    const polys = g.name ? polysOf(g.name, sourceIndex) : [];
    if (!polys.length) return;
    const t = (g.rot * Math.PI) / 180;
    const ct = Math.cos(t);
    const st = Math.sin(t);
    const han = g.ax !== undefined;
    for (const [poly] of polys) {
      for (const [px, py] of poly as Point[]) {
        let X: number;
        let Y: number;
        if (han) {
          const ux = (px - (g.ax as number)) * g.sx;
          const uy = (py - (g.ay as number)) * g.sy;
          X = (g.cx as number) + ux * ct - uy * st;
          Y = (g.cy as number) + ux * st + uy * ct;
        } else {
          const ux = (px - (g.adv as number) / 2) * g.sx;
          const uy = (py + (g.dy as number) - BASELINE) * g.sy;
          X = (g.x as number) + ((g.adv as number) * g.sx) / 2 + ux * ct - uy * st;
          Y = BASELINE + ux * st + uy * ct;
        }
        X0 = Math.min(X0, X); X1 = Math.max(X1, X);
        Y0 = Math.min(Y0, Y); Y1 = Math.max(Y1, Y);
      }
    }
  });
  return X1 > X0 ? [X0, Y0, X1, Y1] : [0, 0, cell, cell];
}
