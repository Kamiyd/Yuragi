/**
 * 笔画识别。
 *
 * 描摹轨迹进来，出去的是一条**有名字的**笔画骨架：竖弯钩就是竖弯钩，不是「竖折横」。
 *
 * 老版本把轨迹上所有拐弯一律当成折角，于是圆转的「弯」被切成两段直线；这里改成先按
 * **转角发生的实际长度**区分「折」和「弯」——折在很短的距离里转完，弯要绕上大半个字高
 * ——再拿拐点序列去和汉字基本笔画表比对，最后按现有字库的写法（横的倾角、折角圆角
 * 半径、钩的长度…）把骨架画出来。
 *
 * 所有阈值都在 vb=64 的归一化坐标里标定，进出口各做一次缩放。
 */

export type Point = [number, number];
export type Segment = { c: string; p: Point[]; a?: number[] };

const NORM_VB = 64;
const SAMPLES = 96;

/* ────────────────────────── 基础几何 ────────────────────────── */

function dist(a: Point, b: Point) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function polylineLength(points: Point[]) {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += dist(points[i - 1], points[i]);
  return total;
}

function lerpPoint(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** 屏幕坐标系（y 向下）：0=向右，90=向下，±180=向左，-90=向上。 */
function angleDeg(a: Point, b: Point) {
  return Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
}

/** 有符号夹角，落在 (-180, 180]；正号=屏幕上顺时针。 */
function angleDelta(from: number, to: number) {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta <= -180) delta += 360;
  return delta;
}

function pointSegmentDistance(point: Point, a: Point, b: Point) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (!dx && !dy) return dist(point, a);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return dist(point, [a[0] + t * dx, a[1] + t * dy]);
}

function dedupe(points: Point[], gap: number) {
  const output: Point[] = [];
  for (const point of points) {
    const last = output[output.length - 1];
    if (!last || dist(last, point) >= gap) output.push(point);
  }
  const tail = points[points.length - 1];
  if (output.length && tail && dist(output[output.length - 1], tail) > 0) output[output.length - 1] = tail;
  return output;
}

/** 等弧长重采样；端点原样保留，后面所有窗口尺寸都能按采样步长换算成实际长度。 */
function resample(points: Point[], count: number): Point[] {
  if (points.length < 2) return points.slice();
  const total = polylineLength(points);
  if (total <= 0) return [points[0], points[points.length - 1]];
  const step = total / (count - 1);
  const output: Point[] = [points[0]];
  let index = 1;
  let walked = 0;
  for (let n = 1; n < count - 1; n += 1) {
    const target = n * step;
    while (index < points.length - 1 && walked + dist(points[index - 1], points[index]) < target) {
      walked += dist(points[index - 1], points[index]);
      index += 1;
    }
    const span = dist(points[index - 1], points[index]) || 1;
    output.push(lerpPoint(points[index - 1], points[index], (target - walked) / span));
  }
  output.push(points[points.length - 1]);
  return output;
}

/**
 * 按实测抖动量决定平滑力度。
 *
 * 平滑得太狠会把短钩的折角抹平，太轻又会在手抖的轨迹上切出一堆假折角，所以先量一下
 * 每个采样点偏离左右邻居连线多少——平滑曲线上这个量趋近 0，噪声上正比于抖动幅度。
 */
function denoise(points: Point[], total: number): Point[] {
  if (points.length < 4 || total <= 0) return points.slice();
  let rough = 0;
  for (let i = 1; i < points.length - 1; i += 1) {
    rough += pointSegmentDistance(points[i], points[i - 1], points[i + 1]);
  }
  rough /= (points.length - 2) * total;
  return smooth(points, Math.max(1, Math.min(6, Math.round(2 + rough * 1080))));
}

/** 轻度平滑，只削采样抖动；端点不动，避免起收笔被拉走。 */
function smooth(points: Point[], radius: number): Point[] {
  if (radius < 1 || points.length <= 2 * radius + 2) return points.slice();
  const output: Point[] = [points[0]];
  for (let i = 1; i < points.length - 1; i += 1) {
    const from = Math.max(0, i - radius);
    const to = Math.min(points.length - 1, i + radius);
    let x = 0;
    let y = 0;
    for (let c = from; c <= to; c += 1) {
      x += points[c][0];
      y += points[c][1];
    }
    output.push([x / (to - from + 1), y / (to - from + 1)]);
  }
  output.push(points[points.length - 1]);
  return output;
}

/* ────────────────────────── segs ⇄ 折线 ────────────────────────── */

function quadraticAt(p0: Point, c: Point, p1: Point, t: number): Point {
  const m = 1 - t;
  return [
    m * m * p0[0] + 2 * m * t * c[0] + t * t * p1[0],
    m * m * p0[1] + 2 * m * t * c[1] + t * t * p1[1],
  ];
}

function cubicAt(p0: Point, c1: Point, c2: Point, p1: Point, t: number): Point {
  const m = 1 - t;
  return [
    m * m * m * p0[0] + 3 * m * m * t * c1[0] + 3 * m * t * t * c2[0] + t * t * t * p1[0],
    m * m * m * p0[1] + 3 * m * m * t * c1[1] + 3 * m * t * t * c2[1] + t * t * t * p1[1],
  ];
}

/**
 * 把一条骨架 segs 摊成折线，学习和识别共用同一套解析器。
 * A（椭圆弧）按弦处理——字库里没用过它，真出现了也只是少算一点弧度。
 */
export function flattenSegments(segs: Segment[], steps = 12): Point[] {
  const points: Point[] = [];
  let cursor: Point = [0, 0];
  let start: Point = [0, 0];
  const push = (point: Point) => {
    const last = points[points.length - 1];
    if (!last || dist(last, point) > 1e-6) points.push(point);
  };
  for (const segment of segs) {
    const list = segment.p || [];
    const end = list[list.length - 1];
    if (segment.c === "Z") {
      push(start);
      cursor = start;
      continue;
    }
    if (!end) continue;
    if (segment.c === "M") {
      cursor = [end[0], end[1]];
      start = cursor;
      push(cursor);
      continue;
    }
    let next: Point = [end[0], end[1]];
    if (segment.c === "H") next = [end[0], cursor[1]];
    if (segment.c === "V") next = [cursor[0], end[1]];
    if (segment.c === "Q" && list[0]) {
      for (let s = 1; s <= steps; s += 1) push(quadraticAt(cursor, list[0], next, s / steps));
    } else if (segment.c === "C" && list[0] && list[1]) {
      for (let s = 1; s <= steps; s += 1) push(cubicAt(cursor, list[0], list[1], next, s / steps));
    } else {
      push(next);
    }
    cursor = next;
  }
  return points;
}

/* ────────────────────────── 拐点分析 ────────────────────────── */

type Joint = {
  /** 转角区间的采样下标。 */
  from: number;
  to: number;
  /** 有符号累计转角（度）。 */
  turn: number;
  /** 0 = 干脆的折角，1 = 圆转的弯，中间是拿不准。打分时按连续值罚，不做硬判。 */
  roundness: number;
  /** roundness 的硬化版本，只在没匹配上笔画、需要直接落笔时用。 */
  kind: "corner" | "bend";
  point: Point;
};

type Part = {
  from: number;
  to: number;
  points: Point[];
  length: number;
  dir: number;
  /** 段内累计转角，用来分辨撇/捺这种带弧度的单段笔画。 */
  bow: number;
  /** 相对弦的最大偏离。 */
  deviation: number;
  straight: boolean;
  a: Point;
  b: Point;
  /** 最小二乘拟合出的直线：过 origin，方向 unit。 */
  origin: Point;
  unit: Point;
};

