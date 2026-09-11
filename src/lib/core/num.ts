/* Python 的数值语义，逐条对齐。

   移植这套东西时真正会漂的不是几何，是**格式化和取整**：
     - Python 的 round() / f"{x:.2f}" 是「银行家舍入」（.5 进到偶数），
       JS 的 Math.round() 和 toFixed() 在 .5 上一律往上（往大）走。
     - "%g" 是 6 位有效数字并去掉尾零，JS 没有等价物。
   一个坐标差 0.1 就是一条不一样的线，所以这些函数是整套移植的地基。 */

/** 与 Python `round(x)` 一致：.5 舍到偶数。 */
export function pyRoundInt(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** 双精度的精确十进制展开（足够判定是不是「正好一半」）。 */
function exactDigits(abs: number, prec: number): string {
  // toFixed 在 0–100 位上是正确舍入的；多留 18 位，尾部就只可能是精确展开
  // 或者远在决策位之外的噪声。真正的「正好一半」在这个串里是 5 后面全 0。
  return abs.toFixed(Math.min(100, prec + 18));
}

/** 与 Python `f"{x:.{prec}f}"` 一致（正确舍入 + 银行家舍入）。 */
export function fmtFixed(value: number, prec: number): string {
  if (!Number.isFinite(value)) return String(value);
  const negative = value < 0 || Object.is(value, -0);
  const abs = Math.abs(value);
  const raw = exactDigits(abs, prec);
  const dot = raw.indexOf(".");
  const intPart = dot < 0 ? raw : raw.slice(0, dot);
  const fracPart = dot < 0 ? "" : raw.slice(dot + 1);
  const keep = fracPart.slice(0, prec).padEnd(prec, "0");
  const rest = fracPart.slice(prec);
  let digits = intPart + keep;                 // 当作一个大整数来进位

  const first = rest.charCodeAt(0) - 48;
  let roundUp = false;
  if (first > 5) roundUp = true;
  else if (first === 5) {
    if (/[1-9]/.test(rest.slice(1))) roundUp = true;               // 比一半多
    else roundUp = (digits.charCodeAt(digits.length - 1) - 48) % 2 === 1;  // 正好一半：进到偶数
  }
  if (roundUp) {
    const bumped = (BigInt(digits || "0") + 1n).toString();
    digits = bumped.padStart(digits.length, "0");
  }

  const intLen = digits.length - prec;
  const head = (intLen > 0 ? digits.slice(0, intLen) : "0").replace(/^0+(?=\d)/, "");
  const tail = prec > 0 ? digits.slice(Math.max(0, intLen)).padStart(prec, "0") : "";
  const body = prec > 0 ? `${head}.${tail}` : head;
  return negative ? `-${body}` : body;       // Python 会写出 "-0.00"，上层再统一收成 "0"
}

/** 与 Python `round(x, prec)` 一致（返回数值，供再次格式化）。 */
export function pyRound(value: number, prec = 0): number {
  return Number(fmtFixed(value, Math.max(0, prec)));
}

/** 与 Python `"%g" % x` 一致：6 位有效数字，去尾零。 */
export function pyG(value: number, precision = 6): string {
  if (!Number.isFinite(value)) return value > 0 ? "inf" : Number.isNaN(value) ? "nan" : "-inf";
  if (value === 0) return Object.is(value, -0) ? "-0" : "0";
  const rounded = Number(value.toPrecision(precision));
  const exponent = Math.floor(Math.log10(Math.abs(rounded)));
  if (exponent < -4 || exponent >= precision) {
    const [mantissa, exp] = rounded.toExponential(precision - 1).split("e");
    const trimmed = mantissa.includes(".")
      ? mantissa.replace(/0+$/, "").replace(/\.$/, "")
      : mantissa;
    const sign = exp.startsWith("-") ? "-" : "+";
    const magnitude = exp.replace(/^[-+]/, "").padStart(2, "0");
    return `${trimmed}e${sign}${magnitude}`;
  }
  const text = fmtFixed(value, Math.max(0, precision - 1 - exponent));
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/** Python 的 `%`：结果跟除数同号。 */
export function pmod(value: number, mod: number): number {
  const r = value % mod;
  return r !== 0 && r < 0 !== mod < 0 ? r + mod : r;
}

/* 正确舍入的 hypot —— 跟 CPython 的 math.hypot 对齐。

   V8 的 Math.hypot 只保证「差不多」，最后一位跟 Python 的不一样；
   这个差值本身看不见（1e-16），但它会跑进 vary.py 的挂接参数 t，
   再经过一次 2 位小数的取整就有可能翻到另一个坐标上去。
   骨架层一个点跳 0.01，这个字这一次就是另一份写法了。

   做法是 Borges 的补偿算法：先算 sqrt(x²+y²)，再用无误差乘法把
   残差算准，做一步牛顿修正。 */
const SPLIT = 134217729;   // 2^27 + 1

function twoProduct(a: number, b: number): [number, number] {
  const p = a * b;
  const ca = SPLIT * a;
  const ah = ca - (ca - a);
  const al = a - ah;
  const cb = SPLIT * b;
  const bh = cb - (cb - b);
  const bl = b - bh;
  return [p, ah * bh - p + ah * bl + al * bh + al * bl];
}

function twoSum(a: number, b: number): [number, number] {
  const s = a + b;
  const bb = s - a;
  return [s, a - (s - bb) + (b - bb)];
}

export function hypot(x: number, y: number): number {
  x = Math.abs(x);
  y = Math.abs(y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return Number.isNaN(x) || Number.isNaN(y) ? NaN : Infinity;
  if (x < y) { const t = x; x = y; y = t; }
  if (y === 0) return x;
  // 极端量级先整体缩放，免得 x*x 溢出或者下溢到非规格化数
  let scale = 1;
  if (x > 1e150) { scale = 2 ** 600; x /= scale; y /= scale; }
  else if (x < 1e-150) { scale = 2 ** -600; x /= scale; y /= scale; }
  const h = Math.sqrt(x * x + y * y);
  const [hx, lx] = twoProduct(x, x);
  const [hy, ly] = twoProduct(y, y);
  const [s, e] = twoSum(hx, hy);
  const [hh, lh] = twoProduct(h, h);
  const residual = s - hh + (e + (lx + ly) - lh);
  return (h + residual / (2 * h)) * scale;
}
