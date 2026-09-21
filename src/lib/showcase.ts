/* 展示：把整段行预览那张 SVG 按笔顺写一遍，以及把这一遍导出成视频 / GIF。
 *
 * 三件事共用同一份「排程」（哪一笔、什么时候起、写多久）：屏幕上的 SVG 动画、
 * 录视频、编 GIF。所以导出的和你刚看的是同一遍，不是「差不多的一遍」——
 * 跟 render_row 抄 write_lines 是同一个道理，一份真相，不要两份实现。
 *
 * 屏幕上动的是 SVG 里那些 path 的 dashoffset；导出走 canvas（Path2D + setLineDash），
 * 因为一帧一帧把 SVG 转成位图太慢，而且线宽、圆头、摆正矩阵在 canvas 上是一一对应的。
 */
import { GifWriter, inkPalette, toInkPaletteIndices, type Rgb } from "./gif";
import { muxMp4, type Mp4Sample } from "./mp4";

export const SHOWCASE_SPEEDS: Array<[string, number]> = [["慢", 0.6], ["常速", 1], ["快", 1.7]];

export const MS_PER_UNIT = 4.2;     // 每个网格单位多少毫秒 —— 长横比点慢，就是靠这个
export const MIN_MS = 80;           // 点、短撇再快也要看得见
export const MAX_MS = 520;          // 长捺再慢也别拖成慢镜头
const FILL_MS = 140;                // 实心块没有弧长，淡入
export const STROKE_GAP = 55;       // 一个字之内，笔与笔之间
export const GLYPH_GAP = 240;       // 字与字之间：抬笔挪位置的那一拍。没有这一拍，
                                    // 一段话看着像一口气连笔写下来的
export const SHOWCASE_TAIL_MS = 900;   // 写完停一下 —— 导出的片子要有个收尾

/* 载入动画：铺纸 → 纸纹 → 界格落下 → 润墨 → 起笔。
   这两个数跟 editor.css 里 .showcase 那一组 keyframes 的时间轴对齐，改一处要改两处。 */
export const SHOWCASE_INTRO_MS = 3200;
export const SHOWCASE_REPLAY_MS = 520;    // 再写一遍只留一口气，不重来一遍仪式

export type ShowcaseStroke = {
  el: SVGPathElement;        // 屏幕上那条线（动画直接改它的 dashoffset）
  matrix: DOMMatrix;         // 这个字的摆正矩阵，导出到 canvas 时用
  d: string;
  width: number;             // 这一笔的线宽（提按的 w 已经乘进去了）
  ink: Rgb;                  // 所属字形的颜色
  opacity: number;            // 所属字形的不透明度
  len: number;
  filled: boolean;
  start: number;
  dur: number;
};

/** 一个字在纸上占的那一格 —— 载入动画里那几条界栏就落在这儿。都是 0–1 的比例。 */
export type ShowcaseCell = { cx: number; top: number; bottom: number };

export type ShowcasePlan = {
  strokes: ShowcaseStroke[];
  duration: number;
  box: { x: number; y: number; w: number; h: number };
  ink: Rgb;
  opacity: number;
  cells: ShowcaseCell[];
  origin: { x: number; y: number };   // 第一笔的起笔点，墨点落在这里
};

/** 起笔加速、收笔减速 —— 匀速拉出来的线像机器在扫，不像写。 */
export function easeInOutQuad(t: number) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function readInk(el: Element): Rgb {
  const parsed = getComputedStyle(el).color.match(/-?\d+(\.\d+)?/g);
  if (!parsed || parsed.length < 3) return [27, 27, 25];
  return [Number(parsed[0]), Number(parsed[1]), Number(parsed[2])];
}

