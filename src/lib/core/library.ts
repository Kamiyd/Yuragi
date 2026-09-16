/* 字库的两种形态：几何 JSON（硬盘上的真相）<-> 编辑器表示（segs 节点表）。
   这一份是 edit.py 里 to_edit / to_geo / editor_config / save_geo 的移植。

   d0 是原始字符串：没被拖过的笔画保存时原样写回，一个字符都不动。
   （往返本来就是字节级一致的，这只是再上一道保险 —— 顺手也让 diff
   只出现在真正改过的那几笔上。） */
import * as dpath from "./dpath";
import type { Segment } from "./dpath";
import { PARAMS, TRACE_AMP, layoutMode, paramsOf, previewSeed, readMode, seedMap,
  type GlyphItems, type LayoutMode } from "./draw";
import type { GeoElement } from "./vary";
import { TRACK, WORD } from "./row";

export type EditableElement = GeoElement & { segs?: Segment[]; d0?: string };
export type EditableItems = Record<string, EditableElement[]>;

export type EditorConfig = {
  rowMode?: "library" | "custom";
  rowText?: string;
  /** 字形在编辑器与行预览中的显式顺序；不能依赖 items 对象键顺序。 */
  glyphOrder?: string[];
  ink?: Record<string, { color?: string; opacity?: number }>;
  export?: { scope?: "row" | "glyphs"; format?: "svg" | "png"; scale?: number };
  viewHeight?: number;
  varyEnabled?: boolean;
};

export type GlyphLibrary = {
  vb: number;
  sw: number;
  /** 版式：汉字一字一格 / 拉丁绕基线。没写的老文件按 adv 推断。 */
  mode?: LayoutMode;
  amp: number;
  over: number;
  jit: number;
  vary: number;
  track: number;
  word: number;
  seed: number | null;
  glyphSeeds: Record<string, number>;
  glyphSeedMemory: Record<string, number>;
  editor: EditorConfig;
  items: EditableItems;
};

/**
 * 返回稳定的字形顺序。
 *
 * JavaScript 会把纯数字对象键（例如 "1"、"8"）自动排到普通字符串键
 * 前面，所以 items 本身不能承担“用户添加顺序”这个语义。显式顺序里无效
 * 或重复的名字会被忽略，新增但还没写入顺序的名字则追加到末尾。
 */
export function orderedGlyphNames(items: Record<string, unknown>, configuredOrder?: Iterable<string>): string[] {
  const names = Object.keys(items);
  if (!configuredOrder) return names;

  const remaining = new Set(names);
  const ordered: string[] = [];
  for (const value of configuredOrder) {
    const name = String(value);
    if (remaining.delete(name)) ordered.push(name);
  }
  for (const name of names) {
    if (remaining.has(name)) ordered.push(name);
  }
  return ordered;
}

/** 一个元素 -> 编辑器用的形。path 摊成 segs，别的类型原样带着。 */
export function toEdit(el: GeoElement): EditableElement {
  const e: EditableElement = { ...el };
  // 兼容早期保留手迹：amp=0 原本只是为了跳过骨架/线条抖动，
  // 现在保留复杂轨迹但恢复确定性的种子手感。
  if (e.traceMode === "original" && Math.abs(Number(e.amp ?? 1)) < 1e-9) e.amp = TRACE_AMP;
  if ((e.t ?? "path") === "path") {
    e.segs = dpath.parse(String(e.d ?? ""));
    e.d0 = String(e.d ?? "");
    delete e.d;
  }
  return e;
}

/** 编辑器的形 -> 几何 JSON 的形。字段顺序跟字库现有的写法一致。 */
export function toGeo(el: EditableElement): GeoElement {
  if (!el.segs) {
    const out: GeoElement = {};
    for (const [k, v] of Object.entries(el)) if (k !== "d0") out[k] = v;
    return out;
  }
  let d = dpath.serialize(el.segs);
  if (el.d0 && dpath.serialize(dpath.parse(el.d0)) === d) d = el.d0;   // 没动过 -> 原样
  const out: GeoElement = { t: "path", d };
  for (const k of ["fill", "amp", "w", "adv", "traceMode"] as const) {
    const value = (el as Record<string, unknown>)[k];
    if (value !== undefined && value !== null && value !== "") out[k] = value as never;
  }
  return out;
}

