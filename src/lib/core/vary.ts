/* 骨架层抖动：同一个字，每次写出来都不一样。

   hand.ts 换的是**笔迹**（同一份骨架，线抖得不一样）。这一层换的是**写法** ——
   笔画长短、横的高低、撇捺的斜度、重心、钩的挑度，全部重摇。

   **不能动的是结构**：笔顺、笔画数、部件的相对位置。动了就是另一个字。
   所以结构不变量要**验出来**：逐对笔画比对变形前后的最小间距，连着的必须
   还连着、分开的不许挤到一起。不合格就换个盐重摇、幅度降一档，全都不合格
   就退回原样 —— 这个字这次不变，比写坏一个字强得多。 */
import * as dpath from "./dpath";
import type { Point, Segment } from "./dpath";
import { pathToPolys } from "./flatten";
import { jit } from "./rng";
import { pyRoundInt, hypot } from "./num";

// 幅度（64 网格；其它网格按 cell/64 等比）。来自 glyphs.md 那张表。
const JOINT = 1.8;      // 关节位移：整个字的结构松紧
const FREE_T = 3.0;     // 自由端沿切线：笔画长短
const FREE_N = 1.5;     // 自由端沿法线：撇捺的斜度
const CURVE = 1.2;      // 控制点沿法线：弯度 / 钩的挑度
const BODY = 2.0;       // 整字重心
export const EPS = 2.0; // 判定「连在一起」的距离
const SHORT_T = 0.25;   // 自由端沿切线的伸缩不超过这一段长度的这么多：点、钩、短撇两头一缩就没了

export type GeoElement = {
  t?: string;
  d?: string;
  fill?: boolean;
  amp?: number;
  w?: number;
  adv?: number;
  traceMode?: string;
  [key: string]: unknown;
};

/** [(gi, 点)] —— 每一段的落点，就是骨架上的锚点。 */
function anchors(segs: Segment[]): Array<[number, Point]> {
  const out: Array<[number, Point]> = [];
  segs.forEach((s, gi) => { if (s.p.length) out.push([gi, s.p[s.p.length - 1]]); });
  return out;
}

function polyOf(segs: Segment[]): Point[] {
  const ps = pathToPolys(dpath.serialize(segs));
  return ps.length ? ps[0][0] : [];
}

/** 折线上按弧长比例 t 取点。 */
function pointAt(poly: Point[], t: number): Point {
  if (poly.length < 2) return poly.length ? poly[0] : [0, 0];
  const seg: number[] = [];
  for (let i = 0; i < poly.length - 1; i += 1) {
    seg.push(hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1]));
  }
  const L = seg.reduce((a, b) => a + b, 0) || 1;
  const want = Math.max(0, Math.min(1, t)) * L;
  let acc = 0;
  for (let i = 0; i < seg.length; i += 1) {
    const s = seg[i];
    if (acc + s >= want || i === seg.length - 1) {
      const u = (want - acc) / (s || 1);
      return [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * u,
              poly[i][1] + (poly[i + 1][1] - poly[i][1]) * u];
    }
    acc += s;
  }
  return poly[poly.length - 1];
}

/** 点 p 在折线上的弧长比例，以及它到折线的距离。 */
function paramOf(poly: Point[], p: Point): [number, number] {
  if (poly.length < 2) return [0, 1e9];
  let bestDist = 1e9;
  let bestAcc = 0;
  let acc = 0;
  let total = 0;
  const segs: Array<[number, number, number, number, number]> = [];
  for (let i = 0; i < poly.length - 1; i += 1) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[i + 1];
    const L = hypot(bx - ax, by - ay) || 1e-9;
    segs.push([ax, ay, bx, by, L]);
    total += L;
  }
  for (const [ax, ay, bx, by, L] of segs) {
    const u = Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / (L * L)));
    const qx = ax + (bx - ax) * u;
    const qy = ay + (by - ay) * u;
    const dist = hypot(p[0] - qx, p[1] - qy);
    if (dist < bestDist) { bestDist = dist; bestAcc = acc + L * u; }
    acc += L;
  }
  return [bestAcc / (total || 1), bestDist];
}