function readOpacity(el: Element) {
  const value = Number(getComputedStyle(el).opacity);
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

/** 从行预览那张 SVG 里读出排程。字的顺序就是 DOM 顺序，笔顺就是 path 的顺序。 */
export function buildShowcase(svgEl: SVGSVGElement, speed: number): ShowcasePlan {
  const view = svgEl.viewBox.baseVal;
  const rootWidth = Number(svgEl.getAttribute("stroke-width")) || 3;
  const strokes: ShowcaseStroke[] = [];
  let cursor = 0;

  const box = { x: view.x, y: view.y, w: view.width, h: view.height };
  const nx = (x: number) => (x - box.x) / box.w;
  const ny = (y: number) => (y - box.y) / box.h;
  const cells: ShowcaseCell[] = [];

  const glyphs = Array.from(svgEl.children).filter((node) => node.tagName === "g") as SVGGElement[];
  glyphs.forEach((glyph, index) => {
    if (index) cursor += GLYPH_GAP / speed;
    // consolidate() 给的是 SVGMatrix：只有 a–f 六个数，没有 transformPoint /
    // multiply。必须转成真的 DOMMatrix，否则下面算界栏、导出画帧全炸。
    const raw = glyph.transform.baseVal.consolidate()?.matrix;
    const matrix = raw ? new DOMMatrix([raw.a, raw.b, raw.c, raw.d, raw.e, raw.f]) : new DOMMatrix();
    const ink = readInk(glyph);
    const opacity = readOpacity(glyph);
    for (const el of Array.from(glyph.querySelectorAll("path"))) {
      const filled = el.getAttribute("fill") === "currentColor";
      const len = filled ? 0 : el.getTotalLength();
      const dur = (filled ? FILL_MS : Math.min(MAX_MS, Math.max(MIN_MS, len * MS_PER_UNIT))) / speed;
      strokes.push({
        el,
        matrix,
        d: el.getAttribute("d") || "",
        width: Number(el.getAttribute("stroke-width")) || rootWidth,
        ink,
        opacity,
        len,
        filled,
        start: cursor,
        dur,
      });
      cursor += dur + STROKE_GAP / speed;
    }
    // 这个字的字面框（摆正之后的），界栏按它站位
    const bounds = glyph.getBBox();
    const top = matrix.transformPoint(new DOMPoint(bounds.x + bounds.width / 2, bounds.y));
    const bottom = matrix.transformPoint(new DOMPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height));
    cells.push({ cx: nx(top.x), top: ny(top.y), bottom: ny(bottom.y) });
  });

  const first = strokes[0];
  const head = first ? first.el.getPointAtLength(0) : new DOMPoint(box.x, box.y);
  const origin = first ? first.matrix.transformPoint(new DOMPoint(head.x, head.y)) : head;

  return {
    strokes,
    duration: Math.max(0, cursor - STROKE_GAP / speed),
    box,
    ink: readInk(svgEl),
    opacity: readOpacity(svgEl),
    cells,
    origin: { x: nx(origin.x), y: ny(origin.y) },
  };
}

/** 界栏落在**字与字之间**，不是字心上 —— 穿过字的那条线会被字压掉，读不出格。
    n 个字给 n+1 条线，边上两条按相邻间距外推。 */
export function showcaseRules(cells: ShowcaseCell[]) {
  if (!cells.length) return [];
  const gap = cells.length > 1
    ? (cells[cells.length - 1].cx - cells[0].cx) / (cells.length - 1)
    : 0.5;
  const top = Math.min(...cells.map((cell) => cell.top));
  const bottom = Math.max(...cells.map((cell) => cell.bottom));
  const out: Array<{ x: number; top: number; height: number }> = [];
  for (let i = 0; i <= cells.length; i++) {
    const x = i === cells.length
      ? cells[i - 1].cx + gap / 2
      : cells[i].cx - gap / 2;
    out.push({ x, top, height: bottom - top });
  }
  return out;
}

/** 退化成一个点的笔画（弧长≈0）没法用虚线遮 —— dasharray 写 0 等于没写，
    那一笔会从第一帧就露在纸上。这种改用透明度淡入，填充图元也是。 */
export function strokeFades(stroke: ShowcaseStroke) {
  return stroke.filled || stroke.len < 0.05;
}

/** 一笔在 t 时刻写到了几成。 */
export function strokeProgress(stroke: ShowcaseStroke, t: number) {
  if (t <= stroke.start) return 0;
  if (t >= stroke.start + stroke.dur) return 1;
  return easeInOutQuad((t - stroke.start) / stroke.dur);
}