/*
 * 阈值全部相对「整笔」标定，不再依赖字面尺寸。
 *
 * 采样点数固定成 SAMPLES，所以「多长的一段」直接用采样个数表示；转角率用「度/采样」，
 * 一个 90° 的转弯不管画多大，占的采样数都一样。之前用「度/单位长度」，同一个竖弯钩
 * 画小一号就会被判成折——那是实测里最常见的一类错。
 */
const DIR_WINDOW = 5;           // 方向用前后各 5 个采样的弦来估：窗口窄了，稀疏采样上全是假折角
const TURN_RATE = 2;            // 度/采样：超过它才算在转
const JOINT_MIN_TURN = 25;      // 低于这个转角只算段内弧度
const BEND_MIN_TURN = 40;       // 「弯」总是接近直角；转得少的圆弧留在段里当弧度
const TURN_BLUR = 3;            // 方向窗口自己会把一个尖角摊开这么多采样，量半径时扣掉
const PEAK_GUARD = 4;           // 两个峰至少隔这么多采样
const REGION_GAP = 2;           // 转角区之间断这么点就当没断
const MERGE_REACH = 0.85;       // 同向的转角区挨得够近就并成一个（鼠标把圆弯画成了几折）
const MERGE_MAX_GAP = 10;       // 中间隔了这么多采样就不是同一个弯了
const MERGE_MAX_TURN = 90;      // 并起来超过这个角度多半是「弯 + 钩」，不能并
const SHARP_RATIO = 0.045;      // 转弯半径 ÷ 整笔长度：小于它是纯尖角
const ROUND_RATIO = 0.26;       // 大于它是纯圆弯，中间线性过渡
const BEND_CONTRAST = 2.2;      // 弯要比两侧明显更弯，否则只是整笔在弓
const CORNER_CONTRAST = 1.3;    // 转角不大的「折」同理，免得把弓背上的一点起伏切成折
const MIN_ARM = 1.6;            // 拐点两侧至少各有这么长（字面 64 格），否则只是抖
const PRUNE_TURN = 55;          // 只有转得不多的折才可能是运动噪声，大转角一律保留
const PRUNE_TOL = 0.06;         // 并掉之后还能拟合到整笔长的这个比例以内，就说明那不是折

/** 逐采样的转向角（度）。整笔采样数固定，所以这个量天然与画多大无关。 */
function turnRate(points: Point[]) {
  const dirs: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const from = points[Math.max(0, i - DIR_WINDOW)];
    const to = points[Math.min(points.length - 1, i + DIR_WINDOW)];
    dirs.push(dist(from, to) > 1e-6 ? angleDeg(from, to) : dirs[i - 1] ?? 0);
  }
  const rate: number[] = [0];
  for (let i = 1; i < dirs.length; i += 1) rate.push(angleDelta(dirs[i - 1], dirs[i]));
  return rate;
}

type Region = { from: number; to: number; peak: number; turn: number };

/** 把转角率的峰长成区间：从峰往两边长，降到峰值四成就停，钩的尖角不会顺着碗吃过去。 */
function turnRegions(rate: number[]): Region[] {
  const magnitude = rate.map(Math.abs);
  const peaks: number[] = [];
  for (let i = 1; i < rate.length - 1; i += 1) {
    if (magnitude[i] < TURN_RATE) continue;
    if (magnitude[i] < magnitude[i - 1] || magnitude[i] <= magnitude[i + 1]) continue;
    peaks.push(i);
  }
  const chosen: number[] = [];
  for (const index of peaks.slice().sort((a, b) => magnitude[b] - magnitude[a])) {
    if (!chosen.some((other) => Math.abs(index - other) < PEAK_GUARD)) chosen.push(index);
  }
  chosen.sort((a, b) => a - b);

  const regions: Region[] = [];
  for (const index of chosen) {
    const sign = Math.sign(rate[index]);
    const floor = Math.max(TURN_RATE, magnitude[index] * 0.4);
    let from = index;
    let to = index;
    while (from > 1 && magnitude[from - 1] >= floor && Math.sign(rate[from - 1]) === sign) from -= 1;
    while (to < rate.length - 1 && magnitude[to + 1] >= floor && Math.sign(rate[to + 1]) === sign) to += 1;
    const last = regions[regions.length - 1];
    if (last && from <= last.to + REGION_GAP) last.to = Math.max(last.to, to);
    else regions.push({ from, to, peak: 0, turn: 0 });
  }

  // 鼠标/快笔会把一个圆弯画成连着的好几折。同方向、挨得近、并起来还不到一个直角的，
  // 本来就是一个弯。合起来超过 135° 的不并——那多半是「弯」后面紧跟着「钩」。
  for (let i = 0; i < regions.length - 1; ) {
    const left = regions[i];
    const right = regions[i + 1];
    const turn = sumRate(rate, left) + sumRate(rate, right);
    const sameWay = Math.sign(sumRate(rate, left)) === Math.sign(sumRate(rate, right));
    const gap = right.from - left.to;
    const reach = (left.to - left.from) + (right.to - right.from) + 2;
    if (sameWay && Math.abs(turn) <= MERGE_MAX_TURN && gap <= Math.min(MERGE_MAX_GAP, MERGE_REACH * reach)) {
      left.to = right.to;
      regions.splice(i + 1, 1);
    } else {
      i += 1;
    }
  }

  for (const region of regions) {
    region.turn = sumRate(rate, region);
    region.peak = 0;
    for (let i = region.from; i <= region.to; i += 1) region.peak = Math.max(region.peak, magnitude[i]);
  }
  return regions;
}

function sumRate(rate: number[], region: { from: number; to: number }) {
  let total = 0;
  for (let i = region.from; i <= region.to; i += 1) total += rate[i];
  return total;
}

/** 找出所有拐点，并给出「有多圆」——0 是纯尖角，1 是纯圆弯。 */
function findJoints(points: Point[], total: number): Joint[] {
  const rate = turnRate(points);
  const magnitude = rate.map(Math.abs);
  const regions = turnRegions(rate);
  const last = points.length - 1;

  const baseline = median(magnitude.slice(1));
  /** 区间两侧同样长的地方平均弯多少；窗口不越过相邻转角区。 */
  const around = (index: number) => {
    const region = regions[index];
    const reach = Math.max(2, region.to - region.from);
    const left = regions[index - 1] ? regions[index - 1].to + 1 : 1;
    const right = regions[index + 1] ? regions[index + 1].from - 1 : rate.length - 1;
    let sum = 0;
    let count = 0;
    for (let i = Math.max(left, region.from - reach); i < region.from; i += 1) { sum += magnitude[i]; count += 1; }
    for (let i = region.to + 1; i <= Math.min(right, region.to + reach); i += 1) { sum += magnitude[i]; count += 1; }
    return Math.max(baseline, count ? sum / count : 0);
  };

  const joints: Joint[] = [];
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index];
    const from = Math.max(0, region.from - 1);
    const to = Math.min(last, region.to + 1);
    if (Math.abs(region.turn) < JOINT_MIN_TURN) continue;
    // 起收笔的小甩尾不算一折。除了采样数，还要有实打实的长度——
    // 一个 5 个单位长的点上是画不出「折」的，那只能是手抖。
    if (from < 2 || last - to < 2) continue;
    if (polylineLength(points.slice(0, from + 1)) < MIN_ARM) continue;
    if (polylineLength(points.slice(to)) < MIN_ARM) continue;
    if (total < MIN_ARM * 3) continue;

    // 折还是弯，看的是**转弯半径占整笔多大比例**：折是在某处拐一下，弯要绕掉小半笔。
    // 采样点数固定，所以这个比值与画多大、画在哪都无关——之前拿绝对长度比，
    // 同一个竖弯钩画小一号就变成折了。
    const radius = Math.max(0, (to - from) - TURN_BLUR) / Math.max(0.4, Math.abs(region.turn) * Math.PI / 180);
    const ratio = radius / last;
    const roundness = Math.max(0, Math.min(1, (ratio - SHARP_RATIO) / (ROUND_RATIO - SHARP_RATIO)));

    // 整笔都在弓（撇肚、卧钩的碗、弯钩）时，这里并不比别处更弯，不该切开。
    // 越圆越要求突出；转角够大的尖折不用查，那么急的转向不可能是弓背上的起伏。
    const contrast = CORNER_CONTRAST + (BEND_CONTRAST - CORNER_CONTRAST) * roundness;
    const lenient = roundness < 0.5 && Math.abs(region.turn) >= 60;
    if (roundness >= 0.5 && Math.abs(region.turn) < BEND_MIN_TURN) continue;
    if (!lenient && region.peak < around(index) * contrast) continue;

    joints.push({
      from,
      to,
      turn: region.turn,
      roundness,
      kind: roundness >= 0.5 ? "bend" : "corner",
      point: points[Math.round((from + to) / 2)],
    });
  }
  return joints;
}

