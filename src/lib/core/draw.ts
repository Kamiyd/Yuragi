/* handdraw.py 的浏览器版：几何 JSON -> 手绘路径 -> SVG。

   **真相层是几何 JSON，不是跑出来的 path。** 骨架按规规矩矩的样子画，
   手感由滤镜统一加。滤镜是确定性的：同一份几何 + 同一个顺序 = 同一条路径。
   种子按字在字库里的**顺序**算，所以新字往字库的**末尾**加。 */
import { hand } from "./hand";
import { circleToPoly, corners, dedupe, pathToPolys, rectToPoly, type Poly } from "./flatten";
import type { Point } from "./dpath";
import { fmtFixed, pyG, pyRound, hypot } from "./num";
import * as rowmod from "./row";
import { vary as varyGlyph, type GeoElement } from "./vary";

// ── 滤镜参数（24 网格上的手感，其它网格按 vb/24 等比放大）──────────────
// 抖动幅度按**弧长**分档：三五个单位长的短笔画按大图形那个幅度抖会直接散掉。
const AMP_SHORT = 0.14;
const AMP_MID = 0.24;
const AMP_LONG = 0.34;
export const TRACE_AMP = 0.65;   // 保留手迹也保留手感；旧数据里的 amp=0 视为历史默认值
const LEN_SHORT = 5.0;
const LEN_MID = 11.0;
const OVER_SHORT = 0.28;
const OVER_LONG = 0.5;           // 收笔越位：闭合图形不越位
const CORNER_DEG = 32;           // 转向超过这个角度算硬角，滤镜在那儿收着
const STEP = 1.35;               // 重采样步长：直接决定曲线段数，也就是体积
const SIMPLIFY = 0.45;           // 进滤镜前的抽稀：圆/圆弧的密点先合并掉
const PREC = 2;                  // 坐标小数位 —— 1 位在 0.45 长的越位段上会把切线量化歪，
                                 // 折出半径 0.1 的假弯，Figma 这类「描边转轮廓再填充」的渲染器就缺角

export type RenderPath = { d: string; f?: boolean; w?: number };
export type GlyphItems = Record<string, GeoElement[]>;

/** 把路径里的数字压到 PREC 位，去掉没用的 0 和多余空格。 */
export function roundPath(d: string): string {
  const out: string[] = [];
  let num = "";
  for (const ch of `${d} `) {
    if ((ch >= "0" && ch <= "9") || ch === "." || ch === "-") {
      num += ch;
      continue;
    }
    if (num) {
      const v = pyRound(Number(num), PREC);
      let s = fmtFixed(v, PREC).replace(/0+$/, "").replace(/\.$/, "");
      if (s === "" || s === "-0") s = "0";
      const last = out.length ? out[out.length - 1] : null;
      if (last !== null && !"MCLZ ".includes(last) && !s.startsWith("-")) out.push(" ");
      out.push(s);
      num = "";
    }
    if (ch !== " ") out.push(ch);
  }
  return out.join("");
}

type StrokePoly = [Point[], boolean, boolean, number, number];  // 折线, 闭合, 填充, 幅度, 线重

/** 一个字的笔画表 -> [(折线, 是否闭合, 是否填充, 幅度倍率, 线重倍率)] */
export function polysOf(items: GeoElement[]): StrokePoly[] {
  const out: StrokePoly[] = [];
  for (const el of items) {
    const t = el.t ?? "path";
    const fill = Boolean(el.fill);
    let amp = Number(el.amp ?? 1);
    // 早期"保留手迹"用 amp=0 代表不改几何，结果也把种子驱动的线条手感关掉了。
    if (el.traceMode === "original" && Math.abs(amp) < 1e-9) amp = TRACE_AMP;
    const w = Number(el.w ?? 1);
    const num = (k: string, d = 0) => Number((el as Record<string, unknown>)[k] ?? d);
    let polys: Poly[];
    if (t === "path") polys = pathToPolys(String(el.d ?? ""));
    else if (t === "rect") polys = [rectToPoly(num("x"), num("y"), num("width"), num("height"), num("rx"))];
    else if (t === "circle") polys = [circleToPoly(num("cx"), num("cy"), num("r"))];
    else if (t === "ellipse") polys = [circleToPoly(num("cx"), num("cy"), num("rx"), 40, num("ry"))];
    else throw new Error(`未知元素类型 ${t} —— 只支持 path / rect / circle / ellipse`);
    for (const [poly, closed] of polys) out.push([poly, closed || fill, fill, amp, w]);
  }
  return out;
}

