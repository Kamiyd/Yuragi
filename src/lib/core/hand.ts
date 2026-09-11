/* 手绘感线条生成器：这是「同一支笔」的物理载体。

   做法：图形先按「骨架折线」定义，再统一过一遍手抖滤镜 ——
   沿法线叠低频正弦噪声（手画的线不直）、两头各探出一点点（收笔越位）、
   用 Catmull-Rom 转成平滑贝塞尔。转角处把点重复一次来收紧切线，
   不然所有折角都会被磨圆成一坨。

   这份文件是 hand.py 的逐行移植。改这里的任何一个系数都会把整套字带偏，
   而且跟 Python 那份就对不上了 —— 对照测试 tools/parity 会当场红。 */
import type { Point } from "./dpath";
import { fmtFixed, pmod, pyRoundInt, hypot } from "./num";

type Sample = [number, number, boolean];   // x, y, 是不是硬角

function catmullRom(pts: Point[], closed = false): string {
  const p = closed ? [...pts, pts[0]] : [...pts];
  const d = [`M${fmtFixed(p[0][0], 2)} ${fmtFixed(p[0][1], 2)}`];
  const ext = [p[0], ...p, p[p.length - 1]];
  for (let i = 0; i < p.length - 1; i += 1) {
    const p0 = ext[i], p1 = ext[i + 1], p2 = ext[i + 2], p3 = ext[i + 3];
    const c1: Point = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2: Point = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d.push(`C${fmtFixed(c1[0], 2)} ${fmtFixed(c1[1], 2)} ${fmtFixed(c2[0], 2)} ${fmtFixed(c2[1], 2)} `
      + `${fmtFixed(p2[0], 2)} ${fmtFixed(p2[1], 2)}`);
  }
  if (closed) d.push("Z");
  return d.join("");
}

/** 按弧长重采样；sharp 里的顶点索引会被保留并重复，转角才立得住 */
function resample(pts: Point[], step = 1.1, sharp: Set<number> = new Set()): Sample[] {
  const out: Sample[] = [];
  for (let i = 0; i < pts.length - 1; i += 1) {
    const a = pts[i];
    const b = pts[i + 1];
    const L = hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.trunc(pyRoundInt(L / step)));
    for (let k = 0; k < n; k += 1) {
      const t = k / n;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, sharp.has(i) && k === 0]);
    }
  }
  const last = pts[pts.length - 1];
  out.push([last[0], last[1], sharp.has(pts.length - 1)]);
  return out;
}

export type HandOptions = {
  seed?: number;
  amp?: number;
  closed?: boolean;
  sharp?: Set<number>;
  over?: number;
  step?: number;
};

/** 骨架折线 -> 手绘路径 */
export function hand(pts: Point[], options: HandOptions = {}): string {
  const { seed = 0, amp = 0.34, closed = false, sharp = new Set<number>(), over = 0.55, step = 1.1 } = options;
  const input = closed ? [...pts, pts[0]] : [...pts];
  const s = resample(input, step, sharp);
  const ph = [0, 1, 2].map((k) => pmod(seed * 1.7 + k * 2.399, 2 * Math.PI));
  const n = s.length;
  let res: Point[] = [];
  for (let i = 0; i < n; i += 1) {
    const [x, y, isSharp] = s[i];
    const u = i / Math.max(1, n - 1);
    const j = Math.min(i + 1, n - 1);
    const k = Math.max(i - 1, 0);
    const dx = s[j][0] - s[k][0];
    const dy = s[j][1] - s[k][1];
    const L = hypot(dx, dy) || 1;
    const nx = -dy / L;
    const ny = dx / L;
    let w = amp * 0.62 * Math.sin(2 * Math.PI * 1.3 * u + ph[0])
      + amp * 0.42 * Math.sin(2 * Math.PI * 2.7 * u + ph[1])
      + amp * 0.22 * Math.sin(2 * Math.PI * 4.1 * u + ph[2]);
    if (isSharp) w *= 0.25;                 // 转角上别抖，抖了就散了
    res.push([x + nx * w, y + ny * w]);
  }
  const extend = !closed && !!over;
  if (extend) {
    // 两头各探出去一点：手画收不住笔
    const push = (a: Point, b: Point, d: number): Point => {
      const L = hypot(b[0] - a[0], b[1] - a[1]) || 1;
      return [a[0] - ((b[0] - a[0]) / L) * d, a[1] - ((b[1] - a[1]) / L) * d];
    };
    res = [push(res[0], res[1], over * 0.6), ...res, push(res[res.length - 1], res[res.length - 2], over)];
  }
  // 重复的转角点会让 Catmull-Rom 的切线收紧
  const final: Point[] = [];
  for (let i = 0; i < res.length; i += 1) {
    const p = res[i];
    final.push(p);
    const idx = i - (extend ? 1 : 0);
    if (idx >= 0 && idx < s.length && s[idx][2]) final.push(p);
  }
  return catmullRom(final, closed);
}
