/* 智能识别的拙趣写法：拿合成的描摹轨迹逐条验一遍。跑法：npx tsx tools/strokes-check.ts */
import { BASE_STYLE, flattenSegments, recognizeStroke, snapEnds, type Point, type Segment } from "../src/lib/strokes";

let failures = 0;
function check(label: string, ok: boolean, detail: unknown) {
  if (!ok) failures += 1;
  console.log(`${ok ? "✓" : "✗"} ${label}`, ok ? "" : JSON.stringify(detail));
}

/** 折线轨迹 → 密采样，再叠一点确定性的手抖。 */
function trace(points: Point[], jitter = 0.15): Point[] {
  const out: Point[] = [];
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  for (let i = 1; i < points.length; i += 1) {
    const [a, b] = [points[i - 1], points[i]];
    const n = Math.max(4, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.6));
    for (let s = i === 1 ? 0 : 1; s <= n; s += 1) {
      const t = s / n;
      out.push([a[0] + (b[0] - a[0]) * t + rand() * jitter, a[1] + (b[1] - a[1]) * t + rand() * jitter]);
    }
  }
  return out;
}

const deg = (a: Point, b: Point) => Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
const ends = (segs: Segment[]) => { const pts = flattenSegments(segs); return [pts[0], pts[pts.length - 1]] as [Point, Point]; };

// 1. 横：斜着描（8°）→ 压到 2.5° 以内，不再拉成完全水平；几乎平的照旧写 H
{
  const r = recognizeStroke(trace([[12, 30], [52, 30 - 40 * Math.tan(8 * Math.PI / 180)]]), 64, BASE_STYLE);
  const [a, b] = ends(r!.segs);
  const tilt = deg(a, b);
  check(`横 描成 -8° → ${tilt.toFixed(2)}°（保留斜度，压到 ±2.5° 以内）`, r!.type === "横" && Math.abs(tilt) <= 2.6 && Math.abs(tilt) > 1, { type: r!.type, tilt });
  const flat = recognizeStroke(trace([[12, 30], [52, 30.1]], 0.05), 64, BASE_STYLE);
  check(`横 几乎平 → 写 ${flat!.segs[1].c}`, flat!.segs[1].c === "H", flat!.segs);
}

// 2. 横折：空字库默认写尖角，不再带 r≈2.5 的圆角 Q
{
  const r = recognizeStroke(trace([[14, 14], [46, 14], [46, 46]]), 64, BASE_STYLE);
  const hasQ = r!.segs.some((s) => s.c === "Q");
  check(`横折 → ${r!.type}，命令 ${r!.segs.map((s) => s.c).join("")}（没有圆角 Q）`, r!.type === "横折" && !hasQ, r!.segs);
}

// 3. 竖钩：描了 10 个单位长的钩 → 收到 5
{
  const r = recognizeStroke(trace([[32, 10], [32, 50], [24, 44]]), 64, BASE_STYLE);
  const pts = flattenSegments(r!.segs);
  const hook = Math.hypot(pts[pts.length - 1][0] - pts[pts.length - 2][0], pts[pts.length - 1][1] - pts[pts.length - 2][1]);
  check(`竖钩 → ${r!.type}，钩长 ${hook.toFixed(1)}（≤ 5），备注 ${r!.notes.join("/")}`, r!.type === "竖钩" && hook <= 5.05, { segs: r!.segs, hook });
}

// 3b. 卧钩不收（心的钩关系到认字）
{
  const pts: Point[] = [];
  // 往右下走、向下弓（逆时针），再往左上挑一个 9 个单位的钩
  for (let i = 0; i <= 30; i += 1) { const t = i / 30; pts.push([14 + 32 * t, 36 + 16 * t + 6 * Math.sin(t * Math.PI)]); }
  pts.push([43, 44]);
  const r = recognizeStroke(trace(pts, 0.05), 64, BASE_STYLE);
  check(`卧钩（识别为 ${r!.type}）→ 钩不收，备注 ${r!.notes.join("/") || "无"}`, r!.type === "卧钩" && !r!.notes.includes("钩已收短"), r);
}

// 4. 撇：控制点往弦上收
{
  const pts: Point[] = [];
  for (let i = 0; i <= 30; i += 1) { const t = i / 30; pts.push([40 - 26 * t - 6 * Math.sin(t * Math.PI), 12 + 38 * t]); }
  const r = recognizeStroke(trace(pts, 0.05), 64, BASE_STYLE);
  check(`撇 → ${r!.type}，备注 ${r!.notes.join("/")}`, r!.type === "撇" && r!.notes.includes("已拉直"), r);
}

// 5. 端点吸附：字里已经有一竖 x=20（y 10–50）
const shu: Segment[] = [{ c: "M", p: [[20, 10]] }, { c: "V", p: [[20, 50]] }];
{
  const line = (a: Point, b: Point): Segment[] => [{ c: "M", p: [a] }, { c: "L", p: [b] }];
  const joined = snapEnds(line([21.8, 15], [45, 15]), [shu], 64);
  check(`差 1.8 没碰上 → 接准，起点 ${JSON.stringify(joined?.segs[0].p[0])}`, !!joined && joined.joined === 1 && joined.segs[0].p[0][0] === 20, joined);
  const hJoined = snapEnds([{ c: "M", p: [[21.8, 15]] }, { c: "H", p: [[45, 15]] }], [shu], 64);
  check(`横（H）起点接准后还是 H：${hJoined?.segs.map((s) => s.c).join("")}`, !!hJoined && hJoined.segs[1].c === "H" && hJoined.segs[0].p[0][0] === 20, hJoined);
  const trimmed = snapEnds(line([45, 30], [17.6, 30]), [shu], 64);
  check(`穿过去 2.4 → 截在交点，终点 ${JSON.stringify(trimmed?.segs[1].p[0])}`, !!trimmed && trimmed.trimmed === 1 && trimmed.segs[1].p[0][0] === 20, trimmed);
  const floated = snapEnds(line([23.2, 40], [45, 40]), [shu], 64);
  check(`离 3.2 不远不近 → 推开，起点 ${JSON.stringify(floated?.segs[0].p[0])}`, !!floated && floated.floated === 1 && floated.segs[0].p[0][0] >= 24.4, floated);
  const clear = snapEnds(line([27, 20], [45, 20]), [shu], 64);
  check("离 7 明确浮开 → 不动", clear === null, clear);
  const crossing = snapEnds(line([10, 25], [45, 25]), [shu], 64);
  check("真交叉（十字，伸出去 10）→ 不动", crossing === null, crossing);
  const dot = snapEnds(line([23, 20], [25, 24]), [shu], 64, true);
  const [da] = ends(dot!.segs);
  check(`点离 3 → 整笔推开到 ${(da[0] - 20).toFixed(1)}`, !!dot && dot.floated === 1 && da[0] - 20 >= 4.4, dot);
}

console.log(failures ? `\n${failures} 项不对` : "\n全部通过");
process.exit(failures ? 1 : 0);
