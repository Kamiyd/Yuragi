/* README 效果展示图：docs/type-sample.svg
 *
 * 字形是 tools/readme-showcase/ 里两份专门画的骨架（与示例字库无关），
 * 参数全部是新建工程的默认预设：sw / amp / jit / vary 取自 src/lib/api.ts，
 * 种子 42、汉字字距 0、拉丁字距 TRACK、词距 WORD，和编辑器的默认值一致。
 * 这里只负责把渲染好的两行摆进画布，不改排版引擎给出的字距。
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

function line(text: string, glyphData: GlyphLibrary, mode: "han" | "latin") {
  const { svg } = renderRow({
    text,
    seed: SEED,
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

const W = 1200;
const H = 400;

const hanLib = library("han.json");
const latinLib = library("latin.json");
const HAN_TEXT = "云在青山月在天";
const LATIN_TEXT = "Clouds rest on the hills.";

const han = line(HAN_TEXT, hanLib, "han");
let latin = line(LATIN_TEXT, latinLib, "latin");

// 两行居中、宽度相近；拉丁字面矮，给英文多留一点宽度，视觉上两行才一样宽。
const hanScale = 820 / han.w;
const latinScale = 840 / latin.w;

// 两行缩放倍率不同，同一个 sw 落到画布上英文会细一圈。按画布上的实际线宽
// 反推英文的 sw，让两行笔画一样粗（汉字按逐笔提按 w 的平均值算）。线宽不参与
// 排版，换 sw 重渲一遍不影响字距和 viewBox。
const hanWs = Object.values(hanLib.items).flat().map((el) => Number(el.w ?? 1));
const hanStroke = hanLib.sw * (hanWs.reduce((a, b) => a + b, 0) / hanWs.length) * hanScale;
latin = line(LATIN_TEXT, { ...latinLib, sw: hanStroke / latinScale }, "latin");
const gap = 40;
const top = (H - (han.h * hanScale + gap + latin.h * latinScale)) / 2;

/* ---------- 书写动画 ---------- */

const LINE_GAP_MS = 600;   // 中文写完换到英文那一行，比字间多停一下
const HOLD_MS = 3200;      // 写完整张停住，让人看清
const FADE_MS = 700;
const BLANK_MS = 500;      // 淡出后空一下再重写
const EASE = "cubic-bezier(0.455, 0.03, 0.515, 0.955)"; // easeInOutQuad，和 showcase 同一条曲线

type Stroke = { len: number; start: number; dur: number };
const strokes: Stroke[] = [];
let cursor = 0;

function pathLength(d: string) {
  let total = 0;
  for (const [pts] of pathToPolys(d, 24)) {
    for (let i = 1; i < pts.length; i++) total += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  }
  return total;
}

/** 按行预览的 DOM 顺序排程：一个 <g> 一个字，字里 path 的顺序就是笔顺。 */
function schedule(body: string) {
  let first = true;
  return body.replace(/<g transform="[^"]*">.*?<\/g>/g, (glyph) => {
    if (!first) cursor += GLYPH_GAP;
    first = false;
    let firstStroke = true;
    return glyph.replace(/<path d="([^"]*)"/g, (tag, d: string) => {
      if (!firstStroke) cursor += STROKE_GAP;
      firstStroke = false;
      const len = pathLength(d);
      const dur = Math.min(MAX_MS, Math.max(MIN_MS, len * MS_PER_UNIT));
      strokes.push({ len, start: cursor, dur });
      cursor += dur;
      return `<path class="s${strokes.length - 1}" d="${d}"`;
    });
  });
}

han.body = schedule(han.body);
cursor += LINE_GAP_MS;
latin.body = schedule(latin.body);

const cycle = Math.round(cursor + HOLD_MS + FADE_MS + BLANK_MS);
const pct = (ms: number) => `${(ms / cycle * 100).toFixed(3)}%`;
const css = strokes.map(({ len, start, dur }, i) => {
  // 虚线留足余量：扁平化出来的弧长比真实曲线略短，差一点末端就会露出一截。
  // 没起笔时那段实线要整个退到起点之前再往后几个单位 —— 正好停在起点上的话，
  // 它的圆头会在起笔处留下一个墨点。
  const dash = len * 1.04 + 1;
  const hidden = (dash + 6).toFixed(2);
  return `.s${i}{stroke-dasharray:${dash.toFixed(2)} ${(dash + 12).toFixed(2)};animation:k${i} ${cycle}ms linear infinite}`
    + `@keyframes k${i}{0%,${pct(start)}{stroke-dashoffset:${hidden};animation-timing-function:${EASE}}`
    + `${pct(start + dur)},100%{stroke-dashoffset:0}}`;
}).join("\n");
const fade = `.ink{animation:fade ${cycle}ms linear infinite}`
  + `@keyframes fade{0%,${pct(cursor + HOLD_MS)}{opacity:1}${pct(cursor + HOLD_MS + FADE_MS)},100%{opacity:0}}`;
// 不想看动画的人直接给写完的那一张。
const still = "@media (prefers-reduced-motion:reduce){.ink,.ink path{animation:none;stroke-dasharray:none}}";

const place = (l: typeof han, scale: number, y: number) =>
  `<g transform="translate(${((W - l.w * scale) / 2).toFixed(2)} ${y.toFixed(2)}) scale(${scale.toFixed(4)}) translate(${-l.x} ${-l.y})" stroke-width="${l.sw}">${l.body}</g>`;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">Yuragi 中英文手写字效果展示</title>
  <desc id="desc">中文“云在青山月在天”和英文“Clouds rest on the hills.”，由 Yuragi 默认参数渲染。</desc>
  <rect width="${W}" height="${H}" fill="#ffffff"/>
  <style>
${css}
${fade}
${still}
  </style>
  <g class="ink" fill="none" stroke="#09090B" stroke-linecap="round" stroke-linejoin="round">
    ${place(han, hanScale, top)}
    ${place(latin, latinScale, top + han.h * hanScale + gap)}
  </g>
</svg>
`;

writeFileSync(resolve(root, "docs/type-sample.svg"), svg);