/** 把几何文件统一成一套扁平字库。 */
export function normalizeGlyphs(geo: unknown): { items: GlyphItems } & Record<string, unknown> {
  if (!geo || typeof geo !== "object" || Array.isArray(geo)) throw new Error("几何 JSON 必须是对象");
  const source = geo as Record<string, unknown>;
  if (source.items && typeof source.items === "object" && !Array.isArray(source.items)) {
    return source as { items: GlyphItems } & Record<string, unknown>;
  }
  const candidates = Object.values(source).filter(
    (value) => value && typeof value === "object" && !Array.isArray(value)
      && (value as Record<string, unknown>).items
      && typeof (value as Record<string, unknown>).items === "object");
  if (candidates.length === 1) {
    // 兼容旧版只有一个顶层字库名的文件，API 不再暴露这层包装。
    return candidates[0] as { items: GlyphItems } & Record<string, unknown>;
  }
  if (candidates.length) throw new Error("这个文件包含多套字库；当前编辑器只支持一套字库，请先合并后再打开。");
  return { items: source as GlyphItems };
}

function hexColor(value: unknown): string | null {
  let text = String(value ?? "").trim();
  if (text.startsWith("#")) text = text.slice(1);
  if (text.length === 3 && /^[0-9a-fA-F]{3}$/.test(text)) {
    text = text.split("").map((c) => c + c).join("");
  }
  if (!/^[0-9a-fA-F]{6}$/.test(text)) return null;
  return `#${text.toUpperCase()}`;
}

/** 64.0 要写成 64 —— 不然一次空保存就把字库表头改一遍，diff 全是噪音。 */
export function num(value: unknown): number {
  const f = Number(value);
  return Number.isInteger(f) ? f : f;
}

/** 清洗编辑器侧的持久化设置。这些字段不参与几何计算。 */
export function editorConfig(value: unknown, names: Iterable<string>): EditorConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const source = value as Record<string, unknown>;
  const known = new Set(names);
  const out: EditorConfig = {};
  if (source.rowMode === "library" || source.rowMode === "custom") out.rowMode = source.rowMode;
  if ("rowText" in source) out.rowText = String(source.rowText ?? "").replace(/\//g, "").replace(/\n/g, "");
  if (Array.isArray(source.glyphOrder)) {
    const order: string[] = [];
    const seen = new Set<string>();
    for (const value of source.glyphOrder) {
      const name = String(value);
      if (known.has(name) && !seen.has(name)) {
        seen.add(name);
        order.push(name);
      }
    }
    if (order.length) out.glyphOrder = order;
  }

  if (source.ink && typeof source.ink === "object") {
    const cleanInk: Record<string, { color?: string; opacity?: number }> = {};
    for (const [name, style] of Object.entries(source.ink as Record<string, unknown>)) {
      if (!known.has(String(name)) || !style || typeof style !== "object") continue;
      const s = style as Record<string, unknown>;
      const color = hexColor(s.color);
      const rawOpacity = Number(s.opacity);
      const clean: { color?: string; opacity?: number } = {};
      if (color !== null) clean.color = color;
      if (Number.isFinite(rawOpacity)) clean.opacity = Math.max(0, Math.min(1, rawOpacity));
      if (Object.keys(clean).length) cleanInk[String(name)] = clean;
    }
    if (Object.keys(cleanInk).length) out.ink = cleanInk;
  }

  if (source.export && typeof source.export === "object") {
    const exp = source.export as Record<string, unknown>;
    const cleanExport: { scope?: "row" | "glyphs"; format?: "svg" | "png"; scale?: number } = {};
    if (exp.scope === "row" || exp.scope === "glyphs") cleanExport.scope = exp.scope;
    if (exp.format === "svg" || exp.format === "png") cleanExport.format = exp.format;
    const scale = Number(exp.scale);
    if (Number.isFinite(scale) && scale >= 0.5 && scale <= 4) cleanExport.scale = num(scale);
    if (Object.keys(cleanExport).length) out.export = cleanExport;
  }

  const height = Number(source.viewHeight);
  if (Number.isFinite(height) && height >= 20 && height <= 120) out.viewHeight = num(height);
  if (typeof source.varyEnabled === "boolean") out.varyEnabled = source.varyEnabled;
  return out;
}

