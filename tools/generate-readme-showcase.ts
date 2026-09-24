/* README 里的两张图：docs/type-sample.svg（效果展示）和 docs/quick-start.svg（快速上手）
 *
 * 字形是 tools/readme-showcase/ 里专门画的骨架（与示例字库无关），按 hand-glyph skill 的拙趣规矩写：
 * han.json 骨架直接画拙，表头是新建汉字工程的预设（amp 0.65 / over 0 / jit 1.3 / fit 12 / drift 1，
 * 和 src/lib/api.ts 一致）；英文骨架照规整写法画在 latin.json，展示用的是
 * `handdraw.py latin-zhuo` 从它生成的 latin-zhuo.json（变形 + 错落 2 + jit 1.3）。
 * 种子 42、汉字字距 0、拉丁字距 TRACK、词距 WORD，和编辑器的默认值一致。
 * 这里只负责把渲染好的字摆进画布，不改排版引擎给出的字距。
 *
 * 书写动画沿用编辑器「展示」的排程（src/lib/showcase.ts，常速）：一笔按弧长定时长，
 * 笔与笔、字与字之间各停一拍，起收笔缓动。README 里的图是 <img>，跑不了脚本，
 * 所以排程在这里算好，写成每一笔自己的 CSS keyframes；写完停一会儿，淡出，循环。 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { pathToPolys } from "../src/lib/core/flatten";
import { renderRow } from "../src/lib/core/render";
import { TRACK, WORD } from "../src/lib/core/row";
import type { GlyphLibrary } from "../src/lib/core/library";
import { GLYPH_GAP, MAX_MS, MIN_MS, MS_PER_UNIT, STROKE_GAP } from "../src/lib/showcase";

const root = resolve(import.meta.dirname, "..");
const SEED = 42; // 编辑器的 DEFAULT_VIEW_SEED

function library(name: string) {
  return JSON.parse(readFileSync(resolve(root, "tools/readme-showcase", name), "utf8")) as GlyphLibrary;
}

function line(text: string, glyphData: GlyphLibrary, mode: "han" | "latin", seed = SEED) {
  const { svg } = renderRow({
    text,
    seed,
    mode,
    ampk: Number(glyphData.jit ?? 1),
    amp: Number(glyphData.amp ?? 1),
    over: Number(glyphData.over ?? 1),
    varyk: Number(glyphData.vary ?? 1),
    glyphData,
    track: mode === "latin" ? TRACK : 0,
    word: mode === "latin" ? WORD : 0,
  });
  const [x, y, w, h] = (svg.match(/viewBox="([^"]+)"/)?.[1] ?? "").split(" ").map(Number);
  if (!Number.isFinite(h)) throw new Error(`No viewBox for ${text}`);
  // 没写逐笔 w 的笔画靠外层 <svg> 的 stroke-width，剥掉外壳时要带到这一行的 <g> 上。
  const sw = svg.match(/^<svg[^>]*stroke-width="([^"]+)"/)?.[1] ?? String(glyphData.sw);
  const body = svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  return { x, y, w, h, sw, body };
}

type Line = ReturnType<typeof line>;

/* ---------- 书写动画 ---------- */

const EASE = "cubic-bezier(0.455, 0.03, 0.515, 0.955)"; // easeInOutQuad，和 showcase 同一条曲线
const HOLD_MS = 3200;      // 写完整张停住，让人看清
const FADE_MS = 700;
const BLANK_MS = 500;      // 淡出后空一下再重写