function fitLine(points: Point[]): { origin: Point; unit: Point } {
  let cx = 0;
  let cy = 0;
  for (const point of points) {
    cx += point[0];
    cy += point[1];
  }
  cx /= points.length;
  cy /= points.length;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const point of points) {
    const dx = point[0] - cx;
    const dy = point[1] - cy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let unit: Point = [Math.cos(theta), Math.sin(theta)];
  const chord: Point = [points[points.length - 1][0] - points[0][0], points[points.length - 1][1] - points[0][1]];
  if (unit[0] * chord[0] + unit[1] * chord[1] < 0) unit = [-unit[0], -unit[1]];
  return { origin: [cx, cy], unit };
}

function projectOnLine(origin: Point, unit: Point, point: Point): Point {
  const t = (point[0] - origin[0]) * unit[0] + (point[1] - origin[1]) * unit[1];
  return [origin[0] + unit[0] * t, origin[1] + unit[1] * t];
}

function buildPart(points: Point[], from: number, to: number, total: number): Part | null {
  const span = points.slice(from, to + 1);
  if (span.length < 2) return null;
  const length = polylineLength(span);
  if (length < total * 0.006) return null;
  const a = span[0];
  const b = span[span.length - 1];
  let deviation = 0;
  for (const point of span) deviation = Math.max(deviation, pointSegmentDistance(point, a, b));
  let bow = 0;
  for (const value of turnRate(span)) bow += value;
  const fit = fitLine(span);
  return {
    from,
    to,
    points: span,
    length,
    dir: angleDeg(a, b),
    bow,
    deviation,
    straight: deviation < Math.max(total * 0.007, Math.min(total * 0.017, length * 0.035)),
    a,
    b,
    origin: fit.origin,
    unit: fit.unit,
  };
}

/** 一段轨迹用直线或单条三次贝塞尔能拟合到多准。 */
function fitError(span: Point[]): number {
  const a = span[0];
  const b = span[span.length - 1];
  let line = 0;
  for (const point of span) line = Math.max(line, pointSegmentDistance(point, a, b));
  const controls = fitCubic(span, a, b, tangentAt(span, true), tangentAt(span, false));
  if (!controls) return line;
  const on: Point[] = [];
  for (let i = 0; i <= 24; i += 1) on.push(cubicAt(a, controls[0], controls[1], b, i / 24));
  let curve = 0;
  for (const point of span) {
    let nearest = Infinity;
    for (let i = 1; i < on.length; i += 1) nearest = Math.min(nearest, pointSegmentDistance(point, on[i - 1], on[i]));
    curve = Math.max(curve, nearest);
    if (curve >= line) break;
  }
  return Math.min(line, curve);
}

/**
 * 去掉「并回去也看不出差别」的折角。
 *
 * 手画曲线是一段一段折着走的，鼠标尤其明显：一个圆弯会被画成三四折。这些折点在
 * 轨迹上是真的，但不是笔画的结构——把两段并起来还能一条线／一条曲线拟合出来，
 * 就说明那一折只是运动噪声。转角大的一律留着，那种一定是结构。
 */
function pruneJoints(points: Point[], parts: Part[], joints: Joint[], total: number) {
  const tol = total * PRUNE_TOL;
  for (;;) {
    let best = -1;
    let bestError = Infinity;
    for (let i = 0; i < joints.length; i += 1) {
      if (Math.abs(joints[i].turn) >= PRUNE_TURN) continue;
      const error = fitError(points.slice(parts[i].from, parts[i + 1].to + 1));
      if (error <= tol && error < bestError) { bestError = error; best = i; }
    }
    if (best < 0) return;
    const merged = buildPart(points, parts[best].from, parts[best + 1].to, total);
    if (!merged) return;
    parts.splice(best, 2, merged);
    joints.splice(best, 1);
  }
}

/** 轨迹 → 「直段 + 拐点」的交替序列。 */
function decompose(points: Point[]) {
  const total = polylineLength(points);
  const found = findJoints(points, total);
  const parts: Part[] = [];
  const kept: Joint[] = [];
  let cursor = 0;
  for (const joint of found) {
    const part = buildPart(points, cursor, joint.from, total);
    if (!part) continue;
    parts.push(part);
    kept.push(joint);
    cursor = joint.to;
  }
  const tail = buildPart(points, cursor, points.length - 1, total);
  if (tail) parts.push(tail);
  else if (kept.length) {
    // 尾巴太短，退回上一折。
    kept.pop();
    const merged = buildPart(points, parts[parts.length - 1]?.from ?? 0, points.length - 1, total);
    if (merged) parts[parts.length - 1] = merged;
  }
  if (!parts.length) {
    const whole = buildPart(points, 0, points.length - 1, total);
    return { parts: whole ? [whole] : [], joints: [] as Joint[], total };
  }
  const joints = kept.slice(0, parts.length - 1);
  pruneJoints(points, parts, joints, total);
  return { parts, joints, total };
}

/* ────────────────────────── 笔画表 ────────────────────────── */

type PartSpec = {
  /** 期望方向（度）。 */
  dir: number;
  tol?: number;
  /** 期望弧度：+1 顺时针（撇），-1 逆时针（捺），0 直。 */
  bow?: number;
  /** 长度占整笔的比例上/下限，用来分开「横撇」和「横钩」这种同形不同长的。 */
  max?: number;
  min?: number;
  /** 绝对长度上/下限（vb=64 的格子里），单段笔画靠它分点和捺。 */
  maxAbs?: number;
  minAbs?: number;
};

type StrokeTemplate = {
  name: string;
  parts: PartSpec[];
  /** 段与段之间：折角还是圆弯。 */
  joins: ("corner" | "bend" | "any")[];
};

/**
 * 汉字基本笔画表。方向是屏幕角度（0 向右、90 向下），弧度取自楷体/手写的常见写法。
 * 钩、点这类短段用 max 限长，长段用 min 兜底，免得「横撇」和「横钩」互相抢。
 */
