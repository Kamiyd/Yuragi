/* 把 SVG 的 path / rect / circle / ellipse 摊成折线，好交给手抖滤镜。 */
import type { Point } from "./dpath";
import { hypot } from "./num";

export type Poly = [Point[], boolean];     // [折线, 是否闭合]

function arcPoints(x0: number, y0: number, rx: number, ry: number, rot: number,
                   large: number, sweep: number, x: number, y: number, n = 18): Point[] {
  if (rx === 0 || ry === 0) return [[x, y]];
  const phi = (rot * Math.PI) / 180;
  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1 = Math.cos(phi) * dx2 + Math.sin(phi) * dy2;
  const y1 = -Math.sin(phi) * dx2 + Math.cos(phi) * dy2;
  rx = Math.abs(rx); ry = Math.abs(ry);
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const c = Math.sqrt(Math.max(0, num / den)) * (large === sweep ? -1 : 1);
  const cx1 = (c * rx * y1) / ry;
  const cy1 = (-c * ry * x1) / rx;
  const cx = Math.cos(phi) * cx1 - Math.sin(phi) * cy1 + (x0 + x) / 2;
  const cy = Math.sin(phi) * cx1 + Math.cos(phi) * cy1 + (y0 + y) / 2;
  const ang = (ux: number, uy: number) => Math.atan2(uy, ux);
  const t1 = ang((x1 - cx1) / rx, (y1 - cy1) / ry);
  const t2 = ang((-x1 - cx1) / rx, (-y1 - cy1) / ry);
  let dt = t2 - t1;
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const out: Point[] = [];
  for (let i = 1; i <= n; i += 1) {
    const t = t1 + (dt * i) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([Math.cos(phi) * ex - Math.sin(phi) * ey + cx,
              Math.sin(phi) * ex + Math.cos(phi) * ey + cy]);
  }
  return out;
}

/** p = 控制点列表（3 或 4 个），返回采样点（不含起点） */
function bezier(p: Point[], n: number): Point[] {
  const out: Point[] = [];
  for (let i = 1; i <= n; i += 1) {
    const t = i / n;
    let q = p;
    while (q.length > 1) {
      const next: Point[] = [];
      for (let k = 0; k < q.length - 1; k += 1) {
        const a = q[k];
        const b = q[k + 1];
        next.push([(1 - t) * a[0] + t * b[0], (1 - t) * a[1] + t * b[1]]);
      }
      q = next;
    }
    out.push(q[0]);
  }
  return out;
}

const TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;