/** 中文默认无额外字距；拉丁字库沿用拉丁默认字距。 */
export function defaultTrack(glyphs: { mode?: LayoutMode; items?: GlyphItems }): number {
  return layoutMode(glyphs) === "latin" ? TRACK : 0;
}

/** 几何 JSON（已解析）-> 编辑器要的 payload。 */
export function loadGeo(parsed: unknown, file: string): { file: string; glyphs: GlyphLibrary } {
  const glyphs = normalizeGlyphs(parsed);
  const items = glyphs.items as GlyphItems;
  const p = paramsOf(glyphs);
  const editableItems: EditableItems = {};
  for (const [n, els] of Object.entries(items)) editableItems[n] = els.map(toEdit);
  return {
    file,
    glyphs: {
      ...p,
      vb: Number(glyphs.vb ?? 24),
      sw: Number(glyphs.sw ?? 1.5),
      mode: readMode(glyphs.mode),
      track: Number(glyphs.track ?? defaultTrack(glyphs)),
      word: Number(glyphs.word ?? WORD),
      seed: previewSeed(glyphs.seed),
      glyphSeeds: seedMap(glyphs.glyphSeeds),
      glyphSeedMemory: seedMap(glyphs.glyphSeedMemory),
      editor: editorConfig(glyphs.editor, Object.keys(items)),
      items: editableItems,
    },
  };
}

/** 编辑器的字库 -> 要写回磁盘/本地存储的几何 JSON 对象。默认值不写进文件。 */
export function toGeoFile(glyphs: GlyphLibrary): Record<string, unknown> {
  const out: Record<string, unknown> = { vb: num(glyphs.vb), sw: num(glyphs.sw) };
  // 只有明确记过版式的库才写这一行：老文件不记，保存回去一个字节都不变。
  const mode = readMode(glyphs.mode);
  if (mode) out.mode = mode;
  for (const k of PARAMS) {
    const value = Number((glyphs as unknown as Record<string, unknown>)[k] ?? 1);
    if (Math.abs(value - 1) > 1e-9) out[k] = num(value);
  }
  const track = defaultTrack(glyphs);
  if (Math.abs(Number(glyphs.track ?? track) - track) > 1e-9) out.track = num(glyphs.track);
  if (Math.abs(Number(glyphs.word ?? WORD) - WORD) > 1e-9) out.word = num(glyphs.word);
  const seed = previewSeed(glyphs.seed);
  if (seed !== null) out.seed = seed;
  const seeds: Record<string, number> = {};
  for (const [name, value] of Object.entries(seedMap(glyphs.glyphSeeds))) {
    if (name in glyphs.items) seeds[name] = num(value);
  }
  if (Object.keys(seeds).length) out.glyphSeeds = seeds;
  const memory: Record<string, number> = {};
  for (const [name, value] of Object.entries(seedMap(glyphs.glyphSeedMemory))) {
    if (name in glyphs.items) memory[name] = num(value);
  }
  if (Object.keys(memory).length) out.glyphSeedMemory = memory;
  const editor = editorConfig(glyphs.editor, Object.keys(glyphs.items));
  if (Object.keys(editor).length) out.editor = editor;
  const items: GlyphItems = {};
  for (const [n, els] of Object.entries(glyphs.items)) items[n] = els.map(toGeo);
  out.items = items;
  return out;
}

/** 跟 Python 那边 json.dumps(..., ensure_ascii=False, indent=1) 出的文本一致。 */
export function serializeGeoFile(glyphs: GlyphLibrary): string {
  const text = JSON.stringify(toGeoFile(glyphs), null, 1);
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** 编辑器字库 -> 渲染用的原始几何（items 里是 d 串）。 */
export function toRawLibrary(glyphs: GlyphLibrary): Record<string, unknown> & { items: GlyphItems } {
  const items: GlyphItems = {};
  for (const [n, els] of Object.entries(glyphs.items)) items[n] = els.map(toGeo);
  return {
    vb: glyphs.vb,
    sw: glyphs.sw,
    mode: glyphs.mode,
    amp: glyphs.amp,
    over: glyphs.over,
    jit: glyphs.jit,
    vary: glyphs.vary,
    track: glyphs.track,
    word: glyphs.word,
    seed: glyphs.seed,
    glyphSeeds: glyphs.glyphSeeds,
    items,
  };
}