const TEMPLATES: StrokeTemplate[] = [
  { name: "横", parts: [{ dir: -2, tol: 26, minAbs: 8 }], joins: [] },
  { name: "竖", parts: [{ dir: 90, tol: 22, minAbs: 8 }], joins: [] },
  { name: "撇", parts: [{ dir: 140, tol: 34, bow: 1, minAbs: 11 }], joins: [] },
  { name: "捺", parts: [{ dir: 48, tol: 26, bow: -1, minAbs: 14 }], joins: [] },
  { name: "平捺", parts: [{ dir: 20, tol: 16, bow: -1, minAbs: 18 }], joins: [] },
  { name: "提", parts: [{ dir: -32, tol: 26, minAbs: 9 }], joins: [] },
  { name: "点", parts: [{ dir: 58, tol: 40, maxAbs: 15 }], joins: [] },
  { name: "左点", parts: [{ dir: 130, tol: 32, maxAbs: 12 }], joins: [] },

  { name: "横折", parts: [{ dir: -2, tol: 26 }, { dir: 92, tol: 26 }], joins: ["corner"] },
  { name: "横钩", parts: [{ dir: -2, tol: 26 }, { dir: 138, tol: 42, max: 0.34 }], joins: ["corner"] },
  { name: "横撇", parts: [{ dir: -2, tol: 26 }, { dir: 142, tol: 32, min: 0.34 }], joins: ["corner"] },
  { name: "横折弯", parts: [{ dir: -2, tol: 26 }, { dir: 92, tol: 26 }, { dir: 2, tol: 28 }], joins: ["corner", "bend"] },
  { name: "横折折", parts: [{ dir: -2, tol: 26 }, { dir: 92, tol: 26 }, { dir: 2, tol: 28 }], joins: ["corner", "corner"] },
  { name: "横折钩", parts: [{ dir: -2, tol: 26 }, { dir: 94, tol: 24 }, { dir: -142, tol: 40, max: 0.34 }], joins: ["corner", "corner"] },
  { name: "横折提", parts: [{ dir: -2, tol: 26 }, { dir: 96, tol: 26 }, { dir: -34, tol: 30 }], joins: ["corner", "corner"] },
  { name: "横斜钩", parts: [{ dir: -2, tol: 26 }, { dir: 70, tol: 24, bow: -1 }, { dir: -62, tol: 38, max: 0.34 }], joins: ["corner", "corner"] },
  { name: "横折折撇", parts: [{ dir: -2, tol: 26 }, { dir: 142, tol: 34 }, { dir: 2, tol: 28 }, { dir: 142, tol: 34 }], joins: ["corner", "corner", "corner"] },
  { name: "横撇弯钩", parts: [{ dir: -2, tol: 30 }, { dir: 142, tol: 34 }, { dir: 96, tol: 32, bow: 1 }, { dir: -142, tol: 44, max: 0.3 }], joins: ["corner", "corner", "corner"] },
  { name: "横折弯钩", parts: [{ dir: -2, tol: 26 }, { dir: 102, tol: 30 }, { dir: 2, tol: 28 }, { dir: -86, tol: 42, max: 0.3 }], joins: ["corner", "bend", "corner"] },
  { name: "横折折折钩", parts: [{ dir: -2, tol: 28 }, { dir: 142, tol: 34 }, { dir: 2, tol: 28 }, { dir: 96, tol: 28 }, { dir: -142, tol: 44, max: 0.28 }], joins: ["corner", "corner", "corner", "corner"] },

  { name: "竖钩", parts: [{ dir: 90, tol: 22 }, { dir: -142, tol: 40, max: 0.34 }], joins: ["corner"] },
  { name: "弯钩", parts: [{ dir: 94, tol: 26, bow: 1 }, { dir: -142, tol: 40, max: 0.34 }], joins: ["corner"] },
  { name: "竖提", parts: [{ dir: 90, tol: 22 }, { dir: -34, tol: 28 }], joins: ["corner"] },
  { name: "竖折", parts: [{ dir: 90, tol: 24 }, { dir: 2, tol: 28 }], joins: ["corner"] },
  { name: "竖弯", parts: [{ dir: 90, tol: 24 }, { dir: 2, tol: 28 }], joins: ["bend"] },
  { name: "竖弯钩", parts: [{ dir: 90, tol: 24 }, { dir: 2, tol: 28 }, { dir: -86, tol: 42, max: 0.32 }], joins: ["bend", "corner"] },
  { name: "竖折撇", parts: [{ dir: 90, tol: 24 }, { dir: 2, tol: 28 }, { dir: 142, tol: 34 }], joins: ["corner", "corner"] },
  { name: "竖折折钩", parts: [{ dir: 90, tol: 26 }, { dir: 2, tol: 28 }, { dir: 100, tol: 30 }, { dir: -142, tol: 44, max: 0.3 }], joins: ["corner", "corner", "corner"] },

  { name: "斜钩", parts: [{ dir: 72, tol: 22, bow: -1 }, { dir: -62, tol: 38, max: 0.34 }], joins: ["corner"] },
  { name: "卧钩", parts: [{ dir: 30, tol: 30, bow: -1 }, { dir: -112, tol: 46, max: 0.4 }], joins: ["corner"] },
  { name: "撇折", parts: [{ dir: 142, tol: 32 }, { dir: -12, tol: 32 }], joins: ["corner"] },
  { name: "撇点", parts: [{ dir: 142, tol: 32 }, { dir: 52, tol: 34 }], joins: ["corner"] },
];

const BY_COUNT = new Map<number, StrokeTemplate[]>();
for (const template of TEMPLATES) {
  const list = BY_COUNT.get(template.parts.length) || [];
  list.push(template);
  BY_COUNT.set(template.parts.length, list);
}

const JOIN_COST = 0.9;   // 折/弯判反了最多罚这么多
const BOW_REF = 22;       // 「该弯的段」弯到这个角度就算弯够了
const BOW_FLAT = 10;      // 「该直的段」弯到这个角度以内都算直
const BOW_COST = 0.35;    // 弧度对不上最多罚这么多

type Match = { template: StrokeTemplate; cost: number };

function matchTemplate(parts: Part[], joints: Joint[], total: number): Match | null {
  const candidates = BY_COUNT.get(parts.length);
  if (!candidates) return null;
  let best: Match | null = null;
  for (const template of candidates) {
    let cost = 0;
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const spec = template.parts[i];
      const share = part.length / total;
      const weight = Math.max(0.22, share);
      const off = Math.abs(angleDelta(spec.dir, part.dir));
      cost += weight * (off / (spec.tol ?? 30)) ** 2;
      if (spec.max !== undefined && share > spec.max) cost += (share - spec.max) * 6;
      if (spec.min !== undefined && share < spec.min) cost += (spec.min - share) * 6;
      if (spec.maxAbs !== undefined && part.length > spec.maxAbs) cost += (part.length / spec.maxAbs - 1) * 3.2;
      if (spec.minAbs !== undefined && part.length < spec.minAbs) cost += (1 - part.length / spec.minAbs) * 3.2;
      // 弧度：撇捺斜钩这些本来就该弓着，竖钩横折这些本来就该直。连续打分，
      // 不然「弯钩」和「竖钩」只差一点弧度，方向一样，全靠运气。
      if (spec.bow) {
        const aligned = part.bow * Math.sign(spec.bow);
        cost += Math.min(1.2, Math.max(0, (BOW_REF - aligned) / BOW_REF)) * BOW_COST;
      } else {
        cost += Math.min(1, Math.max(0, (Math.abs(part.bow) - BOW_FLAT) / BOW_REF)) * BOW_COST;
      }
    }
    for (let i = 0; i < joints.length; i += 1) {
      const want = template.joins[i];
      if (!want || want === "any") continue;
      // 拿不准的拐点两边都罚一半，让方向和钩去定夺，别被一次硬判带偏。
      // 除以拐点数：折得多的笔画不该因为每个折都沾一点罚分就整体出局。
      cost += Math.abs(joints[i].roundness - (want === "bend" ? 1 : 0)) * JOIN_COST / joints.length;
    }
    if (!best || cost < best.cost) best = { template, cost };
  }
  return best;
}

