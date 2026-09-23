/* 英文字库：规整骨架 → 拙趣版。Python 那份是 skills/hand-glyph/scripts/latin_zhuo.py，
   **逐行照抄**，npm run parity 逐字节比对。

   每个字母：x 高 ±30%、歪 2–4°、宽度随机放宽或收窄（圆头字母多收一些），曲线控制点各挪 ±1.2
   （端点不动，碗接竖照样接得准），再按字面量左边距 2.5 和 adv。量由字母本身决定，每次一样。
   字库表头同时写 drift 2、jit 1.3，并记 latinZhuo，防止同一套字被变拙两次。 */
import * as dpath from "./dpath";
import { pathToPolys } from "./flatten";
import { pyRound } from "./num";
import { rnd } from "./rng";
import type { GeoElement } from "./vary";

const BASE = 48.0;
const HEIGHT = 0.30;
const TILT: [number, number] = [2.0, 4.0];
const NARROW_ROUND: [number, number] = [0.00, 0.24];
const WIDTH_OTHER: [number, number] = [-0.20, 0.18];
const WOBBLE = 1.2;
const ROUND = new Set("oeacdgpqsbuOCGQ".split(""));
const SKIP = new Set(".,!?:;'\"-".split(""));

export const LATIN_ZHUO_DRIFT = 2.0;
export const LATIN_ZHUO_JIT = 1.3;

function pathXs(els: GeoElement[]): number[] {
  const xs: number[] = [];
  for (const e of els) {
    if ((e.t ?? "path") !== "path") continue;
    for (const [poly] of pathToPolys(String(e.d ?? ""))) for (const p of poly) xs.push(p[0]);
  }
  return xs;
}

/** 一个字母 -> 拙趣版（原地改 els，返回 els）。 */
export function zhuoLetter(ch: string, els: GeoElement[], amount = 1.0): GeoElement[] {
  if (SKIP.has(ch) || !els.length) return els;
  const first = Array.from(ch)[0] ?? "";
  const key = first.codePointAt(0) ?? 0;
  const sy = 1 + (rnd(key, 1) * 2 - 1) * HEIGHT * amount;
  const sx = ROUND.has(first)
    ? 1 - (NARROW_ROUND[0] + rnd(key, 2) * (NARROW_ROUND[1] - NARROW_ROUND[0])) * amount
    : 1 + (WIDTH_OTHER[0] + rnd(key, 2) * (WIDTH_OTHER[1] - WIDTH_OTHER[0])) * amount;
  const deg = (TILT[0] + rnd(key, 3) * (TILT[1] - TILT[0])) * amount * (rnd(key, 4) < 0.5 ? 1 : -1);

  let xs = pathXs(els);
  if (!xs.length) return els;
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const t = deg * (Math.PI / 180.0);                 // 跟 Python 的 math.radians 同一个算法
  const ct = Math.cos(t);
  const st = Math.sin(t);
  const move = (q: [number, number]): [number, number] => {
    const x = (q[0] - cx) * sx;
    const y = (q[1] - BASE) * sy;
    return [cx + x * ct - y * st, BASE + x * st + y * ct];
  };

  els.forEach((e, ei) => {
    if ((e.t ?? "path") !== "path") return;
    const segs = dpath.parse(String(e.d ?? ""));
    segs.forEach((s, gi) => {
      if (s.c === "C") {
        for (let k = 0; k < 2; k += 1) {               // 只挪控制点，端点不动
          s.p[k][0] += (rnd(key, ei, gi, k, 1) * 2 - 1) * WOBBLE * amount;
          s.p[k][1] += (rnd(key, ei, gi, k, 2) * 2 - 1) * WOBBLE * amount;
        }
      }
      s.p = s.p.map(move);
    });
    e.d = dpath.serialize(segs);
  });

  xs = pathXs(els);
  const shift = 2.5 - Math.min(...xs);
  for (const e of els) {
    if ((e.t ?? "path") !== "path") continue;
    const segs = dpath.parse(String(e.d ?? ""));
    dpath.translate(segs, shift, 0);
    e.d = dpath.serialize(segs);
  }
  els[0].adv = pyRound(Math.max(...xs) - Math.min(...xs) + 5, 1);
  return els;
}