function pathLength(d: string) {
  let total = 0;
  for (const [pts] of pathToPolys(d, 24)) {
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return total;
}

/** 一张图一条时间轴。先按顺序排好每一笔，最后按总时长换算成百分比关键帧。 */
class Timeline {
  cursor = 0;
  private strokes: Array<{ cls: string; len: number; start: number; dur: number }> = [];
  private reveals: Array<{ cls: string; start: number; dur: number }> = [];

  constructor(private prefix: string) {}

  /** 排一笔，返回它的 class。 */
  stroke(d: string) {
    const len = pathLength(d);
    const dur = Math.min(MAX_MS, Math.max(MIN_MS, len * MS_PER_UNIT));
    const cls = `${this.prefix}s${this.strokes.length}`;
    this.strokes.push({ cls, len, start: this.cursor, dur });
    this.cursor += dur;
    return cls;
  }

  /** 非笔画元素（文件卡片、端点）淡入，不占时间轴。 */
  reveal(start: number, dur = 260) {
    const cls = `${this.prefix}r${this.reveals.length}`;
    this.reveals.push({ cls, start: Math.max(0, start), dur });
    return cls;
  }

  /** 按行预览的 DOM 顺序排程：一个 <g> 一个字，字里 path 的顺序就是笔顺。 */
  glyphs(body: string) {
    let first = true;
    return body.replace(/<g transform="[^"]*">.*?<\/g>/g, (glyph) => {
      if (!first) this.cursor += GLYPH_GAP;
      first = false;
      let firstStroke = true;
      return glyph.replace(/<path d="([^"]*)"/g, (_tag, d: string) => {
        if (!firstStroke) this.cursor += STROKE_GAP;
        firstStroke = false;
        return `<path class="${this.stroke(d)}" d="${d}"`;
      });
    });
  }

  /** 生成整张图的 CSS。淡出只作用在 .<prefix>live 上：界格、卡片这些底子一直在。 */
  css() {
    const end = this.cursor;
    const cycle = Math.round(end + HOLD_MS + FADE_MS + BLANK_MS);
    const pct = (ms: number) => `${(ms / cycle * 100).toFixed(3)}%`;
    const anim = (cls: string) => `animation:${cls}k ${cycle}ms linear infinite`;
    const rules = this.strokes.map(({ cls, len, start, dur }) => {
      // 虚线留足余量：扁平化出来的弧长比真实曲线略短，差一点末端就会露出一截。
      // 没起笔时那段实线要整个退到起点之前再往后几个单位 —— 正好停在起点上的话，
      // 它的圆头会在起笔处留下一个墨点。
      const dash = len * 1.04 + 1;
      const hidden = (dash + 6).toFixed(2);
      return `.${cls}{stroke-dasharray:${dash.toFixed(2)} ${(dash + 12).toFixed(2)};${anim(cls)}}`
        + `@keyframes ${cls}k{0%,${pct(start)}{stroke-dashoffset:${hidden};animation-timing-function:${EASE}}`
        + `${pct(start + dur)},100%{stroke-dashoffset:0}}`;
    });
    for (const { cls, start, dur } of this.reveals) {
      rules.push(`.${cls}{${anim(cls)}}`
        + `@keyframes ${cls}k{0%,${pct(start)}{opacity:0;animation-timing-function:ease-out}${pct(start + dur)},100%{opacity:1}}`);
    }
    const live = `${this.prefix}live`;
    rules.push(`.${live}{${anim(live)}}`
      + `@keyframes ${live}k{0%,${pct(end + HOLD_MS)}{opacity:1}${pct(end + HOLD_MS + FADE_MS)},100%{opacity:0}}`);
    // 不想看动画的人直接给写完的那一张。
    rules.push(`@media (prefers-reduced-motion:reduce){.${live},.${live} *{animation:none!important;stroke-dasharray:none!important}}`);
    return rules.join("\n");
  }
}

/* ---------- 效果展示 ---------- */

const hanLib = library("han.json");
const latinLib = library("latin-zhuo.json");

function typeSample() {
  const W = 1200;
  const H = 400;
  const HAN_TEXT = "云在青山月在天";
  const LATIN_TEXT = "Clouds rest on the hills.";
  const LINE_GAP_MS = 600;   // 中文写完换到英文那一行，比字间多停一下
  const LATIN_WEIGHT = 0.8;

  const han = line(HAN_TEXT, hanLib, "han");
  let latin = line(LATIN_TEXT, latinLib, "latin");

  // 两行居中、宽度相近；拉丁字面矮，给英文多留一点宽度，视觉上两行才一样宽。
  const hanScale = 820 / han.w;
  const latinScale = 840 / latin.w;

  // 两行缩放倍率不同，同一个 sw 落到画布上英文会细一圈。按画布上的实际线宽
  // 反推英文的 sw，让两行笔画一样粗（汉字按逐笔提按 w 的平均值算）。线宽不参与
  // 排版，换 sw 重渲一遍不影响字距和 viewBox。
  const hanWs = Object.values(hanLib.items).flat().map((el) => Number(el.w ?? 1));
  // 英文做副标题再乘 0.8（skill 的 compose --sub-weight 0.8）：字母比汉字小，一样粗时英文显重。
  const hanStroke = hanLib.sw * (hanWs.reduce((a, b) => a + b, 0) / hanWs.length) * hanScale;
  latin = line(LATIN_TEXT, { ...latinLib, sw: hanStroke * LATIN_WEIGHT / latinScale }, "latin");
  const gap = 40;
  const top = (H - (han.h * hanScale + gap + latin.h * latinScale)) / 2;

  const t = new Timeline("t");
  han.body = t.glyphs(han.body);
  t.cursor += LINE_GAP_MS;
  latin.body = t.glyphs(latin.body);

  const place = (l: Line, scale: number, y: number) =>
    `<g transform="translate(${((W - l.w * scale) / 2).toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)}) translate(${-l.x} ${-l.y})" stroke-width="${l.sw}">${l.body}</g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">Yuragi 中英文手写字效果展示</title>
  <desc id="desc">中文“云在青山月在天”和英文“Clouds rest on the hills.”，按 hand-glyph 的拙趣规矩画、由 Yuragi 渲染。</desc>
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <style>
${t.css()}
  </style>
  <g class="tlive" fill="none" stroke="#09090B" stroke-linecap="round" stroke-linejoin="round">
    ${place(han, hanScale, top)}
    ${place(latin, latinScale, top + han.h * hanScale + gap)}
  </g>
</svg>
`;
}