/** 一个字的全部手绘路径。idx 决定种子，所以笔顺不能乱。 */
export function draw(items: GeoElement[], idx: number, scale: number, gAmp = 1, gOver = 1): RenderPath[] {
  const ds: RenderPath[] = [];
  polysOf(items).forEach(([rawPoly, closed, fill, ampk, wk], k) => {
    const poly = dedupe(rawPoly, SIMPLIFY * scale);
    if (poly.length < 2) return;
    let L = 0;
    for (let i = 0; i < poly.length - 1; i += 1) {
      L += hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1]);
    }
    const base = L < LEN_SHORT * scale ? AMP_SHORT : L < LEN_MID * scale ? AMP_MID : AMP_LONG;
    const over = closed ? 0 : (L < 7 * scale ? OVER_SHORT : OVER_LONG);
    const d = hand(poly, {
      seed: idx * 7 + k * 3 + 1,
      amp: base * scale * ampk * gAmp,
      closed,
      sharp: corners(poly, closed, CORNER_DEG),
      over: over * scale * gOver,
      step: STEP * scale,
    });
    const item: RenderPath = { d: roundPath(d) };
    if (fill) item.f = true;
    if (Math.abs(wk - 1) > 1e-6) item.w = pyRound(wk, 3);
    ds.push(item);
  });
  return ds;
}

/* 版式：汉字一字一格，拉丁各带 adv 绕基线排。两套的支点不一样，
   混在一个字库里只能二选一 —— 所以它是**字库级的选择**，写在文件上。

   老文件没有这个字段，按「有没有 adv」推断（跟以前一模一样）；空的新库推断不出来，
   这正是要显式记一笔的原因：新建一个拉丁库时它还一个字母都没有。 */
export type LayoutMode = "han" | "latin";

export function readMode(value: unknown): LayoutMode | undefined {
  return value === "han" || value === "latin" ? value : undefined;
}

export function inferMode(items: GlyphItems | undefined): LayoutMode {
  const values = Object.values(items ?? {});
  return values.some((els) => els.length && els[0] && els[0].adv !== undefined) ? "latin" : "han";
}

export function layoutMode(g: { mode?: LayoutMode; items?: GlyphItems }): LayoutMode {
  return readMode(g.mode) ?? inferMode(g.items);
}

// 字库级手感参数：默认全是 1.0（= 不改变现有行为，老文件照跑）
export const PARAMS = ["amp", "over", "jit", "vary"] as const;
export type Params = { amp: number; over: number; jit: number; vary: number };

export function paramsOf(g: Record<string, unknown>): Params {
  const read = (k: string) => {
    const value = Number(g?.[k] ?? 1);
    return Number.isFinite(value) ? value : 1;
  };
  return { amp: read("amp"), over: read("over"), jit: read("jit"), vary: read("vary") };
}

/** 清洗可选的逐字种子表；旧字库没有这个字段也完全兼容。 */
export function seedMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [name, seed] of Object.entries(value as Record<string, unknown>)) {
    const n = Number(seed);
    if (Number.isFinite(n)) out[String(name)] = Math.trunc(n);
  }
  return out;
}

/** 读取编辑器写回的全局种子；没有设置时返回 fallback。 */
export function previewSeed(value: unknown, fallback: number | null = null): number | null {
  const seed = Number(value);
  if (!Number.isFinite(seed)) return fallback;
  const int = Math.trunc(seed);
  return int > 0 ? int : fallback;
}

export function svgMarkup(paths: RenderPath[], size: number, vb: number, sw: number, extra = ""): string {
  const one = (p: RenderPath) => {
    if (p.f) return `<path d="${p.d}" fill="currentColor" stroke="none"/>`;
    if (p.w) return `<path d="${p.d}" stroke-width="${pyG(sw * p.w)}"/>`;
    return `<path d="${p.d}"/>`;
  };
  const ps = paths.map(one).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" `
    + `viewBox="0 0 ${pyG(vb)} ${pyG(vb)}" fill="none" stroke="currentColor" `
    + `stroke-width="${pyG(sw)}" stroke-linecap="round" stroke-linejoin="round"${extra}>${ps}</svg>`;
}

export function pathMarkup(paths: RenderPath[], sw: number): string {
  return paths.map((p) => (p.f
    ? `<path d="${p.d}" fill="currentColor" stroke="none"/>`
    : p.w
      ? `<path d="${p.d}" stroke-width="${pyG(sw * p.w)}"/>`
      : `<path d="${p.d}"/>`)).join("");
}