type Structure = {
  clusterOf: Map<string, number>;            // "si,gi" -> 关节编号
  attach: Array<[number, number, number, number]>;  // si, gi, host_si, t
};

const key2 = (si: number, gi: number) => `${si},${gi}`;

/** 关节表。同一个关节上的锚点必须一起动。 */
export function structure(strokes: Segment[][], eps = EPS): Structure {
  const list: Array<[number, number, Point]> = [];
  strokes.forEach((segs, si) => { for (const [gi, p] of anchors(segs)) list.push([si, gi, p]); });

  const parent = new Map<string, string>();
  const find = (a: string): string => {
    while ((parent.get(a) ?? a) !== a) {
      const up = parent.get(a) as string;
      parent.set(a, parent.get(up) ?? up);
      a = parent.get(a) as string;
    }
    return a;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const [si, gi] of list) parent.set(key2(si, gi), key2(si, gi));
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const [si, gi, p] = list[i];
      const [sj, gj, q] = list[j];
      if (si === sj) continue;
      if (hypot(p[0] - q[0], p[1] - q[1]) < eps) union(key2(si, gi), key2(sj, gj));
    }
  }
  const groups = new Map<string, string[]>();
  for (const k of Array.from(parent.keys())) {
    const root = find(k);
    const bucket = groups.get(root);
    if (bucket) bucket.push(k); else groups.set(root, [k]);
  }
  const clusterOf = new Map<string, number>();
  let cid = 0;
  for (const members of groups.values()) {
    if (members.length > 1) {                  // 只有真连着的才算关节
      for (const m of members) clusterOf.set(m, cid);
      cid += 1;
    }
  }

  const polys = strokes.map(polyOf);
  const attach: Array<[number, number, number, number]> = [];
  for (const [si, gi, p] of list) {
    if (clusterOf.has(key2(si, gi))) continue;
    for (let hj = 0; hj < polys.length; hj += 1) {
      const hp = polys[hj];
      if (hj === si || hp.length < 2) continue;
      const [t, dist] = paramOf(hp, p);
      if (dist < eps && t > 0.06 && t < 0.94) {   // 落在中段，不是两头
        attach.push([si, gi, hj, t]);
        break;
      }
    }
  }
  return { clusterOf, attach };
}

/** 折线抽到 n 个点 —— 逐对求最小间距要的精度到 1–2 个单位就够，全点算太慢。 */
function samplepoly(poly: Point[], n = 24): Point[] {
  if (poly.length <= n) return poly;
  const out: Point[] = [];
  for (let i = 0; i < n; i += 1) out.push(poly[pyRoundInt((i * (poly.length - 1)) / (n - 1))]);
  return out;
}

function gapOf(a: Point[], b: Point[]): number {
  let m = 1e9;
  for (const p of a) {
    for (const q of b) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      if (d < m) m = d;
    }
  }
  return Math.sqrt(m);
}

/** 所有笔画两两之间的间距表 —— 结构不变量就是这张表的定性形态。 */
export function gaps(strokes: Segment[][]): Map<string, number> {
  const sm = strokes.map((s) => samplepoly_(s));
  const out = new Map<string, number>();
  for (let i = 0; i < sm.length; i += 1) {
    for (let j = i + 1; j < sm.length; j += 1) {
      if (sm[i].length && sm[j].length) out.set(`${i},${j}`, gapOf(sm[i], sm[j]));
    }
  }
  return out;
}

function samplepoly_(segs: Segment[]): Point[] {
  return samplepoly(polyOf(segs));
}

