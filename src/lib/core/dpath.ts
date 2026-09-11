/* d 串 <-> 可编辑节点表。编辑器拖的是骨架点，存回去的还得是 d 串。

   命令字母本身带信息：横就该写 H、折角半径就该写 Q、真 90° 就该写 A。
   所以解析之后要能**原样**写回去，而不是一律摊平成 L —— 摊平了几何就没法读了，
   下一个人也看不出哪个折角是有半径的。

   只有被拖过的那条 path 才重新序列化，没动过的保持原字符串不变，diff 才干净。

   一律绝对坐标。S/T 在解析时展开成 C/Q —— 拖一个「反射出来的控制点」没法理解，
   而字库里本来也没用过这两个命令。 */
import { fmtFixed } from "./num";

export type Point = [number, number];
export type Segment = { c: string; p: Point[]; a?: number[] };

const TOKEN = /([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;

function tokenize(d: string): string[] {
  const out: string[] = [];
  TOKEN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(d)) !== null) out.push(match[1] || match[2]);
  return out;
}

export function parse(d: string): Segment[] {
  const toks = tokenize(d || "");
  let i = 0;
  let cur: Point = [0, 0];
  let start: Point = [0, 0];
  let cmd = "";
  let prevC2: Point | null = null;
  let prevQ: Point | null = null;
  const segs: Segment[] = [];
  const num = () => Number(toks[i++]);

  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i])) cmd = toks[i++];
    if (!cmd) break;
    const rel = cmd !== cmd.toUpperCase();
    const C = cmd.toUpperCase();
    const ox = rel ? cur[0] : 0;
    const oy = rel ? cur[1] : 0;
    if (C === "M") {
      cur = start = [num() + ox, num() + oy];
      segs.push({ c: "M", p: [[cur[0], cur[1]]] });
      cmd = rel ? "l" : "L";
      prevC2 = prevQ = null;
    } else if (C === "L") {
      cur = [num() + ox, num() + oy];
      segs.push({ c: "L", p: [[cur[0], cur[1]]] });
      prevC2 = prevQ = null;
    } else if (C === "H") {
      cur = [num() + ox, cur[1]];
      segs.push({ c: "H", p: [[cur[0], cur[1]]] });
      prevC2 = prevQ = null;
    } else if (C === "V") {
      cur = [cur[0], num() + oy];
      segs.push({ c: "V", p: [[cur[0], cur[1]]] });
      prevC2 = prevQ = null;
    } else if (C === "C" || C === "S") {
      const c1: Point = C === "C"
        ? [num() + ox, num() + oy]
        : prevC2 ? [2 * cur[0] - prevC2[0], 2 * cur[1] - prevC2[1]] : [cur[0], cur[1]];
      const c2: Point = [num() + ox, num() + oy];
      const e: Point = [num() + ox, num() + oy];
      segs.push({ c: "C", p: [c1, c2, [e[0], e[1]]] });
      prevC2 = c2; prevQ = null; cur = e;
    } else if (C === "Q" || C === "T") {
      const q: Point = C === "Q"
        ? [num() + ox, num() + oy]
        : prevQ ? [2 * cur[0] - prevQ[0], 2 * cur[1] - prevQ[1]] : [cur[0], cur[1]];
      const e: Point = [num() + ox, num() + oy];
      segs.push({ c: "Q", p: [q, [e[0], e[1]]] });
      prevQ = q; prevC2 = null; cur = e;
    } else if (C === "A") {
      const rx = num(), ry = num(), rot = num();
      const large = Math.trunc(num()), sweep = Math.trunc(num());
      const e: Point = [num() + ox, num() + oy];
      segs.push({ c: "A", p: [[e[0], e[1]]], a: [rx, ry, rot, large, sweep] });
      cur = e; prevC2 = prevQ = null;
    } else if (C === "Z") {
      segs.push({ c: "Z", p: [] });
      cur = [start[0], start[1]];
      prevC2 = prevQ = null;
    } else {
      break;
    }
  }
  return segs;
}

function n(value: number, prec = 2): string {
  const s = fmtFixed(value, prec).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" || s === "-0" ? "0" : s;
}

/** 节点表 -> d 串。H/V 拖成不再水平/垂直的时候自动降级成 L。 */
export function serialize(segs: Segment[], prec = 2): string {
  const out: string[] = [];
  let cur: Point | null = null;
  for (const s of segs) {
    let c = s.c;
    const p = s.p;
    if (c === "Z") { out.push("Z"); continue; }
    const e = p[p.length - 1];
    if (c === "H" && cur && Math.abs(e[1] - cur[1]) > 10 ** -prec) c = "L";
    if (c === "V" && cur && Math.abs(e[0] - cur[0]) > 10 ** -prec) c = "L";
    if (c === "M") out.push(`M${n(e[0], prec)} ${n(e[1], prec)}`);
    else if (c === "H") out.push(`H${n(e[0], prec)}`);
    else if (c === "V") out.push(`V${n(e[1], prec)}`);
    else if (c === "L") out.push(`L${n(e[0], prec)} ${n(e[1], prec)}`);
    else if (c === "Q") out.push(`Q${n(p[0][0], prec)} ${n(p[0][1], prec)} ${n(e[0], prec)} ${n(e[1], prec)}`);
    else if (c === "C") {
      out.push(`C${n(p[0][0], prec)} ${n(p[0][1], prec)} ${n(p[1][0], prec)} ${n(p[1][1], prec)} `
        + `${n(e[0], prec)} ${n(e[1], prec)}`);
    } else if (c === "A") {
      const [rx, ry, rot, lg, sw] = s.a as number[];
      out.push(`A${n(rx, prec)} ${n(ry, prec)} ${n(rot, prec)} ${Math.trunc(lg)} ${Math.trunc(sw)} `
        + `${n(e[0], prec)} ${n(e[1], prec)}`);
    }
    cur = e;
  }
  return out.join(" ");
}

/** 整条笔画平移。H/V/A 全都还成立 —— 平移不改变水平/垂直，也不改弧的半径。 */
export function translate(segs: Segment[], dx: number, dy: number): Segment[] {
  for (const s of segs) for (const pt of s.p) { pt[0] += dx; pt[1] += dy; }
  return segs;
}
