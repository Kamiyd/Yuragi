/* 确定性随机 —— row.py / vary.py 里那套 FNV + 雪崩混合，一位不差地搬过来。

   每轮 FNV 之后必须跟一次雪崩混合：只乘一遍的话，输入是一两个小整数时
   i 加一只把结果推动百分之零点几，一行字的大小会是一条缓坡。

   JS 这边全程用 Math.imul 和 `>>> 0`：普通的 `*` 在超过 2^53 之后就不是
   32 位乘法了，那样出来的种子跟 Python 对不上。 */

function u32(value: number): number {
  return Math.trunc(value) >>> 0;        // 等价于 Python 的 int(k) & 0xFFFFFFFF
}

export function rnd(...key: number[]): number {
  let h = 2166136261;
  for (const k of key) {
    h = Math.imul(h ^ u32(k), 16777619) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    h = Math.imul(h, 0x85ebca6b) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    h = Math.imul(h, 0xc2b2ae35) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
  }
  return h / 0xffffffff;
}

export function jit(amp: number, ...key: number[]): number {
  return (rnd(...key) * 2 - 1) * amp;
}
