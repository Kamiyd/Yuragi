/* 拿 Python 生成的标准结果，逐条比对 TypeScript 这一份。

   跑法：npm run parity（先 npm run parity:fixtures 重新生成标准结果）
   判据只有一条：**字符串精确相等**。差 0.1 就是另一条线。 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import * as dpath from "../../src/lib/core/dpath";
import { corners, dedupe, pathToPolys } from "../../src/lib/core/flatten";
import { hand } from "../../src/lib/core/hand";
import { fmtFixed, pyG, pyRound } from "../../src/lib/core/num";
import { rnd } from "../../src/lib/core/rng";
import * as rowmod from "../../src/lib/core/row";
import { gaps, structure, vary } from "../../src/lib/core/vary";
import { loadGeo, serializeGeoFile, toGeo, type GlyphLibrary } from "../../src/lib/core/library";
import { render, renderRow } from "../../src/lib/core/render";
import { paramsOf, seedMap, writeLines, type RawLibrary } from "../../src/lib/core/draw";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, "..", "..", "src", "data");
const fixtures = JSON.parse(readFileSync(join(HERE, "fixtures.json"), "utf-8"));

let checks = 0;
const failures: string[] = [];

function eq(label: string, actual: unknown, expected: unknown) {
  checks += 1;
  const a = typeof actual === "string" ? actual : JSON.stringify(actual);
  const b = typeof expected === "string" ? expected : JSON.stringify(expected);
  if (a !== b) failures.push(`${label}\n    实际 ${a}\n    期望 ${b}`);
}

function close(label: string, actual: number, expected: number, tol = 1e-12) {
  checks += 1;
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    failures.push(`${label}\n    实际 ${actual}\n    期望 ${expected}`);
  }
}

const rawCache = new Map<string, Record<string, unknown>>();
function loadRaw(lib: string): Record<string, unknown> {
  if (!rawCache.has(lib)) rawCache.set(lib, JSON.parse(readFileSync(join(DATA, lib), "utf-8")));
  return JSON.parse(JSON.stringify(rawCache.get(lib)));
}
function itemsOf(lib: string): Record<string, any[]> {
  const data = loadRaw(lib);
  return (data.items ?? data) as Record<string, any[]>;
}
function payloadOf(lib: string): { file: string; glyphs: GlyphLibrary } {
  return loadGeo(loadRaw(lib), join(DATA, lib));
}

// 1. 数字格式化 —— 移植里最容易漂的一层
for (const c of fixtures.fmt) {
  eq(`fmt %g ${c.value}`, pyG(c.value), c.g);
  eq(`fmt .1f ${c.value}`, fmtFixed(c.value, 1), c.f1);
  eq(`fmt .2f ${c.value}`, fmtFixed(c.value, 2), c.f2);
  eq(`fmt .4f ${c.value}`, fmtFixed(c.value, 4), c.f4);
  eq(`round(${c.value},1)`, pyRound(c.value, 1), c.r1);
  eq(`round(${c.value},2)`, pyRound(c.value, 2), c.r2);
  eq(`round(${c.value},3)`, pyRound(c.value, 3), c.r3);
}

// 2. 确定性随机
for (const c of fixtures.rnd) eq(`rnd(${c.key.join(",")})`, rnd(...c.key), c.value);
for (const c of fixtures.hand_seed) {
  eq(`hand_seed(${c.base},${c.local})`, rowmod.handSeed(c.base, c.local), c.value);
}

// 3. d 串往返
for (const c of fixtures.dpath) {
  const segs = dpath.parse(c.d);
  eq(`dpath.parse ${c.lib} ${c.name}#${c.i}`, segs, c.segs);
  eq(`dpath.serialize ${c.lib} ${c.name}#${c.i}`, dpath.serialize(segs), c.out);
}

// 4. 摊平 / 硬角
for (const c of fixtures.flatten) {
  const polys = pathToPolys(c.d).map(([poly, closed]) => [poly.map((p) => [p[0], p[1]]), closed]);
  checks += 1;
  const expected = c.polys;
  let ok = polys.length === expected.length;
  if (ok) {
    for (let i = 0; i < polys.length && ok; i += 1) {
      const [poly, closed] = polys[i] as [number[][], boolean];
      if (closed !== expected[i][1] || poly.length !== expected[i][0].length) { ok = false; break; }
      for (let k = 0; k < poly.length; k += 1) {
        if (Math.abs(poly[k][0] - expected[i][0][k][0]) > 1e-12
          || Math.abs(poly[k][1] - expected[i][0][k][1]) > 1e-12) { ok = false; break; }
      }
    }
  }
  if (!ok) failures.push(`flatten ${c.lib} ${c.name}#${c.i} 折线不一致`);
}
{
  const seen = new Map<string, number>();
  for (const c of fixtures.corners) {
    const key = `${c.lib}|${c.name}|${c.i}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const el = itemsOf(c.lib)[c.name][c.i];
    const polys = pathToPolys(String(el.d));
    const [poly, closed] = polys[nth];
    eq(`corners ${key}#${nth}`, [...corners(poly, closed, 32)].sort((a, b) => a - b), c.sharp);
  }
}

// 5. 手抖滤镜本体
for (const c of fixtures.hand) {
  const d = hand(c.pts, {
    seed: c.seed, amp: c.amp, closed: c.closed,
    sharp: new Set<number>(c.sharp), over: c.over, step: c.step,
  });
  eq(`hand ${c.lib} ${c.name}#${c.i} seed=${c.seed}`, d, c.d);
}

// 6. 单字渲染
for (const c of fixtures.render) {
  const { glyphs } = payloadOf(c.lib);
  const els = glyphs.items[c.name];
  eq(`render ${c.lib} ${c.name}`,
    render(glyphs.vb, c.idx, els, glyphs.amp, glyphs.over, c.local), c.paths);
}

// 7. 骨架层重写
for (const c of fixtures.vary) {
  const data = loadRaw(c.lib);
  const items = (data.items ?? data) as Record<string, any[]>;
  const vb = Number(data.vb ?? 64);
  const out = vary(items[c.name], c.seed, vb, Number(data.vary ?? 1));
  eq(`vary ${c.lib} ${c.name} seed=${c.seed}`, out.map((e) => e.d ?? null), c.out);
}

// 8. 结构不变量
for (const c of fixtures.structure) {
  const data = loadRaw(c.lib);
  const items = (data.items ?? data) as Record<string, any[]>;
  const vb = Number(data.vb ?? 64);
  const strokes = items[c.name].filter((e: any) => (e.t ?? "path") === "path")
    .map((e: any) => dpath.parse(String(e.d)));
  const { clusterOf, attach } = structure(strokes, (2.0 * vb) / 64);
  const cluster = [...clusterOf.entries()]
    .map(([k, v]) => [k.split(",").map(Number), v] as [number[], number])
    .sort((a, b) => (a[0][0] - b[0][0]) || (a[0][1] - b[0][1]));
  eq(`structure.cluster ${c.lib} ${c.name}`, cluster, c.cluster);
  const actualAttach = attach.map((a) => [...a]);
  const expectedAttach = c.attach as number[][];
  checks += 1;
  const attachMatches = actualAttach.length === expectedAttach.length
    && actualAttach.every((row, i) => row.length === expectedAttach[i].length
      && row.every((value, j) => j === row.length - 1
        ? Math.abs(value - expectedAttach[i][j]) <= 1e-12
        : value === expectedAttach[i][j]));
  if (!attachMatches) failures.push(`structure.attach ${c.lib} ${c.name} 不一致`);
  const g = [...gaps(strokes).entries()]
    .map(([k, v]) => [k.split(",").map(Number), v] as [number[], number])
    .sort((a, b) => (a[0][0] - b[0][0]) || (a[0][1] - b[0][1]));
  checks += 1;
  const expectedGaps = c.gaps as Array<[number[], number]>;
  let ok = g.length === expectedGaps.length;
  for (let i = 0; ok && i < g.length; i += 1) {
    ok = g[i][0][0] === expectedGaps[i][0][0] && g[i][0][1] === expectedGaps[i][0][1]
      && Math.abs(g[i][1] - expectedGaps[i][1]) < 1e-12;
  }
  if (!ok) failures.push(`structure.gaps ${c.lib} ${c.name} 间距表不一致`);
}

// 9. 排一行 —— 整张 SVG 精确比对
for (const c of fixtures.row) {
  const { glyphs } = payloadOf(c.lib);
  const result = renderRow({
    text: c.text, seed: c.seed, ampk: glyphs.jit, mode: c.mode,
    amp: glyphs.amp, over: glyphs.over, vary: c.vary, varyk: glyphs.vary,
    glyphSeeds: glyphs.glyphSeeds, glyphData: glyphs,
    track: glyphs.track, word: glyphs.word,
  });
  const label = `row ${c.lib} "${c.text}" seed=${c.seed} vary=${c.vary}`;
  eq(`${label} svg`, result.svg, c.result.svg);
  eq(`${label} table`, result.table, c.result.table);
  eq(`${label} miss`, result.miss, c.result.miss);
  close(`${label} ratio`, result.ratio, c.result.ratio);
  close(`${label} vbw`, result.vb[0], c.result.vb[0]);
  close(`${label} vbh`, result.vb[1], c.result.vb[1]);
}

// 9b. 边界：缺字、标点、字距/词距、局部种子
for (const c of fixtures.row_edge) {
  const { glyphs } = payloadOf(c.lib);
  const result = renderRow({
    text: c.text, seed: c.seed, ampk: c.ampk ?? glyphs.jit, mode: c.mode,
    amp: c.amp ?? glyphs.amp, over: c.over ?? glyphs.over,
    vary: c.vary ?? true, varyk: c.varyk ?? glyphs.vary,
    glyphSeeds: c.glyph_seeds ?? glyphs.glyphSeeds, glyphData: glyphs,
    track: c.track ?? glyphs.track, word: c.word ?? glyphs.word,
  });
  const label = `row_edge ${c.lib} "${c.text}" seed=${c.seed}`;
  eq(`${label} svg`, result.svg, c.result.svg);
  eq(`${label} table`, result.table, c.result.table);
  eq(`${label} miss`, result.miss, c.result.miss);
  close(`${label} ratio`, result.ratio, c.result.ratio);
}

// 9c. 自动换行：折行边界按渲染后的实际宽高算，多行共用一个 viewBox
for (const c of fixtures.row_wrap) {
  const { glyphs } = payloadOf(c.lib);
  const result = renderRow({
    text: c.text, seed: 42, ampk: glyphs.jit, mode: c.mode,
    amp: glyphs.amp, over: glyphs.over, vary: true, varyk: glyphs.vary,
    glyphSeeds: glyphs.glyphSeeds, glyphData: glyphs,
    track: glyphs.track, word: glyphs.word,
    maxWidth: c.maxWidth, lineHeight: 44,
  });
  const label = `row_wrap ${c.lib} "${c.text}" maxWidth=${c.maxWidth}`;
  eq(`${label} svg`, result.svg, c.result.svg);
  eq(`${label} table`, result.table, c.result.table);
  eq(`${label} lineCount`, result.lineCount, c.result.lineCount);
  close(`${label} vbw`, result.vb[0], c.result.vb[0]);
  close(`${label} vbh`, result.vb[1], c.result.vb[1]);
}

// 10. write：多行、断行
for (const c of fixtures.write) {
  const data = loadRaw(c.lib);
  const p = paramsOf(data);
  const raw: RawLibrary = {
    ...p,
    vb: Number(data.vb ?? 24),
    sw: Number(data.sw ?? 1.5),
    seed: (data.seed as number) ?? null,
    glyphSeeds: seedMap(data.glyphSeeds),
    items: (data.items ?? data) as Record<string, any[]>,
  };
  const [svg, ratio] = writeLines(raw, c.text, c.seed, true);
  eq(`write ${c.lib} "${c.text}" seed=${c.seed}`, svg, c.svg);
  close(`write ratio ${c.lib} "${c.text}"`, ratio, c.ratio);
}

// 11. 字库读写往返
for (const c of fixtures.save) {
  const { glyphs } = payloadOf(c.lib);
  eq(`save ${c.lib}`, serializeGeoFile(glyphs), c.text);
  const expected = c.payload.glyphs;
  eq(`loadGeo ${c.lib} 表头`, {
    vb: glyphs.vb, sw: glyphs.sw, amp: glyphs.amp, over: glyphs.over,
    jit: glyphs.jit, vary: glyphs.vary, track: glyphs.track, word: glyphs.word,
    seed: glyphs.seed, glyphSeeds: glyphs.glyphSeeds, editor: glyphs.editor,
  }, {
    vb: expected.vb, sw: expected.sw, amp: expected.amp, over: expected.over,
    jit: expected.jit, vary: expected.vary, track: expected.track, word: expected.word,
    seed: expected.seed ?? null, glyphSeeds: expected.glyphSeeds, editor: expected.editor,
  });
}

console.log(`对照 ${checks} 项`);
if (failures.length) {
  console.log(`\n不一致 ${failures.length} 项：\n`);
  for (const f of failures.slice(0, 40)) console.log("  ✗", f);
  if (failures.length > 40) console.log(`  …… 还有 ${failures.length - 40} 项`);
  process.exit(1);
}
console.log("全部一致 ✓");