/** 结构还在不在。连着的必须还连着，分开的不许挤到一起、也不许缩掉四成。 */
export function intact(before: Map<string, number>, after: Map<string, number>, eps = EPS): boolean {
  for (const [k, d0] of before) {
    const d1 = after.has(k) ? (after.get(k) as number) : d0;
    if (d0 < eps) {
      if (d1 >= eps) return false;            // 关节被拉开了
    } else if (d1 < eps || d1 < d0 * 0.6) {
      return false;                            // 本来分开的两笔挤到一起了
    }
  }
  return true;
}

export function preservesTrace(element: GeoElement): boolean {
  if (element.traceMode === "original") return true;
  // 兼容第一版描摹：零抖动 + M (L Q)+ L 那串小圆角
  if ((element.t ?? "path") !== "path" || element.amp !== 0) return false;
  const commands = dpath.parse(String(element.d ?? "")).map((s) => s.c);
  const middle = commands.slice(1, -1);
  return commands.length >= 4 && commands[0] === "M" && commands[commands.length - 1] === "L"
    && middle.length % 2 === 0
    && middle.every((command, index) => command === (index % 2 === 0 ? "L" : "Q"));
}

/** 一个字的硬几何 -> 另一份写法。结构不动，写法全换。 */
export function vary(items: GeoElement[], seed: number, cell = 64, amp = 1, tries = 6): GeoElement[] {
  const base = items.map((e) => ({ ...e }));
  const strokes0 = items.filter((e) => (e.t ?? "path") === "path").map((e) => dpath.parse(String(e.d ?? "")));
  if (!strokes0.length) return base;
  const g0 = gaps(strokes0);
  for (let t = 0; t < tries; t += 1) {
    const out = varyOnce(items, seed * 1000 + t, cell, amp * (1 - 0.15 * t));
    const s1 = out.filter((e) => (e.t ?? "path") === "path").map((e) => dpath.parse(String(e.d ?? "")));
    if (intact(g0, gaps(s1), (EPS * cell) / 64)) return out;
  }
  return base;            // 摇不出合格的写法：这个字这次就不变
}

type TraceInfo = [Array<[number, Point]>, number[], number[]];

/** 保留手迹的一笔：关键锚点（两头 + 关节）照常算位移，中间的采样点按弧长插值，
    每一段再加一点整体的弯。返回 (锚点, 弧长, 关键锚点序号)，贴回宿主时要用。 */