/** 把 t 时刻的画面画到 canvas 上 —— 导出的每一帧都走这里。 */
export function paintFrame(ctx: CanvasRenderingContext2D, plan: ShowcasePlan, t: number, scale: number) {
  const { box, strokes } = plan;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const base = new DOMMatrix().scale(scale).translate(-box.x, -box.y);
  for (const stroke of strokes) {
    const p = strokeProgress(stroke, t);
    if (p <= 0) continue;
    const m = base.multiply(stroke.matrix);
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
    const color = `rgb(${stroke.ink[0]}, ${stroke.ink[1]}, ${stroke.ink[2]})`;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    const path = new Path2D(stroke.d);
    if (strokeFades(stroke)) {
      ctx.globalAlpha = stroke.opacity * p;
      if (stroke.filled) {
        ctx.fill(path);
      } else {
        ctx.lineWidth = stroke.width;
        ctx.setLineDash([]);
        ctx.stroke(path);
      }
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = stroke.opacity;
      ctx.lineWidth = stroke.width;
      if (p < 1) {
        ctx.setLineDash([stroke.len, stroke.len]);
        ctx.lineDashOffset = stroke.len * (1 - p);
      } else {
        ctx.setLineDash([]);
      }
      ctx.stroke(path);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

/** 导出画布该多大：按长边定，再取偶数 —— 有的编码器不吃奇数宽高。 */
export function showcaseCanvasSize(plan: ShowcasePlan, longSide: number) {
  const scale = longSide / Math.max(plan.box.w, plan.box.h);
  const even = (value: number) => Math.max(2, Math.round(value / 2) * 2);
  return { width: even(plan.box.w * scale), height: even(plan.box.h * scale), scale };
}

/* mp4 排在前面：要的就是 mp4。首选 WebCodecs 自己编，其次让新版 Chrome / Safari 的
   MediaRecorder 直接录 mp4。两条路的落地文件都是 .mp4，不会悄悄给你一个 .webm。 */
const MP4_MIMES = ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4;codecs=h264", "video/mp4"];
const WEBM_MIMES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

export function pickVideoMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return [...MP4_MIMES, ...WEBM_MIMES].find((mime) => MediaRecorder.isTypeSupported(mime)) ?? null;
}

export type ShowcasePhase = "render" | "record" | "convert";
type Progress = { onProgress?: (value: number) => void; onPhase?: (phase: ShowcasePhase) => void };

/* ── 导出 mp4 ────────────────────────────────────────────────────────────
   首选 WebCodecs：帧是我们自己渲的，时间戳也是自己写的，编码器爱跑多快跑多快
   —— 一段 12 秒的动画不必等 12 秒。封装走自己写的 mp4.ts。

   没有 VideoEncoder 的浏览器才退回 MediaRecorder：它按**墙上时钟**给帧打时间戳，
   录的是「一段正在发生的事」，所以必须实时播一遍，喂快了只会快进或丢帧。 */
const VIDEO_CODECS = ["avc1.640028", "avc1.4d0028", "avc1.42e01e"];

async function pickEncoderConfig(width: number, height: number, framerate: number) {
  for (const codec of VIDEO_CODECS) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      framerate,
      bitrate: 12_000_000,
      avc: { format: "avc" },
      latencyMode: "quality",
    };
    try {
      if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
    } catch {
      // 这一档不认就试下一档
    }
  }
  return null;
}

function asBytes(source: AllowSharedBufferSource): Uint8Array {
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(0));
  const view = source as ArrayBufferView;
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

/** 直接渲染 + 编码 —— 不录制，所以耗时只跟机器有关，跟句子多长无关。 */
async function renderShowcaseMp4(
  plan: ShowcasePlan,
  canvas: HTMLCanvasElement,
  scale: number,
  fps: number,
  onProgress?: (value: number) => void,
): Promise<Blob> {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("拿不到画布");
  const config = await pickEncoderConfig(canvas.width, canvas.height, fps);
  if (!config) throw new Error("这个浏览器编不了 H.264");

  const samples: Mp4Sample[] = [];
  const frameUs = Math.round(1_000_000 / fps);
  let description: Uint8Array | null = null;
  let failure: Error | null = null;

  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const raw = meta?.decoderConfig?.description;
      if (raw && !description) description = asBytes(raw);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      samples.push({
        data,
        timestamp: chunk.timestamp,
        duration: chunk.duration ?? frameUs,
        key: chunk.type === "key",
      });
    },
    error: (error) => { failure = error instanceof Error ? error : new Error(String(error)); },
  });
  encoder.configure(config);

  const step = 1000 / fps;
  const frames = Math.max(1, Math.ceil((plan.duration + SHOWCASE_TAIL_MS) / step));
  for (let i = 0; i < frames; i++) {
    if (failure) throw failure;
    paintFrame(ctx, plan, Math.min(i * step, plan.duration), scale);
    const frame = new VideoFrame(canvas, { timestamp: i * frameUs, duration: frameUs });
    encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
    frame.close();
    if (encoder.encodeQueueSize > 6) {
      // 队列堆太深会吃满内存，让编码器追一下，顺便把主线程还给页面
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (i % 8 === 7) onProgress?.(i / frames);
  }

  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!description) throw new Error("编码器没给出 avcC");
  onProgress?.(1);
  return new Blob([muxMp4({ width: canvas.width, height: canvas.height, description, samples })],
                  { type: "video/mp4" });
}

