/* 编辑器要的两种渲染：单字（画布 / 缩略图 / 导出）和整行（底下那条预览）。
   这一份是 edit.py 里 render / render_row 的移植。

   **render_row 的每一步都照抄 handdraw.write_lines 的单行分支** —— 种子怎么算、
   重写在哪一层、摆正拿哪份几何，全一样。所以同一个种子下，这条预览就是
   `write` 出的那一行，不是「差不多的一行」。改动这个函数时对着那边一起改。 */
import { draw, pathMarkup, paramsOf, seedMap, type RenderPath } from "./draw";
import { pathToPolys, type Poly } from "./flatten";
import { fmtFixed, pyG, pyRound } from "./num";
import * as rowmod from "./row";
import { toGeo, type EditableElement, type GlyphLibrary } from "./library";
import { vary as varyGlyph, type GeoElement } from "./vary";

export type RowCell = { name: string | null; s: number; diff: number | null; thin: boolean };
export type RowResult = {
  svg: string;
  table: RowCell[];
  miss: string[];
  dup: string[];
  vb: [number, number];
  ratio: number;
};

/** 一个字的手绘路径。idx 必须是它在字库里的真实序号 —— 种子按序号算。 */
export function render(vb: number, idx: number, items: EditableElement[],
                       gAmp = 1, gOver = 1, local: number | null = null): RenderPath[] {
  return draw(items.map(toGeo), rowmod.handSeed(idx, local), vb / 24, gAmp, gOver);
}

export type RowOptions = {
  text: string;
  seed: number;
  ampk?: number;
  mode?: "han" | "latin";
  amp?: number;
  over?: number;
  vary?: boolean;
  varyk?: number;
  glyphSeeds?: Record<string, number> | null;
  glyphData: GlyphLibrary;
  track?: number | null;
  word?: number;
};

export function renderRow(options: RowOptions): RowResult {
  const {
    text, seed, ampk = 1, mode = "han", amp: gAmp = 1, over: gOver = 1,
    vary: doVary = true, varyk = 1, glyphData: g,
  } = options;
  const track = options.track === null || options.track === undefined
    ? (mode === "latin" ? rowmod.TRACK : 0)
    : Number(options.track);
  // 编辑器不再自动判定词边界；只有显式的旧 API 调用才会启用额外词距。
  const word = options.word === undefined ? 0 : Number(options.word);
  const vb = Number(g.vb ?? 64);
  const sw = Number(g.sw ?? 2.8);
  const names = Object.keys(g.items);
  const glyphSeeds = seedMap(options.glyphSeeds === undefined || options.glyphSeeds === null
    ? g.glyphSeeds : options.glyphSeeds);
  const picked = rowmod.pick(text, names);

  const miss = picked.filter(([nm]) => nm === null).map(([, ch]) => ch);
  const dup: string[] = [];          // 兼容旧 API；显式变体与叠字轮换都由 row.pick 处理
  const seq = picked.map(([nm]) => nm);

  // 每一次出现都自己重写一遍 —— 跟 write 同一个种子公式（li=0 这一行）
  const geos = new Map<number, GeoElement[]>();
  seq.forEach((n, oi) => {
    if (!n || !(n in g.items)) return;
    const els = g.items[n].map(toGeo);
    const local = rowmod.localSeed(glyphSeeds, n);
    const varySeed = (local === null ? seed : local) * 131 + oi * 17;
    geos.set(oi, doVary ? varyGlyph(els, varySeed, vb, varyk) : els);
  });

  const itemSeed = (name: string | null) => rowmod.effectiveSeed(glyphSeeds, name, seed);
  const polys: rowmod.PolysOf = (n, oi) => {
    const els = geos.has(oi)
      ? (geos.get(oi) as GeoElement[])
      : (n && g.items[n] ? g.items[n].map(toGeo) : []);
    const out: Poly[] = [];
    for (const el of els) if ((el.t ?? "path") === "path") out.push(...pathToPolys(String(el.d ?? "")));
    return out;
  };

  let L: rowmod.LayoutItem[];
  if (mode === "latin") {
    const advs: Record<string, number> = {};
    for (const [n, els] of Object.entries(g.items)) if (els.length) advs[n] = Number(els[0].adv ?? vb);
    [L] = rowmod.latinLayout(seq.map((n) => n ?? " "), polys, advs, {
      seed, ampK: ampk, track, word,
      seedFor: (name) => itemSeed(name),
      localFor: (name) => rowmod.localSeed(glyphSeeds, name) !== null,
    });
    for (const it of L) it.baseline_dy = it.dy;
  } else {
    L = rowmod.hanLayout(seq, polys, {
      cell: vb, seed, ampK: ampk, track,
      seedFor: (name) => itemSeed(name),
      localFor: (name) => rowmod.localSeed(glyphSeeds, name) !== null,
    });
  }

  const [x0, y0, x1, y1] = rowmod.bounds(L, polys, vb);
  const pad = 5.0;
  const vbx = x0 - pad;
  const vby = y0 - pad;
  const vbw = (x1 - x0) + 2 * pad;
  const vbh = (y1 - y0) + 2 * pad;

  const body: string[] = [];
  L.forEach((it, layoutIndex) => {
    const oi = it.source_index ?? layoutIndex;
    const n = it.name;
    if (!geos.has(oi) || !n) return;
    // idx 决定笔迹的种子；每次出现都换一个，两个「天」的线也不会同一个抖法
    const paths = draw(geos.get(oi) as GeoElement[],
      rowmod.handSeed(names.indexOf(n) + 97 * oi, rowmod.localSeed(glyphSeeds, n)),
      vb / 24, gAmp, gOver);
    body.push(`<g transform="${it.tf}">${pathMarkup(paths, sw)}</g>`);
  });

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmtFixed(vbx, 2)} ${fmtFixed(vby, 2)} `
    + `${fmtFixed(vbw, 2)} ${fmtFixed(vbh, 2)}" fill="none" stroke="currentColor" `
    + `stroke-width="${pyG(sw)}" stroke-linecap="round" stroke-linejoin="round">${body.join("")}</svg>`;

  let prev: number | null = null;
  const table: RowCell[] = [];
  for (const it of L) {
    const d = prev === null ? null : Math.abs(it.s - prev) * 100;
    table.push({
      name: it.name,
      s: pyRound(it.s, 3),
      diff: d === null ? null : pyRound(d, 1),
      thin: d !== null && d < 3.5 * ampk,
    });
    prev = it.s;
  }
  return { svg, table, miss, dup, vb: [vbw, vbh], ratio: vbh ? vbw / vbh : 1 };
}

export { paramsOf };