function traceDisp(si: number, segs: Segment[], disp: Map<string, Point>, clusterOf: Map<string, number>,
                   attached: Set<string>, jd: Map<number, Point>, seed: number, amp: number, k: number): TraceInfo {
  const an = anchors(segs);
  const m = an.length;
  if (!m) return [an, [], []];
  const acc = [0];
  for (let n = 1; n < m; n += 1) {
    const a = an[n - 1][1];
    const b = an[n][1];
    acc.push(acc[acc.length - 1] + hypot(b[0] - a[0], b[1] - a[1]));
  }
  const total = acc[acc.length - 1];
  const keys: number[] = [];
  const kd = new Map<number, Point>();
  an.forEach(([gi, p], n) => {
    const key = key2(si, gi);
    if (clusterOf.has(key)) {
      kd.set(n, jd.get(clusterOf.get(key) as number) as Point);
    } else if (n !== 0 && n !== m - 1) {
      return;
    } else if (attached.has(key)) {
      kd.set(n, [0, 0]);                         // 稍后贴回宿主，先不动
    } else if (n === m - 1 && m > 2 && kd.has(0)
               && hypot(p[0] - an[0][1][0], p[1] - an[0][1][1]) < EPS * k) {
      kd.set(n, kd.get(0) as Point);             // 首尾接上的圈：两头一起走，圈不断开
    } else {
      // 自由端：切线按一小段弧长外的点取 —— 紧挨着的采样点方向是乱的
      const reach = Math.min(4 * k, total * 0.5);
      let q = p;
      if (n === 0) {
        for (let j = 1; j < m; j += 1) {
          q = an[j][1];
          if (acc[j] >= reach) break;
        }
      } else {
        for (let j = m - 2; j >= 0; j -= 1) {
          q = an[j][1];
          if (total - acc[j] >= reach) break;
        }
      }
      let dx = p[0] - q[0];
      let dy = p[1] - q[1];
      if (n === 0) { dx = -dx; dy = -dy; }
      const L = hypot(dx, dy);
      const tx = L ? dx / L : 1;
      const ty = L ? dy / L : 0;
      const tAmp = Math.min(FREE_T * amp * k, SHORT_T * total);
      const aT = jit(tAmp, seed, 17, si, gi);
      const aN = jit(FREE_N * amp * k, seed, 19, si, gi);
      kd.set(n, [tx * aT - ty * aN, ty * aT + tx * aN]);
    }
    keys.push(n);
  });

  let ki = 0;
  an.forEach(([gi], n) => {
    while (ki < keys.length - 2 && n > keys[ki + 1]) ki += 1;
    const na = keys[ki];
    const nb = keys.length > 1 ? keys[ki + 1] : na;
    const da = kd.get(na) as Point;
    const db = kd.get(nb) as Point;
    const span = acc[nb] - acc[na];
    const u = span > 0 ? (acc[n] - acc[na]) / span : 0;
    const pa = an[na][1];
    const pb = an[nb][1];
    const cx = pb[0] - pa[0];
    const cy = pb[1] - pa[1];
    const L = hypot(cx, cy);
    const nx = L ? -cy / L : 0;
    const ny = L ? cx / L : 0;
    const bow = jit(Math.min(CURVE * amp * k, span * 0.15), seed, 31, si, na) * 4 * u * (1 - u);
    disp.set(key2(si, gi), [da[0] + (db[0] - da[0]) * u + nx * bow,
                            da[1] + (db[1] - da[1]) * u + ny * bow]);
  });

  // 控制点跟着两端的采样点走，不另加弯度：轨迹的小圆角原样留着
  segs.forEach((s, gi) => {
    if (s.p.length < 2) return;
    const dEnd = disp.get(key2(si, gi)) ?? [0, 0];
    const dPrev = disp.get(key2(si, gi - 1)) ?? dEnd;
    const nCtrl = s.p.length - 1;
    for (let ci = 0; ci < nCtrl; ci += 1) {
      const u = (ci + 1) / (nCtrl + 1);
      disp.set(`c,${si},${gi},${ci}`, [dPrev[0] + (dEnd[0] - dPrev[0]) * u,
                                       dPrev[1] + (dEnd[1] - dPrev[1]) * u]);
    }
  });
  return [an, acc, keys];
}

/** 保留手迹的端点贴回宿主：挪动量顺着弧长摊到下一个关键锚点，不在笔尖折一下。 */
function traceSpread(segs: Segment[], info: TraceInfo, gi: number, delta: Point) {
  const [an, acc, keys] = info;
  const n0 = an.findIndex(([g]) => g === gi);
  const nk = n0 === keys[0] && keys.length > 1 ? keys[1] : (keys.length > 1 ? keys[keys.length - 2] : n0);
  const span = Math.abs(acc[nk] - acc[n0]);
  const w = new Map<number, number>();
  an.forEach(([g], n) => {
    if ((n0 <= n && n <= nk) || (nk <= n && n <= n0)) {
      w.set(g, span > 0 ? 1 - Math.abs(acc[n] - acc[n0]) / span : (n === n0 ? 1 : 0));
    }
  });
  segs.forEach((s, g) => {
    if (!s.p.length) return;
    const we = w.get(g) ?? 0;
    const wp = w.get(g - 1) ?? we;
    const nCtrl = s.p.length - 1;
    for (let ci = 0; ci < nCtrl; ci += 1) {
      const u = (ci + 1) / (nCtrl + 1);
      const wc = wp + (we - wp) * u;
      s.p[ci][0] += delta[0] * wc;
      s.p[ci][1] += delta[1] * wc;
    }
    s.p[s.p.length - 1][0] += delta[0] * we;
    s.p[s.p.length - 1][1] += delta[1] * we;
  });
}