/* ────────────────────────── 字库风格 ────────────────────────── */

export type StrokeStyle = {
  /** 横的平均倾角（度，负=右端上扬）。 */
  hengTilt: number;
  /** 竖相对垂直的平均偏角。 */
  shuTilt: number;
  /** 折角圆角半径，和用圆角的比例。 */
  cornerRadius: number;
  roundedRatio: number;
};

/**
 * 没有足够样本时使用中性基线，不依赖任何内置或测试字库。
 *
 * 折角默认写尖：圆角比例 0.1，低于落圆角的门槛 0.3。拙趣字（喜茶那类）的折几乎都是
 * 硬折，统一 r≈2.5 的圆角是圆体字的特征。字库里攒够了圆角样本，照样会学成圆的。
 */
export const BASE_STYLE: StrokeStyle = {
  hengTilt: 0,
  shuTilt: 0,
  cornerRadius: 2.5,
  roundedRatio: 0.1,
};

type StyleAccumulator = {
  heng: number[];
  shu: number[];
  corner: number[];
  corners: number;
  rounded: number;
};

/** 横竖的倾角：只统计拆出来的直段，弯的部分不参与。 */
function accumulateTilt(points: Point[], acc: StyleAccumulator) {
  if (points.length < 2 || polylineLength(points) < 1.5) return;
  const cleaned = dedupe(points, 0.08);
  const { parts } = decompose(denoise(resample(cleaned, SAMPLES), polylineLength(cleaned)));
  for (const part of parts) {
    if (!part.straight || part.length < 3) continue;
    const flat = angleDelta(0, angleDeg(part.a, part.b));
    const down = angleDelta(90, angleDeg(part.a, part.b));
    if (Math.abs(flat) < 14) acc.heng.push(flat);
    else if (Math.abs(down) < 14) acc.shu.push(down);
  }
}

/**
 * 折角写法：直接读骨架里的命令，不经过重采样。
 *
 * 字库里的圆角本来就是一个短 Q（`H51 Q53.5 37 53.5 39.5 V49`），控制柄到两端的距离
 * 就是圆角半径；两条直段直接拐弯的则记成尖角。重采样过一遍反而量不准。
 */
function accumulateCorners(segs: Segment[], scale: number, acc: StyleAccumulator) {
  let cursor: Point | null = null;
  let incoming: number | null = null;
  for (const segment of segs) {
    const list = (segment.p || []).map(([x, y]) => [x * scale, y * scale] as Point);
    const end = list[list.length - 1];
    if (!end || segment.c === "Z") { cursor = null; incoming = null; continue; }
    const next: Point = segment.c === "H" && cursor ? [end[0], cursor[1]]
      : segment.c === "V" && cursor ? [cursor[0], end[1]]
      : end;
    if (segment.c === "M" || !cursor) { cursor = next; incoming = null; continue; }

    if (segment.c === "Q" && list[0]) {
      const control = list[0];
      const radius = (dist(cursor, control) + dist(control, next)) / 2;
      const turn = angleDelta(angleDeg(cursor, control), angleDeg(control, next));
      if (Math.abs(turn) > 40 && radius < 8) {
        acc.corners += 1;
        acc.rounded += 1;
        acc.corner.push(radius);
      }
      incoming = angleDeg(control, next);
    } else {
      const outgoing = angleDeg(cursor, next);
      if (incoming !== null && Math.abs(angleDelta(incoming, outgoing)) > 40) acc.corners += 1;
      incoming = outgoing;
    }
    cursor = next;
  }
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function blend(learned: number, base: number, samples: number, half: number) {
  const weight = samples / (samples + half);
  return learned * weight + base * (1 - weight);
}

/**
 * 从现有字库学写法：横竖偏几度、折角圆多大、多少折角是圆的。
 * 样本不够就往 BASE_STYLE 靠，新建的空字库也不会写出怪东西。
 */
export function learnStrokeStyle(
  items: Record<string, { segs?: Segment[] }[]> | undefined | null,
  vb: number,
): StrokeStyle {
  const scale = NORM_VB / (vb || NORM_VB);
  const acc: StyleAccumulator = { heng: [], shu: [], corner: [], corners: 0, rounded: 0 };
  for (const elements of Object.values(items || {})) {
    for (const element of elements || []) {
      if (!element?.segs?.length) continue;
      accumulateCorners(element.segs, scale, acc);
      accumulateTilt(flattenSegments(element.segs).map(([x, y]) => [x * scale, y * scale] as Point), acc);
    }
  }
  return {
    hengTilt: blend(median(acc.heng), BASE_STYLE.hengTilt, acc.heng.length, 12),
    shuTilt: blend(median(acc.shu), BASE_STYLE.shuTilt, acc.shu.length, 12),
    cornerRadius: blend(median(acc.corner), BASE_STYLE.cornerRadius, acc.corner.length, 6),
    roundedRatio: acc.corners ? blend(acc.rounded / acc.corners, BASE_STYLE.roundedRatio, acc.corners, 8) : BASE_STYLE.roundedRatio,
  };
}

/* ────────────────────────── 骨架输出 ────────────────────────── */

const AXIS_SNAP = 9;        // 纯几何吸附：接近水平/垂直就拉正
const AXIS_SNAP_NAMED = 17; // 已经认出是横/竖，可以放宽
/* 拙趣字的横「基本平」：两端高差 0.5–1.5，往上往下都有；竖可以略斜。
   所以不再拉成完全水平 / 垂直 —— 手描出来的那点斜留着，只把斜过头的压回这个角度。 */
const TILT_HENG = 2.5;      // 横最多斜这么多（度）
const TILT_SHU = 2.0;       // 竖最多偏这么多（度）

function axisTargetFor(spec: PartSpec | null, dir: number): number | null {
  const named = spec ? Math.min(
    Math.abs(angleDelta(spec.dir, 0)),
    Math.abs(angleDelta(spec.dir, 180)),
    Math.abs(angleDelta(spec.dir, 90)),
    Math.abs(angleDelta(spec.dir, -90)),
  ) < 7 : false;
  const tol = named ? AXIS_SNAP_NAMED : AXIS_SNAP;
  const candidates: [number, number][] = [[0, TILT_HENG], [180, TILT_HENG], [90, TILT_SHU], [-90, TILT_SHU]];
  for (const [axis, limit] of candidates) {
    const off = angleDelta(axis, dir);
    if (Math.abs(off) <= tol) {
      // 几乎正的就写正（出 H / V）；斜了就保留手描的斜度，但不超过 limit。
      return Math.abs(off) < 0.4 ? axis : axis + Math.max(-limit, Math.min(limit, off));
    }
  }
  return null;
}

function lineIntersection(o1: Point, u1: Point, o2: Point, u2: Point): Point | null {
  const denominator = u1[0] * u2[1] - u1[1] * u2[0];
  if (Math.abs(denominator) < 1e-6) return null;
  const t = ((o2[0] - o1[0]) * u2[1] - (o2[1] - o1[1]) * u2[0]) / denominator;
  return [o1[0] + u1[0] * t, o1[1] + u1[1] * t];
}

/** 端点+切向已定，最小二乘解出三次贝塞尔的两个控制柄。 */
function fitCubic(points: Point[], p0: Point, p3: Point, t0: Point, t3: Point): [Point, Point] | null {
  const n = points.length;
  if (n < 3) return null;
  const u: number[] = [0];
  for (let i = 1; i < n; i += 1) u.push(u[i - 1] + dist(points[i - 1], points[i]));
  const total = u[n - 1];
  if (total < 1e-6) return null;
  for (let i = 0; i < n; i += 1) u[i] /= total;
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < n; i += 1) {
    const t = u[i];
    const m = 1 - t;
    const b0 = m * m * m;
    const b1 = 3 * m * m * t;
    const b2 = 3 * m * t * t;
    const b3 = t * t * t;
    const a1: Point = [t0[0] * b1, t0[1] * b1];
    const a2: Point = [t3[0] * b2, t3[1] * b2];
    c00 += a1[0] * a1[0] + a1[1] * a1[1];
    c01 += a1[0] * a2[0] + a1[1] * a2[1];
    c11 += a2[0] * a2[0] + a2[1] * a2[1];
    const rx = points[i][0] - (b0 * p0[0] + b1 * p0[0] + b2 * p3[0] + b3 * p3[0]);
    const ry = points[i][1] - (b0 * p0[1] + b1 * p0[1] + b2 * p3[1] + b3 * p3[1]);
    x0 += a1[0] * rx + a1[1] * ry;
    x1 += a2[0] * rx + a2[1] * ry;
  }
  const denominator = c00 * c11 - c01 * c01;
  const chord = dist(p0, p3);
  let alpha = Math.abs(denominator) < 1e-9 ? chord / 3 : (x0 * c11 - x1 * c01) / denominator;
  let beta = Math.abs(denominator) < 1e-9 ? chord / 3 : (c00 * x1 - c01 * x0) / denominator;
  const limit = chord * 1.6;
  if (!Number.isFinite(alpha) || alpha < chord * 0.04) alpha = chord / 3;
  if (!Number.isFinite(beta) || beta < chord * 0.04) beta = chord / 3;
  alpha = Math.min(alpha, limit);
  beta = Math.min(beta, limit);
  return [
    [p0[0] + t0[0] * alpha, p0[1] + t0[1] * alpha],
    [p3[0] + t3[0] * beta, p3[1] + t3[1] * beta],
  ];
}