/* ---------- 快速上手 ---------- */

function quickStart() {
  const W = 1200;
  const H = 400;
  const CHAR = "天";
  // 默认参数下单字的变化不大，随手挑的种子三个字几乎一样。这三个是在 1–600 里
  // 两两差异最大的一组（按落进格子后每笔采样点的平均位移算），大小、倾斜、笔长都分得开。
  const VARIANT_SEEDS = [149, 178, 406];
  const STEP_GAP_MS = 500;   // 一张卡写完，挪到下一张之前停一下
  const INK = "#09090B";

  const t = new Timeline("q");

  // 三张卡：外边距 24，卡间 20
  const pad = 24;
  const gutter = 20;
  const cardW = (W - pad * 2 - gutter * 2) / 3;
  const cardH = H - pad * 2;
  const cardX = (i: number) => pad + i * (cardW + gutter);
  const midX = (i: number) => cardX(i) + cardW / 2;
  const artTop = 146;                  // 标题区下面，插图区的上沿
  const artMid = artTop + (pad + cardH - 24 - artTop) / 2;
  const f = (n: number) => n.toFixed(2);

  const head = (i: number, step: string, title: string, caption: string) => {
    const x = f(cardX(i) + 30);
    return `<rect class="card" x="${f(cardX(i))}" y="${pad}" width="${f(cardW)}" height="${cardH}" rx="18"/>
  <text class="eyebrow" x="${x}" y="${pad + 38}">${step}</text>
  <text class="heading" x="${x}" y="${pad + 70}">${title}</text>
  <text class="caption" x="${x}" y="${pad + 97}">${caption}</text>`;
  };

  /* 01 骨架：田字格上的一副干净骨架，端点标出来 —— 编辑器里拖的就是这些点。 */
  const box = 180;
  const bx = midX(0) - box / 2;
  const by = artMid - box / 2;
  const k = box / 64;
  const grid = `<rect x="${f(bx)}" y="${f(by)}" width="${box}" height="${box}" rx="4" fill="none" stroke="#e6e6e0" stroke-width="1.2"/>
  <path d="M${f(bx + box / 2)} ${f(by)} v${box} M${f(bx)} ${f(by + box / 2)} h${box}" stroke="#ebebe5" stroke-width="1" stroke-dasharray="4 4"/>`;
  const nodes: string[] = [];
  const bones = hanLib.items[CHAR].map((el, i) => {
    const d = String(el.d);
    if (i) t.cursor += STROKE_GAP;
    const start = t.cursor;
    const cls = t.stroke(d);
    const [[pts]] = pathToPolys(d, 12);
    nodes.push(`<circle class="${t.reveal(start, 200)}" cx="${f(pts[0][0])}" cy="${f(pts[0][1])}" r="${f(3 / k)}"/>`);
    const [ex, ey] = pts[pts.length - 1];
    nodes.push(`<circle class="${t.reveal(t.cursor - 120, 200)}" cx="${f(ex)}" cy="${f(ey)}" r="${f(3 / k)}"/>`);
    return `<path class="${cls}" d="${d}"/>`;
  });
  const card1 = `${grid}
  <g class="qlive" transform="translate(${f(bx)} ${f(by)}) scale(${k.toFixed(4)})">
    <g fill="none" stroke="#3a3a35" stroke-width="${(2.2 / k).toFixed(3)}" stroke-linecap="round" stroke-linejoin="round">${bones.join("")}</g>
    <g fill="#fff" stroke="#8a8a82" stroke-width="${(1.3 / k).toFixed(3)}">${nodes.join("")}</g>
  </g>`;

  /* 02 变化：同一副骨架，换三个种子各写一遍。 */
  t.cursor += STEP_GAP_MS;
  const cell = 92;
  const cellGap = 12;
  const rowX = midX(1) - (cell * 3 + cellGap * 2) / 2;
  const s = cell / 64;
  const variants = VARIANT_SEEDS.map((seed, i) => {
    const g = line(CHAR, hanLib, "han", seed);
    if (i) t.cursor += GLYPH_GAP;
    const body = t.glyphs(g.body);
    const cx = rowX + i * (cell + cellGap) + cell / 2;
    const cy = artMid - 12;
    // 按引擎给的字面框居中；逐字的大小、倾斜保留原样。
    return `<g transform="translate(${f(cx)} ${f(cy)}) scale(${s.toFixed(4)}) translate(${f(-(g.x + g.w / 2))} ${f(-(g.y + g.h / 2))})" stroke-width="${g.sw}">${body}</g>
    <text class="mono" x="${f(cx)}" y="${f(cy + cell / 2 + 30)}" text-anchor="middle">seed ${seed}</text>`;
  });
  const card2 = `<g class="qlive" fill="none" stroke="${INK}" stroke-linecap="round" stroke-linejoin="round">
    ${variants.join("\n    ")}
  </g>`;

  /* 03 导出：一张 SVG 文件卡片，字在里面再写一遍。 */
  t.cursor += STEP_GAP_MS;
  const fw = 148;
  const fh = 172;
  const fx = midX(2) - fw / 2;
  const fy = artMid - fh / 2 - 10;
  const fold = 26;
  const tile = t.reveal(t.cursor, 320);
  t.cursor += 300;
  const ex = line(CHAR, hanLib, "han", SEED);
  const exBody = t.glyphs(ex.body);
  const es = 96 / 64;
  const card3 = `<g class="qlive">
    <g class="${tile}">
      <path d="M${fx} ${fy + 12} Q${fx} ${fy} ${fx + 12} ${fy} H${fx + fw - fold} L${fx + fw} ${fy + fold} V${fy + fh - 12} Q${fx + fw} ${fy + fh} ${fx + fw - 12} ${fy + fh} H${fx + 12} Q${fx} ${fy + fh} ${fx} ${fy + fh - 12} Z" fill="#fafaf7" stroke="#deded8" stroke-width="1.2"/>
      <path d="M${fx + fw - fold} ${fy} V${fy + fold - 8} Q${fx + fw - fold} ${fy + fold} ${fx + fw - fold + 8} ${fy + fold} H${fx + fw}" fill="none" stroke="#deded8" stroke-width="1.2"/>
      <rect x="${fx + 14}" y="${fy + 14}" width="40" height="19" rx="9.5" fill="#20201d"/>
      <text x="${fx + 34}" y="${fy + 27.5}" text-anchor="middle" font-size="10" font-weight="700" letter-spacing=".6" fill="#fff">SVG</text>
      <text class="file" x="${midX(2)}" y="${fy + fh + 28}" text-anchor="middle">${CHAR}.svg</text>
    </g>
    <g transform="translate(${midX(2)} ${fy + fh / 2 + 8}) scale(${es}) translate(${f(-(ex.x + ex.w / 2))} ${f(-(ex.y + ex.h / 2))})" fill="none" stroke="${INK}" stroke-width="${ex.sw}" stroke-linecap="round" stroke-linejoin="round">${exBody}</g>
  </g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">Yuragi 快速上手：画骨架、生成变化、导出 SVG</title>
  <desc id="desc">先画出“${CHAR}”的字形骨架，再用三个种子生成三种写法，最后导出为 SVG 文件。</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans SC", sans-serif; }
    .card { fill: #fff; stroke: #e6e6e0; stroke-width: 1.2; }
    .eyebrow { fill: #8a8a82; font-size: 12px; font-weight: 650; letter-spacing: 1.4px; }
    .heading { fill: #20201d; font-size: 22px; font-weight: 650; }
    .caption { fill: #6b6b64; font-size: 14px; }
    .mono { fill: #9a9a92; stroke: none; font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .file { fill: #50504a; font-size: 13px; font-weight: 600; }
${t.css()}
  </style>
  <rect width="${W}" height="${H}" rx="24" fill="#f5f5f1"/>
  ${head(0, "01 / SKELETON", "画出字形骨架", "每一笔是一条中心线，端点可以拖动")}
  ${head(1, "02 / VARIATION", "同一骨架，写法不同", "换个种子重写一遍，种子不变就能复现")}
  ${head(2, "03 / EXPORT", "导出为 SVG", "每一笔仍是可编辑的矢量路径")}
  ${card1}
  ${card2}
  ${card3}
</svg>
`;
}

writeFileSync(resolve(root, "docs/type-sample.svg"), typeSample());
writeFileSync(resolve(root, "docs/quick-start.svg"), quickStart());