function varyOnce(items: GeoElement[], seed: number, cell = 64, amp = 1): GeoElement[] {
  const k = cell / 64;
  const strokes: Array<[number, Segment[]]> = [];
  items.forEach((el, i) => {
    if ((el.t ?? "path") === "path") strokes.push([i, dpath.parse(String(el.d ?? ""))]);
  });
  if (!strokes.length) return items.map((e) => ({ ...e }));

  const segsList = strokes.map(([, s]) => s);
  const { clusterOf, attach: attach0 } = structure(segsList, EPS * k);
  // 保留手迹：密密的采样点只是轨迹，不是骨架。只有两头和跟别的笔共用的关节算锚点，
  // 中间的点顺着弧长跟着走 —— 复杂的轨迹形状不散，写法照样重摇。
  const trace = new Set<number>();
  strokes.forEach(([i], si) => { if (preservesTrace(items[i])) trace.add(si); });
  const traceEnds = new Map<number, [number, number]>();
  for (const si of trace) {
    const an = anchors(segsList[si]);
    if (an.length) traceEnds.set(si, [an[0][0], an[an.length - 1][0]]);
  }
  const attach = attach0.filter(([si, gi]) => {                // 中段采样点不往别人身上挂
    const ends = traceEnds.get(si);
    return !ends || ends.includes(gi);
  });
  const attached = new Set(attach.map(([si, gi]) => key2(si, gi)));
  const traceKeys = new Map<number, TraceInfo>();               // si -> (锚点, 弧长, 关键锚点序号)

  const bx = jit(BODY * amp * k, seed, 3);          // 整字重心
  const by = jit(BODY * amp * k, seed, 5);

  // 关节位移：一个关节一份，挂在它上面的每一笔都跟着走
  const jd = new Map<number, Point>();
  for (const c of new Set(clusterOf.values())) {
    jd.set(c, [jit(JOINT * amp * k, seed, 11, c), jit(JOINT * amp * k, seed, 13, c)]);
  }

  const disp = new Map<string, Point>();            // 锚点 / 控制点 -> 位移
  segsList.forEach((segs, si) => {
    if (trace.has(si)) {
      traceKeys.set(si, traceDisp(si, segs, disp, clusterOf, attached, jd, seed, amp, k));
      return;
    }
    const an = anchors(segs);
    an.forEach(([gi, p], n) => {
      const key = key2(si, gi);
      if (clusterOf.has(key)) {
        disp.set(key, jd.get(clusterOf.get(key) as number) as Point);
        return;
      }
      if (attached.has(key)) {
        disp.set(key, [0, 0]);                       // 稍后贴回宿主，先不动
        return;
      }
      // 自由端：沿切线改长短、沿法线改斜度。中段的锚点按小幅度跟着动
      const free = n === 0 || n === an.length - 1;
      let dx = 1;
      let dy = 0;
      if (an.length > 1) {
        const q = n > 0 ? an[n - 1][1] : an[1][1];
        dx = p[0] - q[0];
        dy = p[1] - q[1];
        if (n === 0) { dx = -dx; dy = -dy; }
      }
      const L = hypot(dx, dy) || 1;
      const tx = dx / L;
      const ty = dy / L;
      let tAmp = (free ? FREE_T : JOINT * 0.6) * amp * k;
      if (free && an.length > 1) tAmp = Math.min(tAmp, SHORT_T * L);   // 短笔两头最多各缩四分之一
      const aT = jit(tAmp, seed, 17, si, gi);
      const aN = jit((free ? FREE_N : JOINT * 0.4) * amp * k, seed, 19, si, gi);
      disp.set(key, [tx * aT - ty * aN, ty * aT + tx * aN]);
    });

    // 控制点跟着两端的锚点走，再单独加一点弯度
    segs.forEach((s, gi) => {
      if (s.p.length < 2) return;
      const dEnd = disp.get(key2(si, gi)) ?? [0, 0];
      const dPrev = disp.get(key2(si, gi - 1)) ?? dEnd;
      const nCtrl = s.p.length - 1;
      for (let ci = 0; ci < nCtrl; ci += 1) {
        const u = (ci + 1) / (nCtrl + 1);
        const baseX = dPrev[0] + (dEnd[0] - dPrev[0]) * u;
        const baseY = dPrev[1] + (dEnd[1] - dPrev[1]) * u;
        const a = s.p[ci];
        const b = s.p[s.p.length - 1];
        const dx = b[0] - a[0];
        const dy = b[1] - a[1];
        const L = hypot(dx, dy) || 1;
        const nx = -dy / L;
        const ny = dx / L;
        const c = jit(CURVE * amp * k, seed, 23, si, gi, ci);
        disp.set(`c,${si},${gi},${ci}`, [baseX + nx * c, baseY + ny * c]);
      }
    });
  });

  // 落位
  const outSegs: Segment[][] = segsList.map((segs, si) => segs.map((s, gi) => {
    const t: Segment = { c: s.c, p: s.p.map((q) => [q[0], q[1]] as Point) };
    if (s.a) {
      const r = 1 + jit(0.12 * amp, seed, 29, si, gi);       // 折角半径也呼吸
      t.a = [s.a[0] * r, s.a[1] * r, ...s.a.slice(2)];
    }
    for (let ci = 0; ci < t.p.length - 1; ci += 1) {
      const d = disp.get(`c,${si},${gi},${ci}`) ?? [0, 0];
      t.p[ci][0] += d[0] + bx;
      t.p[ci][1] += d[1] + by;
    }
    if (t.p.length) {
      const d = disp.get(key2(si, gi)) ?? [0, 0];
      t.p[t.p.length - 1][0] += d[0] + bx;
      t.p[t.p.length - 1][1] += d[1] + by;
    }
    return t;
  }));

  // 挂在别人中段上的点：宿主变形完了，按原来的参数位置重新贴回去
  for (const [si, gi, hj, t] of attach) {
    const host = polyOf(outSegs[hj]);
    if (!host.length) continue;
    const p = pointAt(host, t);
    const seg = outSegs[si][gi];
    if (!seg.p.length) continue;
    const info = traceKeys.get(si);
    if (info) {
      const old = seg.p[seg.p.length - 1];
      traceSpread(outSegs[si], info, gi, [p[0] - old[0], p[1] - old[1]]);
      continue;
    }
    const old = seg.p[seg.p.length - 1];
    const dx = p[0] - old[0];
    const dy = p[1] - old[1];
    seg.p[seg.p.length - 1] = [p[0], p[1]];
    for (let ci = 0; ci < seg.p.length - 1; ci += 1) {     // 控制点跟着这一段一起挪
      seg.p[ci][0] += dx * 0.5;
      seg.p[ci][1] += dy * 0.5;
    }
  }

  // 别摇出格子：字面留 4 个单位的边
  const lo = 4 * k;
  const hi = cell - 4 * k;
  const xs: number[] = [];
  const ys: number[] = [];
  for (const sg of outSegs) for (const s of sg) for (const q of s.p) { xs.push(q[0]); ys.push(q[1]); }
  if (xs.length) {
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const ox = Math.max(lo - minX, 0) + Math.min(hi - maxX, 0);
    const oy = Math.max(lo - minY, 0) + Math.min(hi - maxY, 0);
    for (const sg of outSegs) for (const s of sg) for (const q of s.p) { q[0] += ox; q[1] += oy; }
  }

  const out = items.map((e) => ({ ...e }));
  strokes.forEach(([i], n) => { out[i] = { ...items[i], d: dpath.serialize(outSegs[n]) }; });
  return out;
}