export type RawLibrary = {
  vb?: number;
  mode?: LayoutMode;
  sw?: number;
  amp?: number;
  over?: number;
  jit?: number;
  vary?: number;
  track?: number;
  word?: number;
  seed?: number | null;
  glyphSeeds?: Record<string, number>;
  items: GlyphItems;
  [key: string]: unknown;
};

/** 一行或多行字 -> 一整张 SVG。多行放进同一个 viewBox，两行绑在一起缩。 */
export function writeLines(g: RawLibrary, text: string, seed: number, doVary = true): [string, number] {
  const lines = text.replace(/\//g, "\n").split("\n").filter((l) => l !== "");
  const blocks: Array<{ body: string; box: [number, number, number, number]; sw: number; vb: number }> = [];
  let W = 0;
  lines.forEach((line, li) => {
    const mode = line.trim() && layoutMode(g) === "latin" ? "latin" : "han";
    const vb = Number(g.vb ?? 64);
    const sw = Number(g.sw ?? 2.8);
    const p = paramsOf(g);
    const names = Object.keys(g.items);
    const glyphSeeds = seedMap(g.glyphSeeds);
    const picked = rowmod.pick(line, names);
    const seq = picked.map(([n]) => n);

    // 每一次出现都自己重写一遍；如果字库还有 `天2` 等显式变体，pick 会轮换它们
    const geos = new Map<number, GeoElement[]>();
    seq.forEach((n, oi) => {
      if (!n || !(n in g.items)) return;
      const els = g.items[n];
      const local = rowmod.localSeed(glyphSeeds, n);
      const varySeed = (local === null ? seed : local) * 131 + oi * 17 + li * 7;
      geos.set(oi, doVary ? varyGlyph(els, varySeed, vb, p.vary) : els.map((e) => ({ ...e })));
    });

    const itemSeed = (name: string | null) => rowmod.effectiveSeed(glyphSeeds, name, seed + li);
    const polys: rowmod.PolysOf = (n, oi) => {
      const els = geos.has(oi) ? (geos.get(oi) as GeoElement[]) : (n && g.items[n]) || [];
      const out: Poly[] = [];
      for (const el of els) if ((el.t ?? "path") === "path") out.push(...pathToPolys(String(el.d ?? "")));
      return out;
    };

    let L: rowmod.LayoutItem[];
    if (mode === "latin") {
      const advs: Record<string, number> = {};
      for (const [n, e] of Object.entries(g.items)) if (e.length) advs[n] = Number(e[0].adv ?? vb);
      [L] = rowmod.latinLayout(seq.map((n) => n ?? " "), polys, advs, {
        seed: seed + li,
        ampK: p.jit,
        seedFor: (name) => itemSeed(name),
        localFor: (name) => rowmod.localSeed(glyphSeeds, name) !== null,
      });
      for (const it of L) it.baseline_dy = it.dy;
    } else {
      L = rowmod.hanLayout(seq, polys, {
        cell: vb,
        seed: seed + li,
        ampK: p.jit,
        seedFor: (name) => itemSeed(name),
        localFor: (name) => rowmod.localSeed(glyphSeeds, name) !== null,
      });
    }

    const body: string[] = [];
    L.forEach((it, layoutIndex) => {
      const oi = it.source_index ?? layoutIndex;
      const n = it.name;
      if (!geos.has(oi) || !n) return;
      // idx 决定笔迹的种子；每次出现都换一个，两个「天」的线也不会同一个抖法
      const paths = draw(geos.get(oi) as GeoElement[],
        rowmod.handSeed(names.indexOf(n) + 97 * oi + 977 * li, rowmod.localSeed(glyphSeeds, n)),
        vb / 24, p.amp, p.over);
      body.push(`<g transform="${it.tf}">${pathMarkup(paths, sw)}</g>`);
    });
    const box = rowmod.bounds(L, polys, vb);
    blocks.push({ body: body.join(""), box, sw, vb });
    W = Math.max(W, box[2] - box[0]);
  });

  const pad = 5.0;
  const gap = 7.0;
  const parts: string[] = [];
  let y = pad;
  for (const b of blocks) {
    const [x0, y0, , y1] = b.box;
    parts.push(`<g transform="translate(${fmtFixed(pad - x0, 2)} ${fmtFixed(y - y0, 2)})" `
      + `stroke-width="${pyG(b.sw)}">${b.body}</g>`);
    y += (y1 - y0) + gap;
  }
  const H = y - gap + pad;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmtFixed(W + 2 * pad, 2)} ${fmtFixed(H, 2)}" `
    + `fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${parts.join("")}</svg>`;
  return [svg, (W + 2 * pad) / H];
}
