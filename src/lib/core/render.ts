/* 编辑器要的两种渲染：单字（画布 / 缩略图 / 导出）和整行（底下那条预览）。
   这一份是 edit.py 里 render / render_row 的移植。

   **render_row 的每一步都照抄 handdraw.write_lines 的单行分支** —— 种子怎么算、
   重写在哪一层、摆正拿哪份几何，全一样。所以同一个种子下，每个自动换行后的
   子行仍然就是 `write` 出的一行，不是「差不多的一行」。改动这个函数时对着那边一起改。 */
import { draw, pathMarkup, paramsOf, seedMap, type RenderPath } from "./draw";
import { pathToPolys, type Poly } from "./flatten";
import { fmtFixed, pyG, pyRound } from "./num";
import * as rowmod from "./row";
import { orderedGlyphNames, toGeo, type EditableElement, type GlyphLibrary } from "./library";
import { vary as varyGlyph, type GeoElement } from "./vary";

export type RowCell = { name: string | null; s: number; diff: number | null; thin: boolean };
export type RowResult = {
  svg: string;
  table: RowCell[];
  miss: string[];
  dup: string[];
  vb: [number, number];
  ratio: number;
  /** 自动换行后的行数；单行调用固定为 1。 */
  lineCount: number;
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
  /** 编辑器显式传入的字形顺序；旧调用不传时保持原有行为。 */
  glyphOrder?: string[];
  track?: number | null;
  word?: number;
  /** 预览区可用的 CSS 像素宽度；省略时保持旧的单行结果。 */
  maxWidth?: number | null;
  /** 单行预览字号对应的 CSS 像素高度，默认 44。 */
  lineHeight?: number;
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
  const names = orderedGlyphNames(g.items, options.glyphOrder);
  const glyphSeeds = seedMap(options.glyphSeeds === undefined || options.glyphSeeds === null
    ? g.glyphSeeds : options.glyphSeeds);
  const picked = rowmod.pick(text, names);
  const dup: string[] = [];          // 兼容旧 API；显式变体与叠字轮换都由 row.pick 处理
  const entries = picked.map(([name, ch], sourceIndex) => ({ name, char: ch, sourceIndex }));
  const miss = entries.filter(({ name }) => name === null).map(({ char }) => char);

  const advs: Record<string, number> = {};
  if (mode === "latin") {
    for (const [n, els] of Object.entries(g.items)) if (els.length) advs[n] = Number(els[0].adv ?? vb);
  }

  type RowGlyph = { transform: string; body: string };
  type RenderedLine = { glyphs: RowGlyph[]; table: RowCell[]; box: [number, number, number, number] };

  const renderLine = (lineEntries: typeof entries[number][], lineIndex: number): RenderedLine => {
    const seq = lineEntries.map(({ name }) => name);

    // 每一次出现都自己重写一遍 —— 跟 write 同一个种子公式；sourceIndex 让换行时
    // 同一个字仍然有稳定的局部流，lineIndex 只负责把不同的行分开。
    const geos = new Map<number, GeoElement[]>();
    seq.forEach((n, oi) => {
      if (!n || !(n in g.items)) return;
      const els = g.items[n].map(toGeo);
      const local = rowmod.localSeed(glyphSeeds, n);
      const sourceIndex = lineEntries[oi].sourceIndex;
      const varySeed = (local === null ? seed : local) * 131 + sourceIndex * 17 + lineIndex * 7;
      geos.set(oi, doVary ? varyGlyph(els, varySeed, vb, varyk) : els);
    });

    const itemSeed = (name: string | null) => rowmod.effectiveSeed(glyphSeeds, name, seed + lineIndex);
    const polys: rowmod.PolysOf = (n, oi) => {
      const els = geos.has(oi)
        ? (geos.get(oi) as GeoElement[])
        : (n && g.items[n] ? g.items[n].map(toGeo) : []);
      const out: Poly[] = [];
      for (const el of els) if ((el.t ?? "path") === "path") out.push(...pathToPolys(String(el.d ?? "")));
      return out;
    };

    let layout: rowmod.LayoutItem[];
    if (mode === "latin") {
      [layout] = rowmod.latinLayout(seq.map((n) => n ?? " "), polys, advs, {
        seed: seed + lineIndex, ampK: ampk, track, word,
        seedFor: (name) => itemSeed(name),
        localFor: (name) => rowmod.localSeed(glyphSeeds, name) !== null,
      });
      for (const it of layout) it.baseline_dy = it.dy;
    } else {
      layout = rowmod.hanLayout(seq, polys, {
        cell: vb, seed: seed + lineIndex, ampK: ampk, track,
        seedFor: (name) => itemSeed(name),
        localFor: (name) => rowmod.localSeed(glyphSeeds, name) !== null,
      });
    }

    const box = rowmod.bounds(layout, polys, vb);
    const glyphs: RowGlyph[] = [];
    layout.forEach((it, layoutIndex) => {
      const oi = it.source_index ?? layoutIndex;
      const n = it.name;
      if (!geos.has(oi) || !n) return;
      // idx 决定笔迹的种子；每次出现都换一个，两个「天」的线也不会同一个抖法
      const sourceIndex = lineEntries[oi]?.sourceIndex ?? oi;
      const paths = draw(geos.get(oi) as GeoElement[],
        rowmod.handSeed(names.indexOf(n) + 97 * sourceIndex + 977 * lineIndex,
          rowmod.localSeed(glyphSeeds, n)),
        vb / 24, gAmp, gOver);
      glyphs.push({ transform: it.tf, body: pathMarkup(paths, sw) });
    });

    let prev: number | null = null;
    const table: RowCell[] = [];
    for (const it of layout) {
      const d = prev === null ? null : Math.abs(it.s - prev) * 100;
      table.push({
        name: it.name,
        s: pyRound(it.s, 3),
        diff: d === null ? null : pyRound(d, 1),
        thin: d !== null && d < 3.5 * ampk,
      });
      prev = it.s;
    }
    return { glyphs, table, box };
  };

  const pad = 5.0;

  /* 用实际渲染后的 viewBox 宽高决定是否换行，而不是只数字符。
     拉丁字有不同的 adv 和字面高度，直接按字符估算会让窄体字在横向溢出，
     或让矮体字被不必要地提前折行。每个候选子行只在排版时渲染一次，
     这样换行边界和最终显示的字号完全一致。 */
  const maxWidth = Number(options.maxWidth);
  const lineHeight = Number.isFinite(Number(options.lineHeight)) && Number(options.lineHeight) > 0
    ? Number(options.lineHeight)
    : 44;
  const lineWidthAtPreviewHeight = (line: RenderedLine) => {
    const [x0, y0, x1, y1] = line.box;
    const width = (x1 - x0) + 2 * pad;
    const height = (y1 - y0) + 2 * pad;
    return height > 0 ? width * lineHeight / height : width;
  };
  const wrapEntries = (): Array<{ entries: typeof entries; rendered: RenderedLine }> => {
    const renderWhole = () => ({ entries, rendered: renderLine(entries, 0) });
    if (!Number.isFinite(maxWidth) || maxWidth <= 0 || entries.length <= 1) return [renderWhole()];

    const lines: Array<{ entries: typeof entries; rendered: RenderedLine }> = [];
    let line: typeof entries = [];
    let rendered: RenderedLine | null = null;
    for (const entry of entries) {
      const candidate = [...line, entry];
      const candidateRendered = renderLine(candidate, lines.length);
      // 单个字再宽也必须落行，否则一个超宽字会触发无穷拆分。
      if (line.length && lineWidthAtPreviewHeight(candidateRendered) > maxWidth) {
        lines.push({ entries: line, rendered: rendered as RenderedLine });
        line = [entry];
        rendered = renderLine(line, lines.length);
      } else {
        line = candidate;
        rendered = candidateRendered;
      }
    }
    if (line.length && rendered) lines.push({ entries: line, rendered });
    return lines.length ? lines : [renderWhole()];
  };

  const lines = wrapEntries();

  // 保持未启用自动换行时的 SVG 字符串完全不变，老的 parity fixtures 也继续有效。
  if (lines.length === 1) {
    const [x0, y0, x1, y1] = lines[0].rendered.box;
    const vbw = (x1 - x0) + 2 * pad;
    const vbh = (y1 - y0) + 2 * pad;
    const body = lines[0].rendered.glyphs.map(({ transform, body }) => `<g transform="${transform}">${body}</g>`).join("");
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${fmtFixed(x0 - pad, 2)} ${fmtFixed(y0 - pad, 2)} `
      + `${fmtFixed(vbw, 2)} ${fmtFixed(vbh, 2)}" fill="none" stroke="currentColor" `
      + `stroke-width="${pyG(sw)}" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
    return {
      svg, table: lines[0].rendered.table, miss, dup, vb: [vbw, vbh], ratio: vbh ? vbw / vbh : 1, lineCount: 1,
    };
  }

  // 多行共用一个 viewBox，但每个字都直接带上该行的平移和等比缩放，根节点的
  // children 仍然是逐字 group。每行先归一到同一个内部行高，再由预览 SVG
  // 统一映射到 44px，因此不同字面高度不会让某些行看起来被压扁。
  const lineUnit = Math.max(...lines.map(({ rendered: line }) => {
    const [, y0, , y1] = line.box;
    return Math.max(1, (y1 - y0) + 2 * pad);
  }));
  let width = 0;
  let y = pad;
  const parts: string[] = [];
  for (const { rendered: line } of lines) {
    const [x0, y0, x1, y1] = line.box;
    const lineVbw = (x1 - x0) + 2 * pad;
    const lineVbh = (y1 - y0) + 2 * pad;
    const scale = lineUnit / lineVbh;
    width = Math.max(width, lineVbw * scale);
    const lineTransform = `translate(${fmtFixed(pad - (x0 - pad) * scale, 2)} `
      + `${fmtFixed(y - (y0 - pad) * scale, 2)}) scale(${fmtFixed(scale, 4)})`;
    for (const glyph of line.glyphs) {
      parts.push(`<g transform="${lineTransform} ${glyph.transform}">${glyph.body}</g>`);
    }
    y += lineUnit + 7.0;
  }
  const height = y - 7.0 + pad;
  const vbw = width + 2 * pad;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmtFixed(vbw, 2)} ${fmtFixed(height, 2)}" `
    + `fill="none" stroke="currentColor" stroke-width="${pyG(sw)}" stroke-linecap="round" `
    + `stroke-linejoin="round">${parts.join("")}</svg>`;
  return {
    svg, table: lines.flatMap(({ rendered: line }) => line.table), miss, dup,
    vb: [vbw, height], ratio: height ? vbw / height : 1, lineCount: lines.length,
  };
}

export { paramsOf };