/**
 * 端点切向。`atStart` 取起点向前的方向，否则取终点**向回**的方向
 * ——正好是三次贝塞尔两个控制柄要伸出去的方向。
 */
function tangentAt(points: Point[], atStart: boolean): Point {
  const count = Math.max(2, Math.min(points.length, Math.round(points.length * 0.28)));
  const a = atStart ? points[0] : points[points.length - 1];
  const b = atStart ? points[count - 1] : points[points.length - count];
  const length = dist(a, b) || 1;
  return [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
}

function negate(unit: Point): Point {
  return [-unit[0], -unit[1]];
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}

function roundPoint(point: Point): Point {
  return [round(point[0]), round(point[1])];
}

function samePoint(a: Point, b: Point) {
  return Math.abs(a[0] - b[0]) < 0.05 && Math.abs(a[1] - b[1]) < 0.05;
}

/** 直线段落笔：正好水平/垂直就写 H/V，和字库里现有的写法保持一致。 */
function lineTo(from: Point, to: Point): Segment {
  if (Math.abs(from[1] - to[1]) < 0.05 && Math.abs(from[0] - to[0]) > 0.05) return { c: "H", p: [[to[0], from[1]]] };
  if (Math.abs(from[0] - to[0]) < 0.05 && Math.abs(from[1] - to[1]) > 0.05) return { c: "V", p: [[from[0], to[1]]] };
  return { c: "L", p: [to] };
}

type Piece = {
  kind: "line" | "curve";
  points: Point[];
  /** 直段的拟合直线：过 origin、方向 unit。 */
  origin: Point;
  unit: Point;
  a: Point;
  b: Point;
  length: number;
};

/** 段起点向前 / 段终点向回 的方向，接缝处要靠它对齐。 */
function pieceTangent(piece: Piece, atStart: boolean): Point {
  if (piece.kind === "line") return atStart ? piece.unit : negate(piece.unit);
  return tangentAt(piece.points, atStart);
}

function buildPieces(parts: Part[], match: Match | null, style: StrokeStyle, total: number): Piece[] {
  return parts.map((part, index) => {
    const spec = match?.template.parts[index] ?? null;
    // 认出来是横/竖/折这类本该写直的段，就容忍手抖，别把轻微的弓也拟合成曲线。
    const meantStraight = spec ? !spec.bow && part.deviation < Math.max(total * 0.018, part.length * 0.06) : false;
    if (!part.straight && !meantStraight) {
      return {
        kind: "curve",
        points: part.points,
        origin: part.origin,
        unit: part.unit,
        a: part.a,
        b: part.b,
        length: part.length,
      };
    }
    let unit = part.unit;
    const target = axisTargetFor(spec, angleDeg(part.a, part.b));
    if (target !== null) {
      const radians = target * Math.PI / 180;
      unit = [Math.cos(radians), Math.sin(radians)];
    }
    return {
      kind: "line",
      points: part.points,
      origin: part.origin,
      unit,
      a: projectOnLine(part.origin, unit, part.a),
      b: projectOnLine(part.origin, unit, part.b),
      length: part.length,
    };
  });
}

/**
 * 拼骨架。
 *
 * 「折」按字库学到的圆角半径收成一个小 Q；「弯」不套半径，直接拿轨迹上那段圆转
 * 去拟合三次贝塞尔——竖弯钩的鹅肚子是这么来的，不然又会退化成折角。
 */
function segmentsFromPieces(pieces: Piece[], joints: Joint[], sampled: Point[], style: StrokeStyle): Segment[] {
  const vertices: Point[] = [];
  for (let i = 0; i < joints.length; i += 1) {
    const left = pieces[i];
    const right = pieces[i + 1];
    let vertex: Point | null = null;
    if (left.kind === "line" && right.kind === "line") {
      const crossing = lineIntersection(left.origin, left.unit, right.origin, right.unit);
      const reach = Math.max(left.length, right.length);
      if (crossing && dist(crossing, joints[i].point) <= reach * 0.75 + 2) vertex = crossing;
    }
    if (!vertex) vertex = [(left.b[0] + right.a[0]) / 2, (left.b[1] + right.a[1]) / 2];
    vertices.push(vertex);

    if (joints[i].kind === "bend") {
      // 弯的进出口就取轨迹上圆转开始/结束的地方，落回各自的直线上。
      const enter = sampled[joints[i].from];
      const leave = sampled[joints[i].to];
      left.b = left.kind === "line" ? projectOnLine(left.origin, left.unit, enter) : enter;
      right.a = right.kind === "line" ? projectOnLine(right.origin, right.unit, leave) : leave;
    } else {
      left.b = vertex;
      right.a = vertex;
    }
  }

  const segs: Segment[] = [{ c: "M", p: [roundPoint(pieces[0].a)] }];
  let cursor = roundPoint(pieces[0].a);
  const step = (to: Point, segment: Segment) => {
    if (samePoint(cursor, to)) return;
    segs.push(segment);
    cursor = to;
  };

  for (let i = 0; i < pieces.length; i += 1) {
    const piece = pieces[i];
    const joint = joints[i];
    const next = pieces[i + 1];
    const corner = joint?.kind === "corner" && next;

    // 折角要圆的话，这一段提前收在圆角起点。
    let radius = 0;
    if (corner && style.roundedRatio > 0.3) {
      radius = Math.min(style.cornerRadius, piece.length * 0.42, next.length * 0.42);
      if (radius < 0.45) radius = 0;
    }
    const back = pieceTangent(piece, false);
    const end = radius
      ? [vertices[i][0] + back[0] * radius, vertices[i][1] + back[1] * radius] as Point
      : piece.b;
    const to = roundPoint(end);

    if (piece.kind === "line") {
      step(to, lineTo(cursor, to));
    } else {
      const controls = fitCubic(piece.points, cursor, to, pieceTangent(piece, true), back);
      step(to, controls
        ? { c: "C", p: [roundPoint(controls[0]), roundPoint(controls[1]), to] }
        : lineTo(cursor, to));
    }

    if (!joint || !next) continue;

    if (joint.kind === "bend") {
      const bend = sampled.slice(joint.from, joint.to + 1);
      const target = roundPoint(next.a);
      const controls = fitCubic(bend, cursor, target, negate(back), negate(pieceTangent(next, true)));
      step(target, controls
        ? { c: "C", p: [roundPoint(controls[0]), roundPoint(controls[1]), target] }
        : lineTo(cursor, target));
      continue;
    }

    if (!radius) {
      step(roundPoint(vertices[i]), lineTo(cursor, roundPoint(vertices[i])));
      continue;
    }
    const unit = pieceTangent(next, true);
    const target = roundPoint([vertices[i][0] + unit[0] * radius, vertices[i][1] + unit[1] * radius]);
    step(target, { c: "Q", p: [roundPoint(vertices[i]), target] });
    next.a = target;
  }
  return segs;
}

/* ────────────────────────── 拙趣写法 ────────────────────────── */

const HOOK_MAX = 5;           // 钩最长这么多（vb=64）。喜茶的钩只剩一个小勾
const STRAIGHTEN = 0.5;       // 撇捺的弧度收掉这么多（控制点往弦上收的比例）
const STRAIGHTEN_TEMPLATES = new Set(["撇", "捺", "平捺"]);

/** 每一段的实际起点和终点（H / V 按当前游标补全）。 */
function segmentEnds(segs: Segment[]): Array<[Point, Point]> {
  const out: Array<[Point, Point]> = [];
  let cursor: Point = [0, 0];
  for (const segment of segs) {
    const list = segment.p || [];
    const end = list[list.length - 1];
    if (!end) { out.push([cursor, cursor]); continue; }
    let next: Point = [end[0], end[1]];
    if (segment.c === "H") next = [end[0], cursor[1]];
    if (segment.c === "V") next = [cursor[0], end[1]];
    out.push([segment.c === "M" ? next : cursor, next]);
    cursor = next;
  }
  return out;
}

/** 把一段的终点挪到 to（from 是这一段的起点）。H / V 挪完还水平 / 垂直就保留，挪歪了才降成 L；Q / C 的控制点不动。 */
function moveSegmentEnd(segment: Segment, from: Point, to: Point) {
  if (segment.c === "H" && Math.abs(to[1] - from[1]) < 0.05) { segment.p = [[to[0], from[1]]]; return; }
  if (segment.c === "V" && Math.abs(to[0] - from[0]) < 0.05) { segment.p = [[from[0], to[1]]]; return; }
  if (segment.c === "H" || segment.c === "V") {
    segment.c = "L";
    segment.p = [to];
    return;
  }
  segment.p[segment.p.length - 1] = to;
}

/** 钩收短：最后一段是钩，长过 HOOK_MAX 就往自己的起点收。「卧钩」不收 —— 心的钩关系到认字。 */
function shortenHook(segs: Segment[], limit: number): boolean {
  if (segs.length < 3) return false;
  const [start, end] = segmentEnds(segs)[segs.length - 1];
  const length = dist(start, end);
  if (length <= limit) return false;
  const k = limit / length;
  const last = segs[segs.length - 1];
  if (last.c === "H" || last.c === "V" || last.c === "L") {
    moveSegmentEnd(last, start, roundPoint(lerpPoint(start, end, k)));
  } else {
    last.p = last.p.map((point) => roundPoint(lerpPoint(start, point, k)));
  }
  return true;
}

/** 撇捺拉直：C 段的两个控制点往弦上收，弓得没那么厉害。 */
function straightenCurves(segs: Segment[], amount: number): boolean {
  const ends = segmentEnds(segs);
  let changed = false;
  segs.forEach((segment, index) => {
    if (segment.c !== "C" || segment.p.length < 3) return;
    const [a, b] = ends[index];
    const length = dist(a, b);
    if (length < 1e-6) return;
    const unit: Point = [(b[0] - a[0]) / length, (b[1] - a[1]) / length];
    for (let i = 0; i < 2; i += 1) {
      const onChord = projectOnLine(a, unit, segment.p[i]);
      segment.p[i] = roundPoint(lerpPoint(segment.p[i], onChord, amount));
    }
    changed = true;
  });
  return changed;
}

/* ────────────────────────── 端点吸附 ────────────────────────── */

// 64 网格上的距离，其它网格按 vb/64 等比。
const SNAP_JOIN = 2.5;        // 端点离别的笔不到它：落到那一笔的中心线上，接准
const SNAP_TRIM = 3;          // 端点穿过别的笔不到它：截在交点上，不出头
const SNAP_FLOAT = 4;         // 离别的笔 SNAP_JOIN–它之间：看着像挨着又像没挨着，推开
const FLOAT_TARGET = 4.5;     // 推开到这么远（中心线；线宽两头吃掉 2.8，剩下的才是白）
const DOT_MAX = 8;            // 整笔短于它按「点」处理：整笔平移浮开，不挨着

export type SnapResult = {
  segs: Segment[];
  /** 接上 / 截掉出头 / 推开浮起的端点数。 */
  joined: number;
  trimmed: number;
  floated: number;
};

function nearestOn(point: Point, lines: Point[][]): { d: number; q: Point } {
  let best = { d: Infinity, q: point as Point };
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const a = line[i - 1];
      const b = line[i];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / l2)) : 0;
      const q: Point = [a[0] + dx * t, a[1] + dy * t];
      const d = dist(point, q);
      if (d < best.d) best = { d, q };
    }
  }
  return best;
}