export function pathToPolys(d: string, curveN = 12): Poly[] {
  const toks: string[] = [];
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(d || "")) !== null) toks.push(match[1] || match[2]);

  let i = 0;
  let cur: Point = [0, 0];
  let start: Point = [0, 0];
  const polys: Poly[] = [];
  let poly: Point[] = [];
  let cmd = "";
  let prevC2: Point | null = null;
  let prevQ: Point | null = null;
  const num = () => Number(toks[i++]);

  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i])) cmd = toks[i++];
    if (!cmd) break;
    const rel = cmd !== cmd.toUpperCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cur[0] : 0;
    const oy = rel ? cur[1] : 0;
    if (C === "M") {
      if (poly.length > 1) polys.push([poly, false]);
      const x = num() + ox;
      const y = num() + oy;
      cur = start = [x, y];
      poly = [[x, y]];
      cmd = rel ? "l" : "L";
      prevC2 = prevQ = null;
    } else if (C === "L") {
      cur = [num() + ox, num() + oy]; poly.push(cur); prevC2 = prevQ = null;
    } else if (C === "H") {
      cur = [num() + ox, cur[1]]; poly.push(cur); prevC2 = prevQ = null;
    } else if (C === "V") {
      cur = [cur[0], num() + oy]; poly.push(cur); prevC2 = prevQ = null;
    } else if (C === "C" || C === "S") {
      const c1: Point = C === "C"
        ? [num() + ox, num() + oy]
        : prevC2 ? [2 * cur[0] - prevC2[0], 2 * cur[1] - prevC2[1]] : [cur[0], cur[1]];
      const c2: Point = [num() + ox, num() + oy];
      const e: Point = [num() + ox, num() + oy];
      for (const pt of bezier([cur, c1, c2, e], curveN)) poly.push(pt);
      prevC2 = c2; prevQ = null; cur = e;
    } else if (C === "Q" || C === "T") {
      const q: Point = C === "Q"
        ? [num() + ox, num() + oy]
        : prevQ ? [2 * cur[0] - prevQ[0], 2 * cur[1] - prevQ[1]] : [cur[0], cur[1]];
      const e: Point = [num() + ox, num() + oy];
      for (const pt of bezier([cur, q, e], Math.max(6, Math.floor(curveN / 2)))) poly.push(pt);
      prevQ = q; prevC2 = null; cur = e;
    } else if (C === "A") {
      const rx = num(), ry = num(), rot = num();
      const large = Math.trunc(num());
      const sweep = Math.trunc(num());
      const e: Point = [num() + ox, num() + oy];
      for (const pt of arcPoints(cur[0], cur[1], rx, ry, rot, large, sweep, e[0], e[1])) poly.push(pt);
      cur = e; prevC2 = prevQ = null;
    } else if (C === "Z") {
      if (poly.length > 1) polys.push([poly, true]);
      poly = [[start[0], start[1]]];
      cur = [start[0], start[1]];
      prevC2 = prevQ = null;
    } else {
      break;
    }
  }
  if (poly.length > 1) polys.push([poly, false]);
  return polys;
}

export function rectToPoly(x: number, y: number, w: number, h: number, rx = 0, n = 8): Poly {
  const r = Math.min(rx, w / 2, h / 2);
  if (r <= 0) return [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]], true];
  const p: Point[] = [];
  const arcs: Array<[number, number, number]> = [
    [x + w - r, y + r, -90], [x + w - r, y + h - r, 0],
    [x + r, y + h - r, 90], [x + r, y + r, 180],
  ];
  for (const [cx, cy, a0] of arcs) {
    for (let k = 0; k <= n; k += 1) {
      const a = ((a0 + (90 * k) / n) * Math.PI) / 180;
      p.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return [p, true];
}

export function circleToPoly(cx: number, cy: number, r: number, n = 40, ry?: number): Poly {
  const radiusY = ry === undefined ? r : ry;
  const p: Point[] = [];
  for (let i = 0; i < n; i += 1) {
    p.push([cx + r * Math.cos((2 * Math.PI * i) / n), cy + radiusY * Math.sin((2 * Math.PI * i) / n)]);
  }
  return [p, true];
}

/** 折线上转得急的顶点 —— 手抖滤镜要在这些点上收着，不然折角磨没了 */
export function corners(poly: Point[], closed: boolean, deg = 32): Set<number> {
  const out = new Set<number>();
  const n = poly.length;
  for (let i = 0; i < n; i += 1) {
    if (!closed && (i === 0 || i === n - 1)) continue;
    const a = poly[(i - 1 + n) % n];
    const b = poly[i];
    const c = poly[(i + 1) % n];
    const v1: Point = [b[0] - a[0], b[1] - a[1]];
    const v2: Point = [c[0] - b[0], c[1] - b[1]];
    const l1 = hypot(v1[0], v1[1]) || 1;
    const l2 = hypot(v2[0], v2[1]) || 1;
    const cosang = Math.max(-1, Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (l1 * l2)));
    if ((Math.acos(cosang) * 180) / Math.PI > deg) out.add(i);
  }
  return out;
}

export function dedupe(poly: Point[], eps = 0.06): Point[] {
  const out: Point[] = [poly[0]];
  for (const p of poly.slice(1)) {
    const last = out[out.length - 1];
    if (hypot(p[0] - last[0], p[1] - last[1]) > eps) out.push(p);
  }
  return out;
}