/** 导出 mp4：能直接渲就直接渲，不能才退回实时录。 */
export async function exportShowcaseVideo(
  plan: ShowcasePlan,
  canvas: HTMLCanvasElement,
  scale: number,
  { fps = 30, onProgress, onPhase }: Progress & { fps?: number } = {},
): Promise<Blob> {
  if (typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined") {
    onPhase?.("render");
    return renderShowcaseMp4(plan, canvas, scale, fps, onProgress);
  }
  return recordShowcaseVideo(plan, canvas, scale, { fps, onProgress, onPhase });
}

/** 后路：MediaRecorder 按真实时间打时间戳，所以这一段必须实时播一遍。 */
export async function recordShowcaseVideo(
  plan: ShowcasePlan,
  canvas: HTMLCanvasElement,
  scale: number,
  { fps = 30, onProgress, onPhase }: Progress & { fps?: number } = {},
): Promise<Blob> {
  const mime = pickVideoMime();
  if (!mime) throw new Error("这个浏览器不支持录像，改用 GIF");
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("拿不到画布");

  onPhase?.("record");
  paintFrame(ctx, plan, 0, scale);
  const stream = canvas.captureStream(fps);
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });
  recorder.start();

  const total = plan.duration + SHOWCASE_TAIL_MS;
  await new Promise<void>((resolve) => {
    const started = performance.now();
    const tick = (now: number) => {
      const t = now - started;
      paintFrame(ctx, plan, Math.min(t, plan.duration), scale);
      onProgress?.(Math.min(1, t / total));
      if (t >= total) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  recorder.stop();
  await stopped;
  for (const track of stream.getTracks()) track.stop();

  const recorded = new Blob(chunks, { type: mime });
  if (mime.startsWith("video/mp4")) return recorded;

  // 只录得出 webm 的浏览器：以前这里会把它发给本机 ffmpeg 转封装，
  // 纯网页版没有那个后端了 —— 与其悄悄给一个改了扩展名的 webm，不如明说。
  throw new Error("这个浏览器录不出 mp4（也没有 WebCodecs）。换新版 Chrome / Safari，或者导出 GIF。");
}

/** 编 GIF：不用实时，一帧一帧算完就行，所以长句子也不必等一遍播完。 */
export async function renderShowcaseGif(
  plan: ShowcasePlan,
  canvas: HTMLCanvasElement,
  scale: number,
  { fps = 20, onProgress }: Progress & { fps?: number } = {},
): Promise<Blob> {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("拿不到画布");
  const { width, height } = canvas;
  const palette = inkPalette(plan.strokes.map((stroke) => stroke.ink));
  const gif = new GifWriter(width, height, palette.colors);
  const step = 1000 / fps;
  const frames = Math.max(1, Math.ceil((plan.duration + SHOWCASE_TAIL_MS) / step));

  for (let i = 0; i < frames; i++) {
    paintFrame(ctx, plan, Math.min(i * step, plan.duration), scale);
    gif.add(toInkPaletteIndices(ctx.getImageData(0, 0, width, height).data, palette), step);
    if (i % 4 === 3) {
      onProgress?.(i / frames);
      await new Promise((resolve) => setTimeout(resolve, 0));   // 让出主线程，别把页面卡死
    }
  }
  onProgress?.(1);
  const bytes = gif.finish();
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new Blob([buffer], { type: "image/gif" });
}