/** 线段 a→b 跟别的笔的交点里，离 b 最近的那个（沿 a→b 的比例 t 最大）。 */
function lastCrossing(a: Point, b: Point, lines: Point[][]): Point | null {
  let best: { t: number; x: Point } | null = null;
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  for (const line of lines) {
    for (let i = 1; i < line.length; i += 1) {
      const c = line[i - 1];
      const sx = line[i][0] - c[0];
      const sy = line[i][1] - c[1];
      const denominator = rx * sy - ry * sx;
      if (Math.abs(denominator) < 1e-9) continue;
      const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denominator;
      const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denominator;
      if (t <= 0 || t >= 1 || u < 0 || u > 1) continue;
      if (!best || t > best.t) best = { t, x: [a[0] + rx * t, a[1] + ry * t] };
    }
  }
  return best ? best.x : null;
}

/**
 * 端点吸附：新描的一笔跟字里已有的笔怎么接。
 *
 * 拙趣字的规矩是「主干交接接准、一处不出头；点和小部件浮开 4–6」。手描出来的端点
 * 总是差一点：多出一截小尾巴、差一两个单位没碰上、或者离得不远不近看不出是接还是
 * 不接。这里替手表个态：
 *   - 穿过别的笔不到 SNAP_TRIM → 截在交点上
 *   - 离别的笔不到 SNAP_JOIN   → 落到那一笔的中心线上
 *   - 离别的笔在 SNAP_JOIN–SNAP_FLOAT 之间 → 沿自己往回收，推到 FLOAT_TARGET
 *   - 整笔很短（点）→ 不接，只浮：整笔平移到离别的笔 FLOAT_TARGET
 *
 * @param segs   新的一笔（画布坐标）
 * @param others 这个字里已有的笔
 * @param dot    识别成点 / 左点：只浮开，不接
 */
export function snapEnds(segs: Segment[], others: Segment[][], vb: number, dot = false): SnapResult | null {
  const k = (vb || NORM_VB) / NORM_VB;
  const lines = others.map((other) => flattenSegments(other)).filter((line) => line.length >= 2);
  if (!lines.length || segs.length < 2) return null;
  const out: Segment[] = segs.map((segment) => ({ ...segment, p: segment.p.map(([x, y]) => [x, y] as Point) }));
  const result: SnapResult = { segs: out, joined: 0, trimmed: 0, floated: 0 };

  const own = flattenSegments(out);
  if (own.length < 2) return null;

  if (dot || polylineLength(own) < DOT_MAX * k) {
    // 点：整笔平移，离别的笔推到 FLOAT_TARGET。
    let gap = Infinity;
    let from: Point = own[0];
    let to: Point = own[0];
    for (const point of own) {
      const near = nearestOn(point, lines);
      if (near.d < gap) { gap = near.d; from = near.q; to = point; }
    }
    if (gap >= SNAP_FLOAT * k || gap < 1e-6) return null;
    const push = FLOAT_TARGET * k - gap;
    const ux = (to[0] - from[0]) / gap;
    const uy = (to[1] - from[1]) / gap;
    // 整笔平移：H / V 存的坐标跟游标一起平移，照样成立。
    for (const segment of out) {
      segment.p = segment.p.map(([x, y]) => roundPoint([x + ux * push, y + uy * push]));
    }
    result.floated = 1;
    return result;
  }

  for (const which of ["start", "end"] as const) {
    const pts = flattenSegments(out);
    const tip = which === "start" ? pts[0] : pts[pts.length - 1];
    const inner = which === "start" ? pts[1] : pts[pts.length - 2];
    const write = (point: Point) => {
      const rounded = roundPoint(point);
      if (which === "start") {
        const [oldStart] = segmentEnds(out)[0];
        out[0].p = [rounded];
        // 起点挪了，紧跟的 H / V 只在真的不再水平 / 垂直时才按原终点降成 L。
        const next = out[1];
        const broken = next && ((next.c === "H" && Math.abs(rounded[1] - oldStart[1]) >= 0.05)
          || (next.c === "V" && Math.abs(rounded[0] - oldStart[0]) >= 0.05));
        if (broken) {
          const [, end] = segmentEnds(segs)[1];
          next.c = "L";
          next.p = [end];
        }
      } else {
        const [from] = segmentEnds(out)[out.length - 1];
        moveSegmentEnd(out[out.length - 1], from, rounded);
      }
    };

    const crossing = lastCrossing(inner, tip, lines);
    if (crossing && dist(crossing, tip) <= SNAP_TRIM * k && dist(crossing, tip) > 0.3 * k) {
      write(crossing);
      result.trimmed += 1;
      continue;
    }
    const near = nearestOn(tip, lines);
    if (near.d < 0.05 * k) continue;
    if (near.d < SNAP_JOIN * k) {
      write(near.q);
      result.joined += 1;
      continue;
    }
    if (near.d < SNAP_FLOAT * k) {
      // 沿自己往回收，直到离别的笔够远；最多收掉这一段的四成，免得整笔被吃掉。
      const length = dist(inner, tip);
      const unit: Point = length ? [(inner[0] - tip[0]) / length, (inner[1] - tip[1]) / length] : [0, 0];
      const budget = Math.min(length * 0.4, SNAP_FLOAT * 2 * k);
      let moved = 0;
      let point = tip;
      while (moved < budget && nearestOn(point, lines).d < FLOAT_TARGET * k) {
        moved += 0.2 * k;
        point = [tip[0] + unit[0] * moved, tip[1] + unit[1] * moved];
      }
      if (moved > 0) {
        write(point);
        result.floated += 1;
      }
    }
  }
  return result.joined || result.trimmed || result.floated ? result : null;
}

/* ────────────────────────── 对外接口 ────────────────────────── */

export type Recognition = {
  /** 面板上显示的名字，例如「竖弯钩」。 */
  type: string;
  /** 命中的基本笔画名；没把握时为 null。 */
  stroke: string | null;
  segs: Segment[];
  /** 按拙趣写法改过的地方（钩收短 / 撇捺拉直），给状态栏说一声。 */
  notes: string[];
};

const MATCH_LIMIT = 1.1;  // 打分超过它就不硬套笔画名，退回「折线 · N 段」

/**
 * 描摹轨迹 → 笔画骨架。
 *
 * @param raw   画布坐标下的采样点
 * @param vb    字面尺寸
 * @param style learnStrokeStyle 的产物，决定横竖的倾角和折角圆多少
 */
export function recognizeStroke(raw: Point[], vb: number, style: StrokeStyle = BASE_STYLE): Recognition | null {
  const scale = NORM_VB / (vb || NORM_VB);
  const points = dedupe(raw.map(([x, y]) => [x * scale, y * scale] as Point), 0.25);
  if (points.length < 2) return null;
  const total = polylineLength(points);
  if (total < 1.4) return null;

  const sampled = denoise(resample(points, SAMPLES), total);
  const { parts, joints } = decompose(sampled);
  if (!parts.length) return null;

  const match = matchTemplate(parts, joints, total);
  const hit = match && match.cost <= MATCH_LIMIT ? match : null;
  // 认出笔画之后，折还是弯就照笔画本来的写法落笔——竖弯钩的鹅肚不该因为
  // 用户手抖画得方了一点就变成折角。没认出来的才用量出来的 roundness。
  const resolved = joints.map((joint, index) => {
    const want = hit?.template.joins[index];
    return want && want !== "any" ? { ...joint, kind: want } : joint;
  });
  const pieces = buildPieces(parts, hit, style, total);
  const segs = segmentsFromPieces(pieces, resolved, sampled, style);
  if (segs.length < 2) return null;

  // 拙趣写法：钩短（卧钩除外，心的钩关系到认字）、撇捺直一点。
  const notes: string[] = [];
  if (hit && hit.template.name.includes("钩") && hit.template.name !== "卧钩" && shortenHook(segs, HOOK_MAX)) {
    notes.push("钩已收短");
  }
  if (hit && STRAIGHTEN_TEMPLATES.has(hit.template.name) && straightenCurves(segs, STRAIGHTEN)) {
    notes.push("已拉直");
  }

  const back = 1 / scale;
  const scaled = segs.map((segment) => ({
    ...segment,
    p: segment.p.map(([x, y]) => [round(x * back), round(y * back)] as Point),
  }));

  const bends = resolved.filter((joint) => joint.kind === "bend").length;
  const fallback = parts.length === 1
    ? (parts[0].straight ? "直线" : "曲线")
    : `${bends ? "弯折" : "折线"} · ${parts.length} 段`;

  return { type: hit ? hit.template.name : fallback, stroke: hit ? hit.template.name : null, segs: scaled, notes };
}
