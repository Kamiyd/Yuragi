import * as React from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Select from "@radix-ui/react-select";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  Command as CommandIcon,
  Delete as ShortcutDeleteIcon,
  Mouse as MouseIcon,
} from "lucide-react";
import {
  Add as PlusIcon,
  CheckTick as CheckIcon,
  ChevronDown as ChevronDownIcon,
  ChevronRight as ChevronRightIcon,
  CopyCopy as CopyIcon,
  CrossCross as Cross2Icon,
  DeleteDustbin as TrashIcon,
  Download01 as DownloadIcon,
  MinusMinus as MinusIcon,
} from "pikaicons";
import DraggableInput from "./DraggableInput";
import {
  DEFAULT_LATIN_ADV,
  createDocument,
  downloadDocument,
  importDocument,
  requestJSON,
} from "../lib/api";
import { BASE_STYLE, learnStrokeStyle, recognizeStroke, type StrokeStyle } from "../lib/strokes";
import {
  SHOWCASE_SPEEDS,
  buildShowcase,
  strokeFades,
  exportShowcaseVideo,
  renderShowcaseGif,
  showcaseCanvasSize,
  strokeProgress,
  type ShowcasePhase,
  type ShowcasePlan,
  type ShowcaseStroke,
} from "../lib/showcase";

type Point = [number, number];

type Segment = {
  c: string;
  p: Point[];
  a?: number[];
};

type EditableElement = {
  t?: string;
  segs?: Segment[];
  d0?: string;
  d?: string;
  fill?: boolean;
  amp?: number;
  w?: number;
  adv?: number;
  traceMode?: "original";
  [key: string]: unknown;
};

type ExportScope = "glyphs" | "row";
type ExportFormat = "svg" | "png";
type InkStyle = { color: string; opacity: number };
type RowMode = "library" | "custom";
type EditorConfig = {
  rowMode?: RowMode;
  rowText?: string;
  ink?: Record<string, InkStyle>;
  export?: {
    scope?: ExportScope;
    format?: ExportFormat;
    scale?: string;
  };
  /** 旧版编辑器的右栏值；新版保留字段以便配置往返不丢失。 */
  viewHeight?: number;
  varyEnabled?: boolean;
};

type GlyphLibrary = {
  vb: number;
  sw: number;
  /** 版式：汉字一字一格 / 拉丁绕基线。老文件没这个字段，按 adv 推断。 */
  mode?: "han" | "latin";
  amp: number;
  over: number;
  jit: number;
  vary: number;
  track?: number;
  /** 全局行预览种子；保存后也作为 write 未显式传 -s 时的默认种子。 */
  seed?: number | null;
  glyphSeeds: Record<string, number>;
  /** 上次停用跟随时的值；跟随全局只停用覆盖，不丢掉这个值。 */
  glyphSeedMemory?: Record<string, number>;
  /** 右栏里不属于几何的可复用设置。 */
  editor?: EditorConfig;
  items: Record<string, EditableElement[]>;
};

type GeoPayload = {
  file: string;
  glyphs: GlyphLibrary;
  row?: { text?: string; seed?: number };
};

type GlyphDragState = {
  name: string;
  order: string[];
  initialOrder: string[];
  preview: GeoPayload | null;
  wasUnsaved: boolean;
  pointerFrame: number | null;
  lastClientX: number;
  lastClientY: number;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  active: boolean;
};

type RenderPath = { d: string; f?: boolean; w?: number };
/** 这一版墨线里哪些是刚长出来的（淡入），哪些是刚被撤掉的（留个影子淡出）。 */
type InkFade = { enter: Set<string>; leave: RenderPath[] };

/** 整行渲染的返回。右边那张逐字大小表就是靠 table 画的。 */
type RowCell = { name: string | null; s: number; diff: number | null; thin: boolean };
type RowResult = { svg: string; table: RowCell[]; miss: string[]; ratio: number; vb?: [number, number] };
type PointTarget = { si: number; gi?: number };
type SaveOptions = { preserveCanvasUnsaved?: boolean };
type RightPanelPatch = (glyphs: GlyphLibrary) => GlyphLibrary;

type ShortcutKeyProps = {
  label: string;
  icon?: React.ReactNode;
  iconOnly?: boolean;
};

function ShortcutKey({ label, icon, iconOnly = false }: ShortcutKeyProps) {
  return (
    <kbd className={`shortcut-key${iconOnly ? " shortcut-key--icon" : ""}`} aria-label={label} title={label}>
      {icon && <span className="shortcut-key-icon" aria-hidden="true">{icon}</span>}
      {!iconOnly && <span>{label}</span>}
    </kbd>
  );
}

function ShortcutModifier() {
  return (
    <span className="shortcut-modifier">
      <ShortcutKey label="Command" icon={<CommandIcon />} iconOnly />
      <span className="shortcut-sequence-divider" aria-hidden="true">/</span>
      <ShortcutKey label="Ctrl" />
    </span>
  );
}

type IconButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  tooltipLabel?: React.ReactNode;
  children: React.ReactNode;
};

const PANEL_STORAGE_KEY = "hg-panels";
const COLOR_STORAGE_KEY = "hg-glyph-ink";
const LEGACY_COLOR_STORAGE_KEY = "hg-ink-color";
const DEFAULT_INK_COLOR = "#09090B";
const DEFAULT_INK_OPACITY = 1;
const DEFAULT_INK_STYLE: InkStyle = { color: DEFAULT_INK_COLOR, opacity: DEFAULT_INK_OPACITY };
/* 落笔淡入、撤回淡出的时长。editor.css 里那两条 keyframes 的时长跟它对齐 ——
   这边到点就把影子从 DOM 里摘掉，CSS 拖得更长的话动画会被砍断。 */
const INK_FADE_MS = 220;
const DEFAULT_VIEW_SEED = 42;
const DEFAULT_ROW_TRACK = 7;
const DEFAULT_HAN_ROW_TRACK = 0;
const EXPORT_SCALES = ["0.5", "1", "2", "3", "4"] as const;
const DRAFT_GLYPH_PREFIX = "__draft_glyph__";
const BATCH_ADD_LIMIT = 20;
const METRICS_SIZE_ALERT_PERCENT = 6;
const REFERENCE_FONTS = [
  { value: "'PingFang SC'", label: "黑体" },
  { value: "'Songti SC', serif", label: "宋体" },
  { value: "'STKaiti', 'Kaiti SC', serif", label: "楷体" },
] as const;

function isDraftGlyph(name: string) {
  return name.startsWith(DRAFT_GLYPH_PREFIX);
}

/** 版式看字库自己写的 mode；老文件没写才按「有没有 adv」推断。 */
function libraryIsLatin(library: GlyphLibrary | null | undefined) {
  if (!library) return false;
  if (library.mode) return library.mode === "latin";
  return Object.values(library.items).some((items) => items[0]?.adv !== undefined);
}

function nextDraftGlyphName(items: Record<string, EditableElement[]>) {
  let index = 1;
  let name = `${DRAFT_GLYPH_PREFIX}${index}`;
  while (Object.hasOwn(items, name)) {
    index += 1;
    name = `${DRAFT_GLYPH_PREFIX}${index}`;
  }
  return name;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * 右栏目前只改笔画的 amp/w 和拉丁字宽 adv。
 * 画布坐标（segs）可能还没保存，所以自动保存时只把这些右栏字段
 * 合并进服务器快照，不能把当前画布的整笔坐标一并写回。
 */
function mergeRightPanelItemFields(
  base: EditableElement[],
  before: EditableElement[],
  after: EditableElement[],
) {
  const next = clone(base);
  const fields = ["amp", "w", "adv"] as const;
  const length = Math.max(before.length, after.length);
  for (let index = 0; index < length; index += 1) {
    const previous = before[index];
    const changed = after[index];
    if (!previous || !changed) {
      // 右栏不会增删笔画；保守处理异常输入，避免静默丢掉该项。
      if (changed) next[index] = clone(changed);
      continue;
    }
    const target = next[index] || clone(previous);
    for (const field of fields) {
      const beforeHas = Object.hasOwn(previous, field);
      const afterHas = Object.hasOwn(changed, field);
      const beforeValue = previous[field];
      const afterValue = changed[field];
      if (beforeHas === afterHas && beforeValue === afterValue) continue;
      if (afterHas) target[field] = afterValue;
      else delete target[field];
    }
    next[index] = target;
  }
  return next;
}

function restoreGlyphFromSnapshot(current: GlyphLibrary, saved: GlyphLibrary, name: string): GlyphLibrary {
  const items = { ...current.items };
  if (Object.hasOwn(saved.items, name)) items[name] = clone(saved.items[name]);
  else delete items[name];

  const glyphSeeds = { ...current.glyphSeeds };
  if (Object.hasOwn(saved.glyphSeeds, name)) glyphSeeds[name] = saved.glyphSeeds[name];
  else delete glyphSeeds[name];

  const glyphSeedMemory = { ...(current.glyphSeedMemory || {}) };
  const savedGlyphSeedMemory = saved.glyphSeedMemory || {};
  if (Object.hasOwn(savedGlyphSeedMemory, name)) glyphSeedMemory[name] = savedGlyphSeedMemory[name];
  else delete glyphSeedMemory[name];

  const restored: GlyphLibrary = { ...current, items, glyphSeeds };
  // Preserve the optional field's shape when it is empty so a discard does not
  // create a phantom change merely by adding/removing an empty object.
  if (Object.keys(glyphSeedMemory).length || saved.glyphSeedMemory !== undefined) {
    restored.glyphSeedMemory = glyphSeedMemory;
  } else {
    delete restored.glyphSeedMemory;
  }
  return restored;
}

function sameGlyphLibrary(left: GlyphLibrary | null | undefined, right: GlyphLibrary | null | undefined) {
  if (!left || !right) return left === right;
  const normalize = (value: GlyphLibrary) => {
    const next = clone(value);
    if (!next.glyphSeedMemory || Object.keys(next.glyphSeedMemory).length === 0) {
      delete next.glyphSeedMemory;
    }
    return next;
  };
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function sameGlyphSnapshot(left: GlyphLibrary | null | undefined, right: GlyphLibrary | null | undefined, name: string) {
  if (!left || !right) return left === right;
  const snapshot = (library: GlyphLibrary) => ({
    items: library.items[name] ?? null,
    seed: Object.hasOwn(library.glyphSeeds, name) ? library.glyphSeeds[name] : null,
    seedMemory: Object.hasOwn(library.glyphSeedMemory || {}, name) ? library.glyphSeedMemory?.[name] : null,
  });
  return JSON.stringify(snapshot(left)) === JSON.stringify(snapshot(right));
}

function sameGlyphSettings(left: GlyphLibrary | null | undefined, right: GlyphLibrary | null | undefined) {
  if (!left || !right) return left === right;
  const settings = (library: GlyphLibrary) => ({
    vb: library.vb,
    sw: library.sw,
    amp: library.amp,
    over: library.over,
    jit: library.jit,
    vary: library.vary,
    track: library.track,
    seed: library.seed,
    editor: library.editor,
  });
  return JSON.stringify(settings(left)) === JSON.stringify(settings(right));
}

function normalizeHexColor(value: string) {
  const normalized = String(value || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(normalized)) {
    return `#${normalized.split("").map((digit) => `${digit}${digit}`).join("")}`.toUpperCase();
  }
  return /^[0-9a-f]{6}$/i.test(normalized) ? `#${normalized}`.toUpperCase() : DEFAULT_INK_COLOR;
}

function clampOpacity(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : DEFAULT_INK_OPACITY));
}

function readInkStyle(value: unknown): InkStyle | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const hasColor = typeof record.color === "string";
  const parsedOpacity = Number(record.opacity);
  const hasOpacity = Number.isFinite(parsedOpacity);
  if (!hasColor && !hasOpacity) return null;
  return {
    color: hasColor ? normalizeHexColor(record.color as string) : DEFAULT_INK_COLOR,
    opacity: hasOpacity ? clampOpacity(parsedOpacity) : DEFAULT_INK_OPACITY,
  };
}

function readEditorConfig(value: unknown): EditorConfig {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const next: EditorConfig = {};
  if (record.rowMode === "library" || record.rowMode === "custom") next.rowMode = record.rowMode;
  if (record.rowText !== undefined) next.rowText = String(record.rowText || "").replace(/[\/\n]/g, "");

  if (record.ink && typeof record.ink === "object") {
    const ink: Record<string, InkStyle> = {};
    for (const [name, style] of Object.entries(record.ink)) {
      const parsed = readInkStyle(style);
      if (parsed) ink[name] = parsed;
    }
    if (Object.keys(ink).length) next.ink = ink;
  }

  if (record.export && typeof record.export === "object") {
    const exportRecord = record.export as Record<string, unknown>;
    const exportConfig: NonNullable<EditorConfig["export"]> = {};
    if (exportRecord.scope === "row" || exportRecord.scope === "glyphs") exportConfig.scope = exportRecord.scope;
    if (exportRecord.format === "svg" || exportRecord.format === "png") exportConfig.format = exportRecord.format;
    const scale = String(exportRecord.scale ?? "");
    if ((EXPORT_SCALES as readonly string[]).includes(scale)) exportConfig.scale = scale;
    if (Object.keys(exportConfig).length) next.export = exportConfig;
  }

  const height = Number(record.viewHeight);
  if (Number.isFinite(height) && height >= 20 && height <= 120) next.viewHeight = height;
  if (typeof record.varyEnabled === "boolean") next.varyEnabled = record.varyEnabled;
  return next;
}

function mergeEditorConfig(base: EditorConfig | undefined, patch: Partial<EditorConfig>): EditorConfig {
  const next: EditorConfig = { ...(base || {}), ...clone(patch) };
  if (patch.ink !== undefined) {
    next.ink = { ...(base?.ink || {}), ...clone(patch.ink) };
  }
  if (patch.export !== undefined) {
    next.export = { ...(base?.export || {}), ...clone(patch.export) };
  }
  return next;
}

function inkPreferenceKey(file: string, glyph: string) {
  return `${file}\u0000${glyph}`;
}

function tintSvg(svg: string, color: string, opacity = 1) {
  const safeColor = normalizeHexColor(color);
  const safeOpacity = clampOpacity(opacity);
  return svg.replace(/<svg\b([^>]*)>/i, (_match, attributes: string) => {
    const withoutColor = attributes.replace(/\scolor="[^"]*"/i, "").replace(/\sopacity="[^"]*"/i, "");
    return `<svg${withoutColor} color="${safeColor}" opacity="${safeOpacity.toFixed(3)}">`;
  });
}

/*
 * 导出沿用迁移前编辑器的两个约定：单字文件不逐个触发下载，而是放进一个
 * 无压缩 ZIP；整行则直接保存行预览那张 SVG。这样下载的整行和下面看到
 * 的行预览是同一份路径、同一组 transform，不会因为客户端再拼一次而漂移。
 */
const UTF8 = new TextEncoder();
const ZIP_CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < ZIP_CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  ZIP_CRC_TABLE[index] = value >>> 0;
}

function crc32(data: Uint8Array) {
  let value = 0xffffffff;
  for (const byte of data) value = ZIP_CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function concatBytes(parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function zipStore(files: Array<{ name: string; data: Uint8Array }>) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9)
    | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = UTF8.encode(file.name);
    const data = file.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x800, true);
    localView.setUint16(10, dosTime, true);
    localView.setUint16(12, dosDate, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local, data);

    const entry = new Uint8Array(46 + name.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(8, 0x800, true);
    entryView.setUint16(12, dosTime, true);
    entryView.setUint16(14, dosDate, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, data.length, true);
    entryView.setUint32(24, data.length, true);
    entryView.setUint16(28, name.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(name, 46);
    central.push(entry);
    offset += local.length + data.length;
  }

  const centralBytes = concatBytes(central);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralBytes.length, true);
  endView.setUint32(16, offset, true);
  return concatBytes([...locals, centralBytes, end]);
}

function exportSafeName(value: string) {
  return String(value).replace(/[\u0000-\u001f\\/:*?"<>|]/g, "_").trim() || "glyph";
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function addSvgSize(svg: string, width: number, height: number, color = DEFAULT_INK_COLOR, opacity = DEFAULT_INK_OPACITY) {
  const tinted = tintSvg(svg, color, opacity);
  return tinted.replace("<svg ", `<svg width="${Math.max(1, Math.round(width))}" height="${Math.max(1, Math.round(height))}" `);
}

function svgToPng(svg: string, width: number, height = width) {
  return new Promise<Blob>((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
    const image = new Image();
    const clean = () => URL.revokeObjectURL(url);
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) {
        clean();
        reject(new Error("无法创建 PNG 画布"));
        return;
      }
      context.drawImage(image, 0, 0, width, height);
      canvas.toBlob((blob) => {
        clean();
        if (blob) resolve(blob);
        else reject(new Error("PNG 编码失败"));
      }, "image/png");
    };
    image.onerror = () => {
      clean();
      reject(new Error("SVG 转 PNG 失败"));
    };
    image.src = url;
  });
}

function glyphInfo(name: string) {
  if (isDraftGlyph(name)) return { base: "", variant: 1 };
  if (/^\d$/.test(name)) return { base: name, variant: 1 };
  const match = name.match(/^(.*?)(?:v)?(\d+)$/);
  const base = match?.[1] || name;
  const variant = match ? Number(match[2]) : 1;
  return { base, variant };
}

function glyphLabel(name: string) {
  if (isDraftGlyph(name)) return "";
  const info = glyphInfo(name);
  return info.variant > 1 ? `${info.base} · 第 ${info.variant} 个` : info.base;
}

function nextGlyphVariantName(items: Record<string, EditableElement[]>, name: string) {
  const base = glyphInfo(name).base || name;
  if (!base) return nextDraftGlyphName(items);
  if (!Object.hasOwn(items, base)) return base;
  let variant = 2;
  const variantName = (value: number) => /^\d$/.test(base) ? `${base}v${value}` : `${base}${value}`;
  while (Object.hasOwn(items, variantName(variant))) variant += 1;
  return variantName(variant);
}

type BatchGlyphPlanEntry = { character: string; name: string; variant: number };

function batchGlyphCharacters(value: string) {
  return [...String(value || "")].filter((character) => !/\s/.test(character) && character !== "/");
}

function buildBatchGlyphPlan(items: Record<string, EditableElement[]>, value: string): BatchGlyphPlanEntry[] {
  const working = { ...items };
  const plan: BatchGlyphPlanEntry[] = [];
  for (const character of batchGlyphCharacters(value).slice(0, BATCH_ADD_LIMIT)) {
    const name = nextGlyphVariantName(working, character);
    plan.push({ character, name, variant: glyphInfo(name).variant });
    working[name] = [];
  }
  return plan;
}

function firstReferenceCharacter(value: string) {
  return [...String(value || "").trim()][0] || "";
}

/* 汉字库和拉丁库是两套排版（一字一格 vs 各带 adv 绕基线压到基线上），
   线宽预设也不是一个数。把汉字画进拉丁库，它会被按 adv 比例排、按字面底边
   压到基线上 —— 出来的一行是坏的，而且一个 sw 同时服务不了两种字面。
   所以在**起名字**这个入口就挡住：字母不进汉字库，汉字不进拉丁库。

   数字和西文标点两边都放行 —— 「2024」和句读在两种版式里都用得上。
   只对**明确选过版式**的字库生效：老文件（含中英混排那份）没有 mode，
   行为一个字都不变。 */
const CJK_CHAR = /[\u3400-\u9FFF\uF900-\uFAFF]|[\uD840-\uD87F][\uDC00-\uDFFF]/;
const CJK_PUNCT = /[\u3000-\u303F\uFF01-\uFF60]/;
const LATIN_LETTER = /[A-Za-z]/;

function glyphNameFitsMode(character: string, mode: "han" | "latin" | undefined) {
  if (!character || !mode) return "";
  if (mode === "latin" && (CJK_CHAR.test(character) || CJK_PUNCT.test(character))) {
    return "请在汉字库中创建。";
  }
  if (mode === "han" && LATIN_LETTER.test(character)) {
    return "请在拉丁库中创建。";
  }
  return "";
}

function renameGlyphInLibrary(library: GlyphLibrary, from: string, reference: string) {
  const base = firstReferenceCharacter(reference);
  if (!base || !from || !Object.hasOwn(library.items, from) || glyphInfo(from).base === base) return null;

  const name = nextGlyphVariantName(library.items, base);
  const items: Record<string, EditableElement[]> = {};
  for (const [entry, value] of Object.entries(library.items)) {
    items[entry === from ? name : entry] = value;
  }

  const glyphSeeds = { ...(library.glyphSeeds || {}) };
  if (Object.hasOwn(glyphSeeds, from)) {
    glyphSeeds[name] = glyphSeeds[from];
    delete glyphSeeds[from];
  }

  const next: GlyphLibrary = { ...library, items, glyphSeeds };
  const seedMemory = { ...(library.glyphSeedMemory || {}) };
  if (Object.hasOwn(seedMemory, from)) {
    seedMemory[name] = seedMemory[from];
    delete seedMemory[from];
  }
  if (Object.keys(seedMemory).length || library.glyphSeedMemory !== undefined) {
    next.glyphSeedMemory = seedMemory;
  } else {
    delete next.glyphSeedMemory;
  }

  if (library.editor?.ink && Object.hasOwn(library.editor.ink, from)) {
    const ink = { ...library.editor.ink, [name]: clone(library.editor.ink[from]) };
    delete ink[from];
    next.editor = { ...(library.editor || {}), ink };
  }

  return { glyphs: next, name };
}

function pathD(segs: Segment[] = []) {
  const number = (value: number) => Math.round(value * 100) / 100;
  let d = "";
  for (const segment of segs) {
    const points = segment.p || [];
    const end = points[points.length - 1];
    if (segment.c === "Z") {
      d += "Z";
      continue;
    }
    if (!end) continue;
    if (segment.c === "M") d += `M${number(end[0])} ${number(end[1])}`;
    else if (segment.c === "H") d += `H${number(end[0])}`;
    else if (segment.c === "V") d += `V${number(end[1])}`;
    else if (segment.c === "L") d += `L${number(end[0])} ${number(end[1])}`;
    else if (segment.c === "Q") {
      const control = points[0] || end;
      d += `Q${number(control[0])} ${number(control[1])} ${number(end[0])} ${number(end[1])}`;
    } else if (segment.c === "C") {
      const c1 = points[0] || end;
      const c2 = points[1] || end;
      d += `C${number(c1[0])} ${number(c1[1])} ${number(c2[0])} ${number(c2[1])} ${number(end[0])} ${number(end[1])}`;
    } else if (segment.c === "A") {
      const arc = segment.a || [0, 0, 0, 0, 0];
      d += `A${arc.slice(0, 3).map(number).join(" ")} ${arc[3]} ${arc[4]} ${number(end[0])} ${number(end[1])}`;
    }
  }
  return d || "M0 0";
}

function pointDistance(a: Point, b: Point) {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function traceLength(points: Point[]) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += pointDistance(points[index - 1], points[index]);
  }
  return length;
}

function pointSegmentDistance(point: Point, a: Point, b: Point) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  if (!dx && !dy) return pointDistance(point, a);
  const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return pointDistance(point, [a[0] + t * dx, a[1] + t * dy]);
}

function compactTrace(points: Point[], gap = 0.28) {
  if (points.length <= 2) return points.slice();
  const output = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    if (pointDistance(points[index], output[output.length - 1]) >= gap) output.push(points[index]);
  }
  if (output.length === 1) output.push(points[points.length - 1]);
  return output;
}

function smoothTrace(points: Point[], radius = 2) {
  if (points.length <= 4) return points.slice();
  const output = [points[0]];
  for (let index = 1; index < points.length - 1; index += 1) {
    let x = 0;
    let y = 0;
    let count = 0;
    for (let cursor = Math.max(1, index - radius); cursor <= Math.min(points.length - 2, index + radius); cursor += 1) {
      x += points[cursor][0];
      y += points[cursor][1];
      count += 1;
    }
    output.push([x / count, y / count]);
  }
  output.push(points[points.length - 1]);
  return output;
}

function simplifyTrace(points: Point[], tolerance = 0.5): Point[] {
  if (points.length <= 2) return points.slice();
  let maxDistance = tolerance;
  let index = -1;
  for (let cursor = 1; cursor < points.length - 1; cursor += 1) {
    const distance = pointSegmentDistance(points[cursor], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      maxDistance = distance;
      index = cursor;
    }
  }
  if (index < 0) return [points[0], points[points.length - 1]];
  const left = simplifyTrace(points.slice(0, index + 1), tolerance);
  const right = simplifyTrace(points.slice(index), tolerance);
  return left.slice(0, -1).concat(right);
}

/** Keep loops and multiple turns; only remove near-duplicate samples. */
function preserveTrace(raw: Point[], vb: number): { type: string; segs: Segment[] } | null {
  const gap = Math.max(0.03, vb / 640);
  const points = compactTrace(raw, gap);
  const last = raw[raw.length - 1];
  if (last && points.length && pointDistance(points[points.length - 1], last) > 0) points.push(last);
  if (points.length < 2 || traceLength(points) < gap * 2) return null;
  const nodes = simplifyTrace(points, gap);
  const segs: Segment[] = [{ c: "M", p: [nodes[0]] }];
  // Round only the interior of each corner, keeping turns and endpoints close to the trace.
  for (let i = 1; i < nodes.length - 1; i += 1) {
    const a = nodes[i - 1], b = nodes[i], c = nodes[i + 1];
    const before = Math.min(0.15, gap / Math.max(pointDistance(a, b), gap));
    const after = Math.min(0.15, gap / Math.max(pointDistance(b, c), gap));
    segs.push({ c: "L", p: [[b[0] + (a[0] - b[0]) * before, b[1] + (a[1] - b[1]) * before]] });
    segs.push({ c: "Q", p: [b, [b[0] + (c[0] - b[0]) * after, b[1] + (c[1] - b[1]) * after]] });
  }
  segs.push({ c: "L", p: [nodes[nodes.length - 1]] });
  return { type: "原始手迹", segs };
}

/** Blunt, gently uneven live ink; original points remain the recognition input. */
function traceInkD(raw: Point[], strokeWidth: number) {
  if (raw.length < 2) return "";
  const points = smoothTrace(compactTrace(raw, 0.12), 1);
  const lengths = [0];
  for (let i = 1; i < points.length; i += 1) lengths.push(lengths[i - 1] + pointDistance(points[i - 1], points[i]));
  const total = lengths[lengths.length - 1];
  if (total < 0.001) return "";
  const width = Math.max(0.4, strokeWidth * 0.44);
  const taper = Math.min(total * 0.25, width * 2);
  const left: Point[] = [], right: Point[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next[0] - previous[0], dy = next[1] - previous[1];
    const length = Math.hypot(dx, dy) || 1;
    const start = Math.min(1, lengths[i] / taper);
    const end = Math.min(1, (total - lengths[i]) / taper);
    // Distance-based variation stays steady while new samples arrive.
    const travel = lengths[i];
    const radius = width * (0.85 + 0.15 * start) * (0.88 + 0.12 * end)
      * (1 + 0.13 * Math.sin(travel * 0.83 + 0.4) + 0.06 * Math.sin(travel * 2.17));
    const leftRadius = radius * (1 + 0.045 * Math.sin(travel * 3.1));
    const rightRadius = radius * (1 + 0.055 * Math.sin(travel * 2.6 + 1.7));
    left.push([points[i][0] - dy / length * leftRadius, points[i][1] + dx / length * leftRadius]);
    right.push([points[i][0] + dy / length * rightRadius, points[i][1] - dx / length * rightRadius]);
  }
  const coord = ([x, y]: Point) => `${x.toFixed(3)} ${y.toFixed(3)}`;
  const cap = (end: Point, neighbor: Point): Point => {
    const distance = pointDistance(end, neighbor) || 1;
    const extension = Math.min(width * 1.35, total * 0.4);
    return [end[0] + (end[0] - neighbor[0]) / distance * extension, end[1] + (end[1] - neighbor[1]) / distance * extension];
  };
  const last = points.length - 1;
  return `M${left.map(coord).join("L")}Q${coord(cap(points[last], points[last - 1]))} ${coord(right[last])}L${right.slice(0, -1).reverse().map(coord).join("L")}Q${coord(cap(points[0], points[1]))} ${coord(left[0])}Z`;
}

function readGlyphSeed(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const seed = Number(value);
  return Number.isFinite(seed) ? Math.trunc(seed) : null;
}

/** 一次单字渲染的请求体。内容一样 = 结果一样，所以它同时当缓存键用。 */
function renderBody(group: GlyphLibrary, name: string, index: number) {
  return JSON.stringify({
    vb: group.vb,
    idx: index,
    items: group.items[name] ?? [],
    amp: group.amp,
    over: group.over,
    localSeed: group.glyphSeeds[name] ?? null,
  });
}

function glyphExportSvg(paths: RenderPath[], group: GlyphLibrary, scale: number, color = DEFAULT_INK_COLOR, opacity = DEFAULT_INK_OPACITY) {
  const size = Math.max(1, Math.round(group.vb * scale));
  const body = paths.map((path) => path.f
    ? `<path d="${path.d}" fill="currentColor" stroke="none"/>`
    : `<path d="${path.d}"${path.w ? ` stroke-width="${(group.sw * path.w).toFixed(3)}"` : ""}/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${group.vb} ${group.vb}" fill="none" stroke="currentColor" stroke-width="${group.sw}" stroke-linecap="round" stroke-linejoin="round" color="${normalizeHexColor(color)}" opacity="${clampOpacity(opacity).toFixed(3)}">${body}</svg>`;
}

async function renderExportGlyph(group: GlyphLibrary, name: string, glyphIndex: number, format: ExportFormat, scale: number, color = DEFAULT_INK_COLOR, opacity = DEFAULT_INK_OPACITY) {
  const paths = (await requestJSON<{ paths: RenderPath[] }>("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vb: group.vb,
      idx: glyphIndex,
      items: group.items[name],
      amp: group.amp,
      over: group.over,
      localSeed: group.glyphSeeds[name] ?? null,
    }),
  })).paths || [];
  const svg = glyphExportSvg(paths, group, scale, color, opacity);
  if (format === "svg") return UTF8.encode(svg);
  return new Uint8Array(await (await svgToPng(svg, Math.max(1, Math.round(group.vb * scale)))).arrayBuffer());
}

function rowExportBox(result: RowResult): [number, number] {
  if (result.vb && result.vb.length === 2 && result.vb.every((value) => Number.isFinite(value) && value > 0)) {
    return result.vb;
  }
  const height = 100;
  return [Math.max(1, height * (result.ratio || 1)), height];
}

/* 常量对象：换成新对象 React 就会重写 innerHTML，把滤镜里那条 <animate> 打回起点。 */
const CANVAS_BOIL_HTML = { __html: previewBoilFilterMarkup("preview-boil-canvas", 0.36) };

function previewBoilFilterMarkup(id: string, scale: number) {
  return `<filter id="${id}" x="-30%" y="-30%" width="160%" height="160%"><feTurbulence type="fractalNoise" baseFrequency="0.055" numOctaves="2" seed="1" result="noise"><animate attributeName="seed" values="1;2;3;4;5;6" dur="0.75s" repeatCount="indefinite" calcMode="discrete"></animate></feTurbulence><feDisplacementMap in="SourceGraphic" in2="noise" scale="${scale}" xChannelSelector="R" yChannelSelector="G"></feDisplacementMap></filter>`;
}

function colorizeRowSvg(svg: string, styles: InkStyle[] = []) {
  let glyphIndex = 0;
  return tintSvg(svg, DEFAULT_INK_COLOR, DEFAULT_INK_OPACITY).replace(
    /<g transform="([^"]*)">([\s\S]*?)<\/g>/g,
    (_match, transform, body) => {
      const style = styles[glyphIndex++] || DEFAULT_INK_STYLE;
      return `<g transform="${transform}" color="${style.color}" opacity="${style.opacity.toFixed(3)}">${body}</g>`;
    },
  );
}

function rowPreviewSvg(svg: string, height: number, ratio: number, playing: boolean, styles: InkStyle[] = []) {
  const sized = colorizeRowSvg(svg, styles).replace(
    "<svg",
    `<svg height="${height}" width="${(height * (ratio || 1)).toFixed(1)}"`,
  );
  const withFilter = sized.replace(
    /(<svg\b[^>]*>)/,
    `$1<defs>${previewBoilFilterMarkup("preview-boil-row", 3.4)}</defs>`,
  );
  return withFilter.replace(/<g transform="([^"]*)" color="([^"]*)" opacity="([^"]*)">([\s\S]*?)<\/g>/g, (_match, transform, color, opacity, body) => (
    `<g transform="${transform}" color="${color}" opacity="${opacity}"><g class="preview-glyph"${playing ? ` filter="url(#preview-boil-row)"` : ""}>${body}</g></g>`
  ));
}

/* ── 展示：全白画面上按笔顺把这段话写一遍，并把这一遍导出成视频 / GIF ─────
   排程、画帧、编码都在 src/lib/showcase.ts —— 屏幕上动的是 SVG 的 dashoffset，
   导出走 canvas，两边读同一份排程，所以导出的就是你刚看的那一遍。 */
function ShowcaseStage({ svg, ratio, name, onClose }: {
  svg: string;
  ratio: number;
  name: string;
  onClose: () => void;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const injectedRef = React.useRef<{ node: Element | null; svg: string }>({ node: null, svg: "" });
  const [domEpoch, setDomEpoch] = React.useState(0);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const planRef = React.useRef<ShowcasePlan | null>(null);
  const [speed, setSpeed] = React.useState(1);
  const [run, setRun] = React.useState(0);
  const [done, setDone] = React.useState(false);
  const [busy, setBusy] = React.useState<"video" | "gif" | null>(null);
  const [exportOpen, setExportOpen] = React.useState(false);
  const [phase, setPhase] = React.useState<ShowcasePhase>("record");
  const [progress, setProgress] = React.useState(0);
  const [error, setError] = React.useState("");

  /* SVG 自己塞进去，不走 dangerouslySetInnerHTML —— React 会在后面的提交里把
     innerHTML 再设一遍，把我们刚写上去的 dashoffset 连同 168 个节点一起换掉，
     于是笔画从第一帧就全露着，整段动画等于没跑。这里认准「节点 + 内容」都没变
     才跳过；真被换了就重塞一次并让排程重来。 */
  React.useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (injectedRef.current.node === host && injectedRef.current.svg === svg) return;
    host.innerHTML = svg;
    injectedRef.current = { node: host, svg };
    setDomEpoch((epoch) => epoch + 1);
  });

  React.useEffect(() => {
    const svgEl = hostRef.current?.querySelector("svg");
    if (!svgEl) return;
    svgEl.removeAttribute("width");
    svgEl.removeAttribute("height");

    // 排程炸了不能把整个编辑器带走：effect 里抛出去 React 会把整棵树卸掉，
    // 屏幕就全白了（transformPoint 那次就是这么白的）。退回成静态显示。
    let plan: ShowcasePlan;
    try {
      plan = buildShowcase(svgEl, speed);
    } catch (failure) {
      console.error("展示排程失败", failure);
      setDone(true);
      return;
    }
    planRef.current = plan;
    const strokes = plan.strokes;

    const hide = (stroke: ShowcaseStroke) => {
      if (strokeFades(stroke)) stroke.el.style.opacity = "0";
      else {
        stroke.el.style.strokeDasharray = `${stroke.len}`;
        stroke.el.style.strokeDashoffset = `${stroke.len}`;
      }
    };
    /* 写完就把行内样式摘掉：留着 dasharray 的话收笔那一头会被虚线的舍入啃掉一点。 */
    const settle = (stroke: ShowcaseStroke) => {
      stroke.el.style.opacity = "";
      stroke.el.style.strokeDasharray = "";
      stroke.el.style.strokeDashoffset = "";
    };
    const reveal = (stroke: ShowcaseStroke, p: number) => {
      if (strokeFades(stroke)) stroke.el.style.opacity = `${p}`;
      else stroke.el.style.strokeDashoffset = `${stroke.len * (1 - p)}`;
    };

    strokes.forEach(hide);
    setDone(false);

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      strokes.forEach(settle);
      setDone(true);
      return;
    }

    let frame = 0;
    let index = 0;
    const started = performance.now();
    const tick = (now: number) => {
      const t = now - started;
      // 笔与笔之间留了间隙，所以同一时刻最多只有一笔在写 —— 每帧只动那一条。
      while (index < strokes.length && t >= strokes[index].start + strokes[index].dur) settle(strokes[index++]);
      if (index >= strokes.length) { setDone(true); return; }
      const stroke = strokes[index];
      if (t >= stroke.start) reveal(stroke, strokeProgress(stroke, t));
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      strokes.forEach(settle);
    };
  }, [svg, speed, run, domEpoch]);

  const runExport = async (kind: "video" | "gif") => {
    const plan = planRef.current;
    const canvas = canvasRef.current;
    if (!plan || !canvas || busy) return;
    setError("");
    setExportOpen(false);
    setBusy(kind);
    setPhase("record");
    setProgress(0);
    try {
      const { width, height, scale } = showcaseCanvasSize(plan, kind === "video" ? 1440 : 960);
      canvas.width = width;
      canvas.height = height;
      const base = `${exportSafeName(name.slice(0, 12) || "手写")}-展示`;
      if (kind === "video") {
        const blob = await exportShowcaseVideo(plan, canvas, scale, { onProgress: setProgress, onPhase: setPhase });
        downloadBlob(blob, `${base}.mp4`);
      } else {
        downloadBlob(await renderShowcaseGif(plan, canvas, scale, { onProgress: setProgress }), `${base}.gif`);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "导出没成");
    } finally {
      setBusy(null);
      setProgress(0);
    }
  };

  return (
    <div className="showcase" style={{ "--showcase-ratio": String(ratio || 1) } as React.CSSProperties}>
      <div className="showcase-paper" ref={hostRef} hidden={!!busy} />
      <canvas className="showcase-canvas" ref={canvasRef} hidden={!busy} />
      <div className="showcase-bar" data-done={done}>
        <button className="showcase-action" type="button" disabled={!!busy} onClick={() => setRun((value) => value + 1)}>
          {done ? "再写一遍" : "从头写"}
        </button>
        <div className="showcase-speeds" role="group" aria-label="书写速度">
          {SHOWCASE_SPEEDS.map(([label, value]) => (
            <button
              className={value === speed ? "active" : ""}
              key={label}
              type="button"
              disabled={!!busy}
              aria-pressed={value === speed}
              onClick={() => setSpeed(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="showcase-sep" />
        <div
          className="showcase-export"
          data-open={exportOpen}
          onPointerEnter={() => setExportOpen(true)}
          onPointerLeave={() => setExportOpen(false)}
          onFocusCapture={() => setExportOpen(true)}
          onBlurCapture={(event) => {
            const next = event.relatedTarget;
            if (!(next instanceof Node) || !event.currentTarget.contains(next)) setExportOpen(false);
          }}
        >
          <button
            className="showcase-action showcase-export-trigger"
            type="button"
            disabled={!!busy}
            aria-haspopup="menu"
            aria-expanded={exportOpen}
            onClick={() => setExportOpen(true)}
          >
            导出 <ChevronDownIcon className="showcase-export-chevron" aria-hidden="true" />
          </button>
          {exportOpen && (
            <div className="showcase-export-menu" role="menu" aria-label="选择导出格式">
              <button className="showcase-export-option" type="button" role="menuitem" disabled={!!busy} onClick={() => void runExport("video")}>
                导出 MP4
              </button>
              <button className="showcase-export-option" type="button" role="menuitem" disabled={!!busy} onClick={() => void runExport("gif")}>
                导出 GIF
              </button>
            </div>
          )}
        </div>
        <button className="showcase-action" type="button" disabled={!!busy} onClick={onClose}>关闭 <kbd>Esc</kbd></button>
      </div>
      {busy && (
        <p className="showcase-note">
          {busy === "gif" ? `正在编 GIF · ${Math.round(progress * 100)}%`
            : phase === "convert" ? "这个浏览器录不出 MP4，正在用 ffmpeg 转…"
            : phase === "record" ? `没有 WebCodecs，只能实时录一遍 · ${Math.round(progress * 100)}%`
            : `正在渲染 MP4 · ${Math.round(progress * 100)}%`}
        </p>
      )}
      {!busy && error && <p className="showcase-note is-error">{error}</p>}
    </div>
  );
}

/* 缩略图缓存：键就是请求体，所以只有这个字自己的骨架或整组手感变了才会失效。
   老版靠 thumbCache 做同一件事 —— 不这么做的话，动一次滑杆左栏 N 个字全部重发。 */
const thumbCache = new Map<string, RenderPath[]>();
const THUMB_CACHE_MAX = 400;

function cacheThumb(key: string, paths: RenderPath[]) {
  thumbCache.set(key, paths);
  while (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value;
    if (oldest === undefined) break;
    thumbCache.delete(oldest);
  }
}

/* 缩略图串行队列：最多两个并发。渲染是同步的，一次涌进十几个字
   只会互相排队，反而把主画布的预览挤慢。 */
const thumbQueue: Array<() => Promise<void>> = [];
let thumbRunning = 0;

function pumpThumbs() {
  while (thumbRunning < 2 && thumbQueue.length) {
    const job = thumbQueue.shift();
    if (!job) break;
    thumbRunning += 1;
    void job().finally(() => { thumbRunning -= 1; pumpThumbs(); });
  }
}

function enqueueThumb(body: string, onDone: (paths: RenderPath[]) => void) {
  thumbQueue.push(async () => {
    const cached = thumbCache.get(body);
    if (cached) { onDone(cached); return; }
    try {
      const result = await requestJSON<{ paths: RenderPath[] }>("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      cacheThumb(body, result.paths || []);
      onDone(result.paths || []);
    } catch { /* 缩略图失败不打扰主流程 */ }
  });
  pumpThumbs();
}

function formatNumber(value: number, digits = 2) {
  return Number.isInteger(value) ? String(value) : value.toFixed(digits).replace(/0+$/, "").replace(/\.$/, "");
}

function PanelGlyph({ side }: { side: "left" | "right" }) {
  return (
    <svg className="panel-glyph" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="1.6" y="2.9" width="12.8" height="10.2" rx="2.6" />
      <path d={side === "left" ? "M6.3 2.9V13.1" : "M9.7 2.9V13.1"} />
    </svg>
  );
}

function PreviewPlaybackIcon({ paused = false }: { paused?: boolean }) {
  return (
    <svg className="preview-playback-icon" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paused ? (
        <>
          <rect x="4.25" y="3.15" width="2.55" height="9.7" rx="1.25" />
          <rect x="9.2" y="3.15" width="2.55" height="9.7" rx="1.25" />
        </>
      ) : (
        <path d="M5.75 4.05L10.75 6.9Q12.65 8 10.75 9.1L5.75 11.95Q3.7 13.05 3.7 10.75V5.25Q3.7 2.95 5.75 4.05Z" />
      )}
    </svg>
  );
}

function PreviewEggIcon() {
  return (
    <svg className="preview-egg-icon" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.55c2.76 0 4.72 3.05 4.72 6.38 0 2.86-1.86 4.52-4.72 4.52s-4.72-1.66-4.72-4.52C3.28 5.6 5.24 2.55 8 2.55Z" />
      <path d="M4.55 7.45c.76-.48 1.4-.48 2.1 0 .72.49 1.37.49 2.08-.01.75-.52 1.37-.51 2.16-.03" />
      <path d="M5.1 10.35c.59.34 1.13.34 1.7 0 .66-.4 1.3-.4 1.96 0 .59.35 1.15.35 1.78-.02" />
    </svg>
  );
}

function MoreGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <circle cx="4" cy="9" r="1.15" fill="currentColor" />
      <circle cx="9" cy="9" r="1.15" fill="currentColor" />
      <circle cx="14" cy="9" r="1.15" fill="currentColor" />
    </svg>
  );
}

function MetricsIcon() {
  return (
    <svg className="metrics-toggle-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.4 3.1h7.2a2.3 2.3 0 0 1 2.3 2.3v7.2a2.3 2.3 0 0 1-2.3 2.3H5.4a2.3 2.3 0 0 1-2.3-2.3V5.4a2.3 2.3 0 0 1 2.3-2.3Z" />
      <path d="M5.7 8.9c.7.7 1.2 1.2 2 1.9 1.2-1.3 2.3-2.5 3.8-3.9" />
    </svg>
  );
}

function IconButton({ label, tooltipLabel = label, children, className = "", ...props }: IconButtonProps) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button {...props} className={`icon-button ${className}`} aria-label={label}>
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" sideOffset={8}>
          {tooltipLabel}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

const UnderIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <path d="M4 14.5 L9 3.5 L14 14.5" /><path d="M6.2 10.5h5.6" />
  </svg>
);
const GridToolIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M3.5 3.5h11v11h-11zM3.5 9h11M9 3.5v11" />
  </svg>
);
/** 智能识别：一笔横折落到位，角上点一下表示「认出来了」。 */
const TraceSmartIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.8 6.2h7.4" />
    <path d="M6.6 3.5v7.1c0 1.9-1 3.1-2.9 3.6" />
    <path d="M13.7 2.6l.75 1.85 1.85.75-1.85.75-.75 1.85-.75-1.85-1.85-.75 1.85-.75z" />
  </svg>
);
/** 保留手迹：原样留下的那条抖线。 */
const TraceRawIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.6 12.2c1.4-5.4 2.6-7.8 3.7-7.7 1.1.1.5 6.3 1.8 6.5 1.2.2 1.8-5.3 3.1-5.2 1.1.1.6 4.2 1.5 4.3.7.1 1.4-.7 2.3-2.3" />
  </svg>
);
const TRACE_MODES = [
  { value: "smart", label: "智能识别", icon: TraceSmartIcon, hint: "对着汉字笔画识别，照现有字库的写法落笔。" },
  { value: "original", label: "保留手迹", icon: TraceRawIcon, hint: "保留走向和回环，适合英文、连笔与手绘。" },
] as const;
const BoneIcon = (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <path d="M4 13c2-3 3-8 5-8 2.2 0 3 4 5 8" /><circle cx="9" cy="5" r="1.1" fill="currentColor" stroke="none" />
  </svg>
);
function Section({
  title,
  open,
  onOpenChange,
  className = "",
  aside,
  indicator,
  indicatorAction,
  indicatorDoubleAction,
  indicatorHasMenu,
  indicatorLabel,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
  aside?: React.ReactNode;
  indicator?: React.ReactNode;
  indicatorAction?: (open: boolean, event: React.MouseEvent<HTMLButtonElement>) => void;
  indicatorDoubleAction?: (open: boolean, event: React.MouseEvent<HTMLButtonElement>) => void;
  indicatorHasMenu?: boolean;
  indicatorLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible.Root open={open} onOpenChange={onOpenChange} className={`section ${className}`.trim()} data-open={open}>
      {indicatorAction ? (
        <div className="section-trigger section-trigger--action">
          <Collapsible.Trigger className="section-trigger-main">
            <span className="section-title">{title}</span>
            <span className="section-chevron" aria-hidden="true"><ChevronRightIcon className="pika-ui-icon" /></span>
            {aside && <span className="section-aside">{aside}</span>}
          </Collapsible.Trigger>
          <button
            className="section-trigger-action"
            type="button"
            aria-label={indicatorLabel || (open ? `添加${title}项` : `展开${title}`)}
            aria-haspopup={indicatorHasMenu ? "menu" : undefined}
            title={indicatorLabel || (open ? `添加${title}项` : `展开${title}`)}
            onClick={(event) => indicatorAction(open, event)}
            onDoubleClick={(event) => indicatorDoubleAction?.(open, event)}
          >
            {indicator}
          </button>
        </div>
      ) : (
        <Collapsible.Trigger className="section-trigger">
          <span className="section-title">{title}</span>
          <span className="section-chevron" aria-hidden="true"><ChevronRightIcon className="pika-ui-icon" /></span>
          {aside && <span className="section-aside">{aside}</span>}
        </Collapsible.Trigger>
      )}
      <Collapsible.Content className="section-body">{children}</Collapsible.Content>
    </Collapsible.Root>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  suffix = "",
  disabled = false,
  formatValue,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  disabled?: boolean;
  formatValue?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <DraggableInput
      label={label}
      value={value}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={onChange}
      formatValue={formatValue ?? ((nextValue) => `${formatNumber(nextValue)}${suffix}`)}
    />
  );
}

function InkColorField({
  color,
  opacity,
  onColorChange,
  onOpacityChange,
}: {
  color: string;
  opacity: number;
  onColorChange: (value: string) => void;
  onOpacityChange: (value: number) => void;
}) {
  const nativeInputRef = React.useRef<HTMLInputElement>(null);
  const opacityScrubRef = React.useRef<{ pointerId: number; startX: number; startValue: number } | null>(null);
  const [opacityScrubbing, setOpacityScrubbing] = React.useState(false);
  const [colorText, setColorText] = React.useState(color.slice(1).toUpperCase());
  const [opacityText, setOpacityText] = React.useState(String(Math.round(opacity * 100)));

  React.useEffect(() => {
    setColorText(color.slice(1).toUpperCase());
  }, [color]);

  React.useEffect(() => {
    setOpacityText(String(Math.round(opacity * 100)));
  }, [opacity]);

  const commitColor = (value: string) => {
    const trimmed = value.trim();
    const hex = trimmed.replace(/^#/, "");
    if (/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) {
      const normalized = normalizeHexColor(trimmed);
      setColorText(normalized.slice(1));
      onColorChange(normalized);
      return;
    }
    setColorText(color.slice(1).toUpperCase());
  };

  const commitOpacity = (value: string) => {
    const parsed = Number(value);
    const next = Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : Math.round(opacity * 100);
    setOpacityText(String(next));
    onOpacityChange(next / 100);
  };

  const beginOpacityScrub = (event: React.PointerEvent<HTMLSpanElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    opacityScrubRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startValue: Math.round(opacity * 100),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setOpacityScrubbing(true);
  };

  const updateOpacityScrub = (event: React.PointerEvent<HTMLSpanElement>) => {
    const scrub = opacityScrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(100, scrub.startValue + Math.round(event.clientX - scrub.startX)));
    setOpacityText(String(next));
    onOpacityChange(next / 100);
  };

  const endOpacityScrub = (event: React.PointerEvent<HTMLSpanElement>) => {
    const scrub = opacityScrubRef.current;
    if (!scrub || scrub.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    opacityScrubRef.current = null;
    setOpacityScrubbing(false);
  };

  return (
    <div className="color-field">
      <button
        className="color-swatch-trigger"
        type="button"
        aria-label={`选择文字颜色 ${color}`}
        title="选择文字颜色"
        onClick={() => nativeInputRef.current?.click()}
      >
        <span className="color-swatch" style={{ backgroundColor: color }} aria-hidden="true" />
      </button>
      <input
        className="color-hex-input"
        type="text"
        inputMode="text"
        maxLength={7}
        spellCheck={false}
        value={colorText}
        aria-label="文字颜色 HEX 值"
        onChange={(event) => setColorText(event.currentTarget.value.slice(0, 7))}
        onFocus={(event) => event.currentTarget.select()}
        onClick={(event) => event.currentTarget.select()}
        onBlur={(event) => commitColor(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      <label className={`color-opacity${opacityScrubbing ? " is-scrubbing" : ""}`} title="文字不透明度">
        <input
          type="number"
          min="0"
          max="100"
          step="1"
          value={opacityText}
          aria-label="文字不透明度"
          onChange={(event) => {
            setOpacityText(event.currentTarget.value);
            if (event.currentTarget.value !== "") commitOpacity(event.currentTarget.value);
          }}
          onBlur={(event) => commitOpacity(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <span
          className="color-opacity-scrub"
          aria-hidden="true"
          onPointerDown={beginOpacityScrub}
          onPointerMove={updateOpacityScrub}
          onPointerUp={endOpacityScrub}
          onPointerCancel={endOpacityScrub}
        >
          %
        </span>
      </label>
      <input
        ref={nativeInputRef}
        className="color-native-input"
        type="color"
        value={color}
        aria-label="选择文字颜色"
        tabIndex={-1}
        onChange={(event) => onColorChange(normalizeHexColor(event.currentTarget.value))}
      />
    </div>
  );
}

function GlyphThumbnail({
  group,
  name,
  index,
  color = DEFAULT_INK_COLOR,
  opacity = DEFAULT_INK_OPACITY,
}: {
  group: GlyphLibrary;
  name: string;
  index: number;
  color?: string;
  opacity?: number;
}) {
  const body = renderBody(group, name, index);
  const [paths, setPaths] = React.useState<RenderPath[]>(() => thumbCache.get(body) || []);

  React.useEffect(() => {
    const cached = thumbCache.get(body);
    if (cached) { setPaths(cached); return; }
    let mounted = true;
    // 拖滑杆的时候不要跟着一起发：等手停一下再补缩略图
    const timer = window.setTimeout(() => {
      enqueueThumb(body, (next) => { if (mounted) setPaths(next); });
    }, 240);
    return () => { mounted = false; window.clearTimeout(timer); };
  }, [body]);

  return (
    <svg className="glyph-thumbnail" viewBox={`0 0 ${group.vb} ${group.vb}`} style={{ color, opacity }} aria-hidden="true">
      {paths.map((path, pathIndex) => (
        <path
          d={path.d}
          key={`${path.d}-${pathIndex}`}
          className={path.f ? "filled" : undefined}
          strokeWidth={path.w ? group.sw * path.w : group.sw}
        />
      ))}
    </svg>
  );
}

const MemoGlyphThumbnail = React.memo(GlyphThumbnail);

function CanvasGrid({ vb }: { vb: number }) {
  const lines = Array.from({ length: Math.floor(vb / 4) + 1 }, (_, index) => index * 4);
  return (
    <g className="canvas-grid">
      {lines.map((line) => {
        const major = line % 8 === 0;
        return (
          <React.Fragment key={line}>
            <path className={major ? "major" : undefined} d={`M${line} 0V${vb}`} />
            <path className={major ? "major" : undefined} d={`M0 ${line}H${vb}`} />
            {major && line > 0 && (
              <>
                <text className="canvas-tick" x={line + 0.3} y={1.6}>{line}</text>
                <text className="canvas-tick" x={0.3} y={line - 0.3}>{line}</text>
              </>
            )}
          </React.Fragment>
        );
      })}
    </g>
  );
}

/** 字面框：所有骨架点的包围盒，用来看这个字在格子里站得正不正。 */
function faceBox(items: EditableElement[]): [number, number, number, number] | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const element of items) {
    for (const segment of element.segs || []) {
      for (const point of segment.p) {
        x0 = Math.min(x0, point[0]); x1 = Math.max(x1, point[0]);
        y0 = Math.min(y0, point[1]); y1 = Math.max(y1, point[1]);
      }
    }
  }
  return x1 > x0 ? [x0, y0, x1, y1] : null;
}

function CanvasArtwork({
  group,
  glyphName,
  ink,
  inkFade,
  inkColor,
  inkOpacity,
  isPlaying,
  showGrid,
  showSkeleton,
  canvasLocked,
  drawMode,
  tracePoints,
  traceEcho,
  selectedStrokes,
  marquee,
  selectedPoint,
  unitPx,
  onStartDrag,
  onTracePointerDown,
  onTracePointerMove,
  onTracePointerUp,
  onTracePointerCancel,
  svgRef,
}: {
  group: GlyphLibrary;
  glyphName: string;
  ink: RenderPath[];
  inkFade: InkFade | null;
  inkColor: string;
  inkOpacity: number;
  isPlaying: boolean;
  showGrid: boolean;
  showSkeleton: boolean;
  canvasLocked: boolean;
  drawMode: boolean;
  tracePoints: Point[];
  /** 刚落笔的那条手迹：墨线补上来的这一小会儿，它在原地淡出去。 */
  traceEcho: Point[];
  selectedStrokes: number[];
  marquee: { start: Point; end: Point } | null;
  selectedPoint: PointTarget | null;
  /** 一个用户单位等于多少屏幕像素 —— 编辑控件按屏幕尺寸画，缩放时不跟着变胖 */
  unitPx: number;
  onStartDrag: (event: React.PointerEvent<SVGElement>, target: PointTarget) => void;
  onTracePointerDown: (event: React.PointerEvent<SVGSVGElement>) => void;
  onTracePointerMove: (event: React.PointerEvent<SVGSVGElement>) => void;
  onTracePointerUp: (event: React.PointerEvent<SVGSVGElement>) => void;
  onTracePointerCancel: (event: React.PointerEvent<SVGSVGElement>) => void;
  svgRef: React.RefObject<SVGSVGElement | null>;
}) {
  const items = group.items[glyphName] || [];
  const face = faceBox(items);
  // 控件尺寸一律先写屏幕像素，再换算成用户单位
  const px = (value: number) => value / Math.max(unitPx, 0.0001);
  const anchorHalf = px(3.8);
  return (
    <svg
      ref={svgRef}
      className={`canvas-artwork ${drawMode ? "is-drawing" : ""}${canvasLocked ? " is-locked" : ""}`}
      viewBox={`0 0 ${group.vb} ${group.vb}`}
      role="img"
      aria-disabled={canvasLocked}
      aria-label={`${glyphLabel(glyphName) || "未命名空白字形"} 编辑画布`}
      style={{ pointerEvents: canvasLocked ? "none" : undefined }}
      onPointerDown={onTracePointerDown}
      onPointerMove={onTracePointerMove}
      onPointerUp={onTracePointerUp}
      onPointerCancel={onTracePointerCancel}
      onLostPointerCapture={onTracePointerCancel}
    >
      <defs dangerouslySetInnerHTML={CANVAS_BOIL_HTML} />
      {showGrid && <CanvasGrid vb={group.vb} />}
      {face && showSkeleton && (
        <rect className="canvas-face" x={face[0]} y={face[1]} width={face[2] - face[0]} height={face[3] - face[1]} />
      )}
      <g
        className={`rendered-ink${isPlaying ? " is-playing" : ""}`}
        filter={isPlaying ? "url(#preview-boil-canvas)" : undefined}
        strokeWidth={group.sw}
        style={{ color: inkColor, opacity: inkOpacity }}
      >
        {ink.map((path, pathIndex) => {
          const entering = !!inkFade?.enter.has(path.d);
          return (
            <path
              d={path.d}
              key={`${path.d}-${pathIndex}`}
              className={`${path.f ? "filled" : ""}${entering ? " ink-enter" : ""}`.trim() || undefined}
              strokeWidth={path.w ? group.sw * path.w : undefined}
            />
          );
        })}
      </g>
      {/* 被撤掉的那几笔留一份影子在原地淡出去，免得「啪」地少一笔。 */}
      {inkFade && inkFade.leave.length > 0 && (
        <g className="rendered-ink ink-ghost" strokeWidth={group.sw} style={{ color: inkColor, opacity: inkOpacity }}>
          <g className="ink-ghost-fade">
            {inkFade.leave.map((path, pathIndex) => (
              <path
                d={path.d}
                key={`ghost-${path.d}-${pathIndex}`}
                className={path.f ? "filled" : undefined}
                strokeWidth={path.w ? group.sw * path.w : undefined}
              />
            ))}
          </g>
        </g>
      )}
      {(
        <g className="skeleton-layer">
          {items.map((element, strokeIndex) => {
            const segments = element.segs;
            if (!segments) return null;
            const selected = selectedStrokes.includes(strokeIndex);
            // 保留手迹的节点是采样细节，不作为编辑锚点；整笔仍可拖动。
            const canEditPoints = element.traceMode !== "original";
            const d = pathD(segments);
            return (
              <React.Fragment key={`stroke-${strokeIndex}`}>
                {(showSkeleton || selected) && (
                  <>
                    <path className={`skeleton-path ${selected ? "selected" : ""}`} d={d} />
                  </>
                )}
                <path
                  data-stroke-index={strokeIndex}
                  className="skeleton-hit"
                  d={d}
                  onPointerDown={(event) => onStartDrag(event, { si: strokeIndex })}
                />
                {showSkeleton && selected && canEditPoints && selectedStrokes.length === 1 && segments.map((segment, segmentIndex) => {
                  const end = segment.p[segment.p.length - 1];
                  if (!end || segment.c === "Z") return null;
                  const active = selectedPoint?.si === strokeIndex
                    && selectedPoint.gi === segmentIndex;
                  const anchorProps = {
                    className: `anchor-point ${segment.c === "Q" || segment.c === "C" ? "anchor-point--curve" : "anchor-point--corner"} ${segment.c === "M" ? "anchor-point--start" : ""} ${active ? "active" : ""}`,
                    onPointerDown: (event: React.PointerEvent<SVGElement>) => onStartDrag(event, { si: strokeIndex, gi: segmentIndex }),
                  };
                  return (
                    <React.Fragment key={`segment-${segmentIndex}`}>
                      {segment.c === "Q" || segment.c === "C" ? (
                        <circle {...anchorProps} cx={end[0]} cy={end[1]} r={anchorHalf} />
                      ) : (
                        <rect
                          {...anchorProps}
                          x={end[0] - anchorHalf}
                          y={end[1] - anchorHalf}
                          width={anchorHalf * 2}
                          height={anchorHalf * 2}
                          rx={px(1.1)}
                        />
                      )}
                    </React.Fragment>
                  );
                })}
              </React.Fragment>
            );
          })}
        </g>
      )}
      {marquee && <rect className="selection-marquee" x={Math.min(marquee.start[0], marquee.end[0])} y={Math.min(marquee.start[1], marquee.end[1])} width={Math.abs(marquee.end[0] - marquee.start[0])} height={Math.abs(marquee.end[1] - marquee.start[1])} />}
      {traceEcho.length > 1 && (
        <path className="draw-trace draw-trace--echo" d={traceInkD(traceEcho, group.sw)} />
      )}
      {drawMode && tracePoints.length > 1 && (
        <path className="draw-trace" d={traceInkD(tracePoints, group.sw)} />
      )}
    </svg>
  );
}

/* 排序只改变左侧列表；画布的视觉输入没有变化时跳过整棵 SVG 的重绘。 */
const MemoCanvasArtwork = React.memo(CanvasArtwork, (previous, next) => (
  previous.group === next.group
  && previous.glyphName === next.glyphName
  && previous.ink === next.ink
  && previous.inkFade === next.inkFade
  && previous.inkColor === next.inkColor
  && previous.inkOpacity === next.inkOpacity
  && previous.isPlaying === next.isPlaying
  && previous.showGrid === next.showGrid
  && previous.showSkeleton === next.showSkeleton
  && previous.canvasLocked === next.canvasLocked
  && previous.drawMode === next.drawMode
  && previous.tracePoints === next.tracePoints
  && previous.traceEcho === next.traceEcho
  && previous.selectedStrokes === next.selectedStrokes
  && previous.marquee === next.marquee
  && previous.selectedPoint === next.selectedPoint
  && previous.unitPx === next.unitPx
  && previous.svgRef === next.svgRef
));

/** 画布下方那条工具条上的按钮。 */
function ToolButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
      <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <button className={`tool-toggle${active ? " on" : ""}`} onClick={onClick} aria-label={label} aria-pressed={active}>
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" sideOffset={8}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

/** One pointer gesture is one history entry, regardless of render frequency. */
function useGeometryHistory() {
  const [geo, publish] = React.useState<GeoPayload | null>(null);
  const current = React.useRef<GeoPayload | null>(null);
  const past = React.useRef<GeoPayload[]>([]);
  const future = React.useRef<GeoPayload[]>([]);
  const gesture = React.useRef(false);
  const recorded = React.useRef(false);

  React.useEffect(() => {
    const begin = () => { gesture.current = true; recorded.current = false; };
    const end = () => { gesture.current = false; recorded.current = false; };
    document.addEventListener("pointerdown", begin, true);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      document.removeEventListener("pointerdown", begin, true);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, []);

  const setGeo = React.useCallback((action: React.SetStateAction<GeoPayload | null>) => {
    const previous = current.current;
    const next = typeof action === "function" ? action(previous) : action;
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    if (previous && (!gesture.current || !recorded.current)) {
      past.current.push(previous);
      if (past.current.length > 100) past.current.shift();
      recorded.current = true;
    }
    future.current = [];
    current.current = next;
    publish(next);
  }, []);

  const restore = React.useCallback((redo: boolean) => {
    // Finish the active gesture before restoring its geometry.
    if (gesture.current) return null;
    const source = redo ? future.current : past.current;
    const destination = redo ? past.current : future.current;
    const next = source.pop();
    if (!next || !current.current) return null;
    destination.push(current.current);
    current.current = next;
    publish(next);
    return next;
  }, []);
  return { geo, setGeo, restore };
}

export default function EditorApp() {
  const { geo, setGeo, restore } = useGeometryHistory();
  const [savedPreviewGlyphs, setSavedPreviewGlyphs] = React.useState<GlyphLibrary | null>(null);
  const savedGlyphsRef = React.useRef<GlyphLibrary | null>(null);
  const [hasUnsavedChanges, setHasUnsavedChanges] = React.useState(false);
  const [glyphName, setGlyphName] = React.useState("");
  const [ink, setInk] = React.useState<RenderPath[]>([]);
  const [inkFade, setInkFade] = React.useState<InkFade | null>(null);
  const [traceEcho, setTraceEcho] = React.useState<Point[]>([]);
  const [inkPreferences, setInkPreferences] = React.useState<Record<string, InkStyle>>({});
  const [colorPreferencesReady, setColorPreferencesReady] = React.useState(false);
  const [rowResult, setRowResult] = React.useState<RowResult | null>(null);
  const [selectedStrokes, setSelectedStrokes] = React.useState<number[]>([]);
  const [marquee, setMarquee] = React.useState<{ start: Point; end: Point } | null>(null);
  const marqueeRef = React.useRef<{ start: Point; base: number[]; pointerId: number; client: Point; active: boolean } | null>(null);
  const [selectedPoint, setSelectedPoint] = React.useState<PointTarget | null>(null);
  const [drawMode, setDrawModeState] = React.useState(false);
  const [traceMode, setTraceMode] = React.useState<"smart" | "original">("smart");
  const [tracePoints, setTracePoints] = React.useState<Point[]>([]);
  const [traceStatus, setTraceStatus] = React.useState("");
  const [showGrid, setShowGrid] = React.useState(true);
  const [showSkeleton, setShowSkeleton] = React.useState(true);
  const [underlay, setUnderlay] = React.useState(true);
  const [referenceText, setReferenceText] = React.useState("");
  const [referenceFont, setReferenceFont] = React.useState<string>(REFERENCE_FONTS[0].value);
  const [zoom, setZoom] = React.useState(1);
  const [previewPlaying, setPreviewPlaying] = React.useState(false);
  const [viewSeed, setViewSeed] = React.useState(DEFAULT_VIEW_SEED);
  const [rowOpen, setRowOpen] = React.useState(true);
  const [rowTrack, setRowTrack] = React.useState(DEFAULT_ROW_TRACK);
  // 右栏的预览种子、排版文本/模式也属于字库配置；它们不再只存在于会话状态。
  const [liveAdvances, setLiveAdvances] = React.useState<Record<string, number>>({});
  const [showcase, setShowcase] = React.useState<{ svg: string; ratio: number } | null>(null);
  const [metricsOpen, setMetricsOpen] = React.useState(false);
  const [dragName, setDragName] = React.useState<string | null>(null);
  const [dragOrder, setDragOrder] = React.useState<string[] | null>(null);
  const glyphDragRef = React.useRef<GlyphDragState | null>(null);
  const glyphRowRefs = React.useRef(new Map<string, HTMLDivElement>());
  const glyphRowMotion = React.useRef(new Map<string, {
    row: HTMLDivElement;
    frame: number | null;
    timer: number | null;
  }>());
  const glyphRowFirstRects = React.useRef<Map<string, DOMRect> | null>(null);
  const referenceInputRef = React.useRef<HTMLInputElement | null>(null);
  const [viewHeight] = React.useState(44);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [batchAddMenu, setBatchAddMenu] = React.useState<{ x: number; y: number } | null>(null);
  const [batchAddOpen, setBatchAddOpen] = React.useState(false);
  const [batchAddText, setBatchAddText] = React.useState("");
  const [batchAddError, setBatchAddError] = React.useState("");
  const [viewportHeight, setViewportHeight] = React.useState(760);
  const [viewportWidth, setViewportWidth] = React.useState(760);
  const [leftOpen, setLeftOpen] = React.useState(true);
  const [rightOpen, setRightOpen] = React.useState(true);
  const [openSections, setOpenSections] = React.useState<Record<string, boolean>>({
    library: true,
    layout: true,
    color: true,
    strokes: true,
    libraryGlyphs: true,
    glyph: true,
    craft: true,
    seed: true,
    export: false,
  });
  const [libraryRevision, setLibraryRevision] = React.useState(0);
  const libraryFileRef = React.useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState("");
  const [exportScope, setExportScope] = React.useState<ExportScope>("row");
  const [exportFormat, setExportFormat] = React.useState<ExportFormat>("png");
  const [exportScale, setExportScale] = React.useState<string>("1");
  const [exportBusy, setExportBusy] = React.useState(false);
  const [exportMessage, setExportMessage] = React.useState("");
  const [saveToastOpen, setSaveToastOpen] = React.useState(false);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const helpRef = React.useRef<HTMLDivElement | null>(null);
  const batchAddMenuRef = React.useRef<HTMLDivElement | null>(null);
  const addMenuClickTimerRef = React.useRef<number | null>(null);
  const tracePointerIdRef = React.useRef<number | null>(null);
  const tracePointsRef = React.useRef<Point[]>([]);
  /** 笔画风格只在落笔那一刻算：跟着 items 走每次拖动都要重扫整个字库。 */
  const strokeStyleRef = React.useRef<{ items: unknown; vb: number; style: StrokeStyle } | null>(null);
  const exportActionRef = React.useRef<(() => Promise<void>) | null>(null);
  const legacyInkStyleRef = React.useRef<InkStyle | null>(null);
  const canvasDirtyRef = React.useRef(false);
  const rightPanelSaveTimerRef = React.useRef<number | null>(null);
  const rightPanelSaveTargetRef = React.useRef<GeoPayload | null>(null);
  const rightPanelSaveInFlightTargetRef = React.useRef<GeoPayload | null>(null);
  const rightPanelSaveInFlightRef = React.useRef(false);
  const saveToastTimerRef = React.useRef<number | null>(null);

  const glyphs = geo?.glyphs;
  const group = glyphs;
  const geoRef = React.useRef<GeoPayload | null>(geo);
  geoRef.current = geo;
  const names = glyphs ? Object.keys(glyphs.items) : [];
  const hasDraftGlyph = names.some((name) => isDraftGlyph(name));
  const referenceNeedsEntry = hasDraftGlyph && !firstReferenceCharacter(referenceText);
  const glyphIndex = Math.max(0, names.indexOf(glyphName));
  const currentItems = glyphs?.items[glyphName] || [];
  const isLatinLayout = libraryIsLatin(glyphs);
  const isCurrentGlyphLatin = isLatinLayout;
  const currentInkKey = geo?.file && glyphName
    ? inkPreferenceKey(geo.file, glyphName)
    : "";
  const inkStyleFor = React.useCallback((name: string): InkStyle => {
    if (!geo?.file || !name) return DEFAULT_INK_STYLE;
    return inkPreferences[inkPreferenceKey(geo.file, name)] || DEFAULT_INK_STYLE;
  }, [geo?.file, inkPreferences]);
  const currentInkStyle = currentInkKey ? inkPreferences[currentInkKey] : undefined;
  const inkColor = currentInkStyle?.color || DEFAULT_INK_COLOR;
  const inkOpacity = currentInkStyle?.opacity ?? DEFAULT_INK_OPACITY;
  const rowInkStyles = React.useMemo(() => (
    rowResult?.table.flatMap((cell) => cell.name ? [inkStyleFor(cell.name)] : []) || []
  ), [rowResult, inkStyleFor]);
  const visibleNames = dragOrder || names;
  const glyphOrderKey = visibleNames.join("\u0000");

  /* 用 FLIP 让被挤开的行走一小段柔和的位移，而不是 React 重新排键后
     直接瞬移。用 CSS transition 而不是逐个堆 Web Animations，兼容编辑器
     内嵌浏览器，也能在下一次 dragover 到来前干净地收掉上一段位移。 */
  React.useLayoutEffect(() => {
    const firstRects = glyphRowFirstRects.current;
    if (!firstRects) return;
    glyphRowFirstRects.current = null;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    for (const [name, first] of firstRects) {
      const row = glyphRowRefs.current.get(name);
      if (!row) continue;
      const last = row.getBoundingClientRect();
      const deltaY = first.top - last.top;
      if (Math.abs(deltaY) < 0.5) continue;
      row.style.transition = "none";
      row.style.transform = `translate3d(0, ${deltaY.toFixed(2)}px, 0)`;
      const motion = { row, frame: null as number | null, timer: null as number | null };
      motion.frame = window.requestAnimationFrame(() => {
        if (glyphRowMotion.current.get(name) !== motion) return;
        row.style.transition = "transform 150ms cubic-bezier(0.2, 0.7, 0.2, 1)";
        row.style.transform = "translate3d(0, 0, 0)";
        motion.timer = window.setTimeout(() => {
          if (glyphRowMotion.current.get(name) !== motion) return;
          row.style.transition = "";
          row.style.transform = "";
          glyphRowMotion.current.delete(name);
        }, 220);
      });
      glyphRowMotion.current.set(name, motion);
    }
  }, [glyphOrderKey]);

  React.useEffect(() => () => {
    for (const motion of glyphRowMotion.current.values()) {
      if (motion.frame !== null) window.cancelAnimationFrame(motion.frame);
      if (motion.timer !== null) window.clearTimeout(motion.timer);
      motion.row.style.transition = "";
      motion.row.style.transform = "";
    }
    glyphRowMotion.current.clear();
  }, []);

  // 创建空白字形后，把下一步变成一个可见的交互状态：输入框自动接焦，
  // 空值时高亮；输入第一个字后状态自然解除，不依赖说明文字。
  React.useEffect(() => {
    if (!referenceNeedsEntry) return;
    const frame = window.requestAnimationFrame(() => {
      const input = referenceInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [referenceNeedsEntry]);

  const confirmNavigation = React.useCallback(() => {
    const saved = savedGlyphsRef.current;
    const current = geo?.glyphs;
    // 右栏的持久化设置会自动保存，所以不会阻挡切换；画布拖拽/描摹即使
    // 恰好遇到一次右栏自动保存，也仍然保留“未保存修改”的提示。
    const currentGlyphChanged = canvasDirtyRef.current || (hasUnsavedChanges && saved && current && glyphName
      ? !sameGlyphSnapshot(current, saved, glyphName) || !sameGlyphSettings(current, saved)
      : hasUnsavedChanges);
    if (!currentGlyphChanged) return true;
    if (!window.confirm("当前字形有未保存的修改，确定要切换吗？")) return false;

    if (saved && current && glyphName) {
      const restored = restoreGlyphFromSnapshot(current, saved, glyphName);
      setGeo((previous) => previous ? { ...previous, glyphs: restored } : previous);
      canvasDirtyRef.current = false;
      setHasUnsavedChanges(!sameGlyphLibrary(restored, saved));
    }
    return true;
  }, [geo, glyphName, hasUnsavedChanges, setGeo]);

  React.useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      (event as unknown as { returnValue: string }).returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  React.useEffect(() => {
    try {
      const savedTraceMode = window.localStorage.getItem("hg-trace-mode");
      if (savedTraceMode === "smart" || savedTraceMode === "original") setTraceMode(savedTraceMode);
      const stored = JSON.parse(window.localStorage.getItem(PANEL_STORAGE_KEY) || "null");
      if (stored && typeof stored === "object") {
        if (typeof stored.left === "boolean") setLeftOpen(stored.left);
        if (typeof stored.right === "boolean") setRightOpen(stored.right);
      }
    } catch { /* 本地存储不可用时保持默认展开 */ }
  }, []);

  React.useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify({ left: leftOpen, right: rightOpen }));
    } catch { /* 忽略写入失败 */ }
  }, [leftOpen, rightOpen]);

  React.useEffect(() => {
    let preferences: Record<string, InkStyle> = {};
    try {
      const stored = JSON.parse(window.localStorage.getItem(COLOR_STORAGE_KEY) || "null") as unknown;
      if (stored && typeof stored === "object") {
        for (const [key, value] of Object.entries(stored)) {
          const style = readInkStyle(value);
          if (style) {
            const parts = key.split("\u0000");
            // 兼容移除字库组之前写入的 file\0group\0glyph 键。
            const normalizedKey = parts.length === 3 ? inkPreferenceKey(parts[0], parts[2]) : key;
            preferences[normalizedKey] = style;
          }
        }
      }
      legacyInkStyleRef.current = readInkStyle(JSON.parse(window.localStorage.getItem(LEGACY_COLOR_STORAGE_KEY) || "null"));
    } catch { /* 本地存储不可用时保持默认颜色 */ }
    setInkPreferences(preferences);
    setColorPreferencesReady(true);
  }, []);

  React.useEffect(() => {
    if (!colorPreferencesReady) return;
    const legacy = legacyInkStyleRef.current;
    if (currentInkKey && legacy && !inkPreferences[currentInkKey]) {
      setInkPreferences((previous) => ({ ...previous, [currentInkKey]: legacy }));
      legacyInkStyleRef.current = null;
      try { window.localStorage.removeItem(LEGACY_COLOR_STORAGE_KEY); } catch { /* 忽略清理失败 */ }
      return;
    }
  }, [colorPreferencesReady, currentInkKey, inkPreferences]);

  React.useEffect(() => {
    if (!colorPreferencesReady) return;
    try {
      window.localStorage.setItem(COLOR_STORAGE_KEY, JSON.stringify(inkPreferences));
    } catch { /* 忽略写入失败 */ }
  }, [colorPreferencesReady, inkPreferences]);

  /* ── 工程文件 ──────────────────────────────────────────────
     只有一份工作文档：浏览器里留一个槽位防手滑关标签页，要带走、要回来
     走「下载 / 打开工程文件」。没有字库列表，也没有内置模板可切换。 */
  const reloadDocument = React.useCallback(() => {
    setLoading(true);
    setError("");
    setLibraryRevision((value) => value + 1);
  }, []);

  /* 新建永远从预设开始（汉字 2.8 / 拉丁 3.2，手感都是 0.9），
     不带上一份的任何东西。版式在这一步定死写进文件 —— 空库没有字形可推断。 */
  const handleDocumentNew = React.useCallback((mode: "han" | "latin") => {
    if (!window.confirm("新建会清掉当前这一份。没下载过的话就找不回来了，确定？")) return;
    if (!confirmNavigation()) return;
    createDocument(mode);
    reloadDocument();
  }, [confirmNavigation, reloadDocument]);

  const handleDocumentOpen = React.useCallback(async (file: File | null | undefined) => {
    if (!file) return;
    try {
      const text = await file.text();
      if (!window.confirm(`打开「${file.name}」会替换当前这一份，确定？`)) return;
      importDocument(file.name, text);
      reloadDocument();
    } catch (reason) {
      setError(reason instanceof Error ? `这份文件不是几何 JSON：${reason.message}` : "打开失败");
    }
  }, [reloadDocument]);

  React.useEffect(() => {
    requestJSON<GeoPayload>("/api/geo")
      .then((payload) => {
        const firstGlyph = Object.keys(payload.glyphs?.items || {})[0] || "";
        const savedGlyphs = clone(payload.glyphs);
        const editor = readEditorConfig(payload.glyphs?.editor);
        setGeo(payload);
        savedGlyphsRef.current = savedGlyphs;
        setSavedPreviewGlyphs(savedGlyphs);
        canvasDirtyRef.current = false;
        rightPanelSaveTargetRef.current = null;
        rightPanelSaveInFlightTargetRef.current = null;
        setHasUnsavedChanges(false);
        setGlyphName(firstGlyph);
        setLiveAdvances({});
        setReferenceText(glyphInfo(firstGlyph).base);
        setRowTrack(Number.isFinite(Number(payload.glyphs?.track))
          ? Number(payload.glyphs.track)
          : libraryIsLatin(payload.glyphs) ? DEFAULT_ROW_TRACK : DEFAULT_HAN_ROW_TRACK);
        /* 换一份工程就是换一套设置：新文件没写的字段要回默认，不能沿用上一份。
           不复位的话，新建的空库会顶着上一份的种子开局。 */
        setExportScope(editor.export?.scope ?? "row");
        setExportFormat(editor.export?.format ?? "png");
        setExportScale(editor.export?.scale ?? "1");
        setInkPreferences((previous) => {
          const next = { ...previous };
          for (const [name, style] of Object.entries(editor.ink || {})) {
            next[inkPreferenceKey(payload.file, name)] = style;
          }
          return next;
        });
        const savedSeed = readGlyphSeed(payload.glyphs?.seed);
        setViewSeed(savedSeed !== null ? Math.max(1, Math.min(999, savedSeed)) : DEFAULT_VIEW_SEED);
        setLoading(false);
      })
      .catch((reason: Error) => {
        setLoading(false);
        setError(reason.message);
      });
  }, [libraryRevision]);

  React.useEffect(() => {
    if (!geo?.glyphs) return;
    setRowTrack(Number.isFinite(Number(geo.glyphs.track))
      ? Number(geo.glyphs.track)
      : isLatinLayout ? DEFAULT_ROW_TRACK : DEFAULT_HAN_ROW_TRACK);
  }, [geo?.glyphs?.track]);

  /* 渲染调度（对齐老版 schedule()）：
     - 骨架和锚点是本地状态，React 直接重画，拖动永远跟手；
     - 墨线要过一遍滤镜（现在就在本地跑，一个字不到 1ms），这里仍然节流而不是
       防抖 —— 防抖会被下一次输入重置，连续拖的时候一次都不算，手停了才出图；
     - 同时只允许一个请求在飞，飞行期间的输入只保留最新的一份，回来后立刻补发；
     - 用序号丢弃过期响应，避免乱序把旧的墨线画上去。 */
  const currentRenderBody = glyphs && glyphName ? renderBody(glyphs, glyphName, glyphIndex) : "";
  const renderDesiredRef = React.useRef(currentRenderBody);
  renderDesiredRef.current = currentRenderBody;
  const renderSeqRef = React.useRef(0);
  const renderPendingRef = React.useRef<string | null>(null);
  const renderInFlightRef = React.useRef(false);
  const renderTimerRef = React.useRef<number | null>(null);
  const renderLastSentRef = React.useRef<string>("");
  const renderErroredRef = React.useRef(false);

  /* 墨线换新的那一刻，把「刚长出来的」和「刚被撤掉的」分出来。
     只有描摹落笔和撤销/重做会打开这个开关 —— 拖锚点那种连续改动每帧都在换 d，
     一路淡入的话整个字都在闪。淡入的 class 必须和新墨线同一次提交上屏，
     放进 effect 里补的话中间会先满墨闪一帧。 */
  const inkFadeWantedRef = React.useRef(0);
  const inkFadeTimerRef = React.useRef<number | null>(null);
  const previousInkRef = React.useRef<RenderPath[]>([]);

  const applyInk = React.useCallback((paths: RenderPath[]) => {
    const previous = previousInkRef.current;
    previousInkRef.current = paths;
    setInk(paths);
    if (inkFadeTimerRef.current !== null) {
      window.clearTimeout(inkFadeTimerRef.current);
      inkFadeTimerRef.current = null;
    }
    // 开关是个时间戳：撤销的那一步万一没改到这个字的墨线，这一次请求就作废，
    // 不能留着让下一次无关的重画淡入淡出。
    const wanted = inkFadeWantedRef.current;
    inkFadeWantedRef.current = 0;
    if (!wanted || performance.now() - wanted > 1000) { setInkFade(null); return; }
    const before = new Set(previous.map((path) => path.d));
    const after = new Set(paths.map((path) => path.d));
    const enter = new Set(paths.filter((path) => !before.has(path.d)).map((path) => path.d));
    const leave = previous.filter((path) => !after.has(path.d));
    if (!enter.size && !leave.length) { setInkFade(null); return; }
    setInkFade({ enter, leave });
    inkFadeTimerRef.current = window.setTimeout(() => {
      inkFadeTimerRef.current = null;
      setInkFade(null);
    }, INK_FADE_MS);
  }, []);

  React.useEffect(() => () => {
    if (inkFadeTimerRef.current !== null) window.clearTimeout(inkFadeTimerRef.current);
  }, []);

  /** 错误提示自己退场，不然一条渲染失败会一直挂在屏幕底下。 */
  React.useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(""), 5200);
    return () => window.clearTimeout(timer);
  }, [error]);

  const flushRender = React.useCallback(async (body: string) => {
    const seq = ++renderSeqRef.current;
    renderInFlightRef.current = true;
    renderLastSentRef.current = body;
    try {
      const payload = await requestJSON<{ paths: RenderPath[] }>("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (seq !== renderSeqRef.current || body !== renderDesiredRef.current) return;      // 过期响应，丢掉
      const paths = payload.paths || [];
      applyInk(paths);
      cacheThumb(body, paths);                       // 主画布这一版顺手喂给左栏缩略图
      // 只清掉渲染自己报的错。
      if (renderErroredRef.current) { renderErroredRef.current = false; setError(""); }
    } catch (reason) {
      if (seq === renderSeqRef.current && body === renderDesiredRef.current) {
        renderErroredRef.current = true;
        setError(reason instanceof Error ? reason.message : "渲染失败");
      }
    } finally {
      renderInFlightRef.current = false;
      const next = renderPendingRef.current;
      renderPendingRef.current = null;
      if (next && next !== body) void flushRender(next);
    }
  }, [applyInk]);

  const scheduleRender = React.useCallback((body: string) => {
    if (body === renderLastSentRef.current && !renderPendingRef.current) return;
    renderPendingRef.current = body;
    if (renderInFlightRef.current || renderTimerRef.current !== null) return;
    renderTimerRef.current = window.setTimeout(() => {
      renderTimerRef.current = null;
      const next = renderPendingRef.current;
      renderPendingRef.current = null;
      if (next) void flushRender(next);
    }, 24);
  }, [flushRender]);

  // 请求体是字符串：内容没变就不会触发，比依赖 glyphs / currentItems 这些
  // 每帧都换引用的对象稳得多


  React.useEffect(() => {
    if (!currentRenderBody) return;
    // 单字渲染是确定性的（同骨架 + 同种子 = 同一条路径），命中缓存就不必再问一次
    const cached = thumbCache.get(currentRenderBody);
    if (cached) {
      applyInk(cached);
      renderLastSentRef.current = currentRenderBody;
      return;
    }
    scheduleRender(currentRenderBody);
  }, [applyInk, currentRenderBody, scheduleRender]);

  /* 行预览：整行要重排，比单字贵得多，所以节流请求，只保留最新一版。
     依赖同样收敛成字符串，拖动时也能持续更新，但不会堆积请求。 */
  /* 照搬老版 rowText()：从 write 进来就排那一行（去掉 / 和换行），
     否则把这一组的字形按顺序全排一遍 —— 不去重，所以 露2、枝2 会再出现一次，
     由 row.pick 的叠字轮换决定用哪一份写法。 */
  const defaultRowLine = names.filter((name) => !isDraftGlyph(name)).map((name) => glyphInfo(name).base).join("");
  /* 行预览永远等于你画的顺序。自定义文本删掉了：同一个字出现两次时，
     用哪一份是 pick() 按变体顺序轮换的 —— 规则确定，但用户看不见，
     看不见的规则比没有规则更糟。所见即所得，歧义自己消失。 */
  const rowLine = defaultRowLine;
  const rowPreviewItems = Object.fromEntries(
    names.filter((name) => !isDraftGlyph(name)).map((name) => {
      const savedItems = savedPreviewGlyphs?.items[name] || glyphs?.items[name] || [];
      const liveAdvance = liveAdvances[name] ?? glyphs?.items[name]?.[0]?.adv;
      const items = isLatinLayout && savedItems[0] && liveAdvance !== undefined
        ? [{ ...savedItems[0], adv: liveAdvance }, ...savedItems.slice(1)]
        : savedItems;
      return [name, items];
    }),
  );
  const rowBody = rowLine && glyphs ? JSON.stringify({
    glyphData: {
      vb: glyphs.vb,
      sw: glyphs.sw,
      // Structural edits stay on the main canvas until a save succeeds.
      items: rowPreviewItems,
      glyphSeeds: glyphs.glyphSeeds,
    },
    text: rowLine,
    seed: viewSeed,
    track: rowTrack,
    ampk: glyphs.jit,
    mode: isLatinLayout ? "latin" : "han",
    amp: glyphs.amp,
    over: glyphs.over,
    vary: true,
    varyk: glyphs.vary,
    glyphSeeds: glyphs.glyphSeeds,
  }) : "";

  const rowDesiredRef = React.useRef(rowBody);
  rowDesiredRef.current = rowBody;
  const rowSeqRef = React.useRef(0);
  const rowPendingRef = React.useRef<string | null>(null);
  const rowInFlightRef = React.useRef(false);
  const rowTimerRef = React.useRef<number | null>(null);
  const rowLastSentRef = React.useRef("");

  const flushRow = React.useCallback(async (body: string) => {
    const seq = ++rowSeqRef.current;
    rowInFlightRef.current = true;
    rowLastSentRef.current = body;
    try {
      const payload = await requestJSON<RowResult>("/api/row", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (seq === rowSeqRef.current && body === rowDesiredRef.current) setRowResult(payload);
    } catch {
      if (seq === rowSeqRef.current && body === rowDesiredRef.current) {
        rowLastSentRef.current = "";
        setRowResult(null);
      }
    } finally {
      rowInFlightRef.current = false;
      const next = rowPendingRef.current;
      rowPendingRef.current = null;
      if (next && next !== body) void flushRow(next);
    }
  }, []);

  const scheduleRow = React.useCallback((body: string) => {
    if (body === rowLastSentRef.current && !rowPendingRef.current) return;
    rowPendingRef.current = body;
    if (rowInFlightRef.current || rowTimerRef.current !== null) return;
    rowTimerRef.current = window.setTimeout(() => {
      rowTimerRef.current = null;
      const next = rowPendingRef.current;
      rowPendingRef.current = null;
      if (next) void flushRow(next);
    }, 24);
  }, [flushRow]);

  React.useEffect(() => () => {
    rowSeqRef.current += 1;
    rowPendingRef.current = null;
    if (rowTimerRef.current !== null) window.clearTimeout(rowTimerRef.current);
    rowTimerRef.current = null;
  }, []);

  React.useEffect(() => {
    if (!rowBody) {
      rowSeqRef.current += 1;
      rowPendingRef.current = null;
      rowLastSentRef.current = "";
      if (rowTimerRef.current !== null) window.clearTimeout(rowTimerRef.current);
      rowTimerRef.current = null;
      setRowResult(null);
      return;
    }
    scheduleRow(rowBody);
  }, [rowBody, scheduleRow]);

  const updateGlyphs = React.useCallback((patch: Partial<GlyphLibrary>) => {
    setHasUnsavedChanges(true);
    setGeo((previous) => {
      if (!previous?.glyphs) return previous;
      return {
        ...previous,
        glyphs: { ...previous.glyphs, ...patch },
      };
    });
  }, []);

  const updateItems = React.useCallback((updater: (items: EditableElement[]) => EditableElement[]) => {
    canvasDirtyRef.current = true;
    setHasUnsavedChanges(true);
    setGeo((previous) => {
      if (!previous?.glyphs || !glyphName) return previous;
      const currentGlyphs = previous.glyphs;
      return {
        ...previous,
        glyphs: {
          ...currentGlyphs,
          items: {
            ...currentGlyphs.items,
            [glyphName]: updater(clone(currentGlyphs.items[glyphName] || [])),
          },
        },
      };
    });
  }, [glyphName]);

  const savedAdvance = Number.isFinite(Number(currentItems[0]?.adv))
    ? Number(currentItems[0]?.adv)
    : DEFAULT_LATIN_ADV;
  const currentAdvance = liveAdvances[glyphName] ?? savedAdvance;

  const setGlyphAdvance = (value: number) => {
    if (!isCurrentGlyphLatin || !geo?.glyphs || !glyphName) return;
    const next = Number(value.toFixed(1));
    setLiveAdvances((previous) => {
      const nextValues = { ...previous };
      if (Math.abs(next - savedAdvance) < 1e-9) delete nextValues[glyphName];
      else nextValues[glyphName] = next;
      return nextValues;
    });
    updateItemsAndSave((items) => {
      const first = items[0];
      if (!first) return items;
      items[0] = { ...first, adv: next };
      return items;
    });
  };

  /** 老版的吸附：默认落在 0.5 格上，按住 Alt 自由放置。 */
  const snap = (value: number, free: boolean) => free ? Math.round(value * 100) / 100 : Math.round(value * 2) / 2;

  const toUnit = (clientX: number, clientY: number): Point | null => {
    const svg = svgRef.current;
    if (!svg || !group) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return [
      ((clientX - rect.left) / rect.width) * group.vb,
      ((clientY - rect.top) / rect.height) * group.vb,
    ];
  };

  /** 从当前字库现学写法：横竖偏几度、折角圆多大，都照着已有笔画来。 */
  const strokeStyleNow = () => {
    if (!glyphs) return BASE_STYLE;
    const cached = strokeStyleRef.current;
    if (cached && cached.items === glyphs.items && cached.vb === glyphs.vb) return cached.style;
    const style = learnStrokeStyle(glyphs.items, glyphs.vb);
    strokeStyleRef.current = { items: glyphs.items, vb: glyphs.vb, style };
    return style;
  };

  const traceEchoTimerRef = React.useRef<number | null>(null);
  const startTraceEcho = (points: Point[]) => {
    if (traceEchoTimerRef.current !== null) window.clearTimeout(traceEchoTimerRef.current);
    setTraceEcho(points);
    traceEchoTimerRef.current = window.setTimeout(() => {
      traceEchoTimerRef.current = null;
      setTraceEcho([]);
    }, INK_FADE_MS);
  };
  React.useEffect(() => () => {
    if (traceEchoTimerRef.current !== null) window.clearTimeout(traceEchoTimerRef.current);
  }, []);

  const clearTrace = () => {
    const pointerId = tracePointerIdRef.current;
    if (pointerId !== null && svgRef.current?.hasPointerCapture(pointerId)) {
      try { svgRef.current.releasePointerCapture(pointerId); } catch { /* 已经释放 */ }
    }
    tracePointerIdRef.current = null;
    tracePointsRef.current = [];
    setTracePoints([]);
  };

  const setDrawMode = (on: boolean) => {
    if (on && referenceNeedsEntry) return;
    if (!on) clearTrace();
    setDrawModeState(on);
    setTraceStatus("");
    if (on) {
      setSelectedPoint(null);
    }
  };

  /** 两个按钮既是落笔方式也是开关：点正在用的那种就收笔。 */
  const pickTraceMode = (mode: "smart" | "original") => {
    if (referenceNeedsEntry) return;
    if (drawMode && traceMode === mode) { setDrawMode(false); return; }
    clearTrace();
    setTraceMode(mode);
    try { window.localStorage.setItem("hg-trace-mode", mode); } catch { /* Keep session preference. */ }
    setDrawMode(true);
  };

  const tracePointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (referenceNeedsEntry) return;
    if (!drawMode) {
      if (event.button !== 0 || marqueeRef.current) return;
      const start = toUnit(event.clientX, event.clientY);
      if (!start) return;
      event.preventDefault();
      marqueeRef.current = { start, base: event.shiftKey ? selectedStrokes : [], pointerId: event.pointerId, client: [event.clientX, event.clientY], active: false };
      setSelectedPoint(null);
      if (!event.shiftKey) setSelectedStrokes([]);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (event.button !== 0 || tracePointerIdRef.current !== null) return;
    const point = toUnit(event.clientX, event.clientY);
    if (!point || !group) return;
    event.preventDefault();
    event.stopPropagation();
    const bounded: Point = [
      Math.max(0, Math.min(group.vb, point[0])),
      Math.max(0, Math.min(group.vb, point[1])),
    ];
    tracePointerIdRef.current = event.pointerId;
    tracePointsRef.current = [bounded];
    setTracePoints([bounded]);
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* 浏览器不支持时仍可完成描摹 */ }
    setTraceStatus(traceMode === "smart" ? "正在描摹… 松开后智能识别" : "正在描摹… 松开后保留手迹");
  };

  const updateMarquee = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = marqueeRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const end = toUnit(event.clientX, event.clientY);
    if (!end) return;
    if (!drag.active && pointDistance(drag.client, [event.clientX, event.clientY]) < 3) return;
    drag.active = true;
    setMarquee({ start: drag.start, end });
    const x0 = Math.min(drag.start[0], end[0]), x1 = Math.max(drag.start[0], end[0]);
    const y0 = Math.min(drag.start[1], end[1]), y1 = Math.max(drag.start[1], end[1]);
    const hits: number[] = [];
    svgRef.current?.querySelectorAll<SVGPathElement>("[data-stroke-index]").forEach((path) => {
      const box = path.getBBox();
      if (box.x <= x1 && box.x + box.width >= x0 && box.y <= y1 && box.y + box.height >= y0) hits.push(Number(path.dataset.strokeIndex));
    });
    setSelectedStrokes([...new Set([...drag.base, ...hits])]);
  };

  const clearMarquee = (cancel = false) => {
    const drag = marqueeRef.current;
    if (!drag) return;
    marqueeRef.current = null;
    if (cancel) setSelectedStrokes(drag.base);
    setMarquee(null);
    if (svgRef.current?.hasPointerCapture(drag.pointerId)) svgRef.current.releasePointerCapture(drag.pointerId);
  };

  const tracePointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    if (marqueeRef.current) { updateMarquee(event); return; }
    if (!drawMode || event.pointerId !== tracePointerIdRef.current || !group) return;
    const point = toUnit(event.clientX, event.clientY);
    if (!point) return;
    const bounded: Point = [
      Math.max(0, Math.min(group.vb, point[0])),
      Math.max(0, Math.min(group.vb, point[1])),
    ];
    const previous = tracePointsRef.current[tracePointsRef.current.length - 1];
    if (previous && pointDistance(bounded, previous) < 0.16) return;
    const next = [...tracePointsRef.current, bounded];
    tracePointsRef.current = next;
    setTracePoints(next);
  };

  const tracePointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    if (marqueeRef.current?.pointerId === event.pointerId) { updateMarquee(event); clearMarquee(); return; }
    if (!drawMode || event.pointerId !== tracePointerIdRef.current || !group) return;
    const point = toUnit(event.clientX, event.clientY);
    const raw = tracePointsRef.current.slice();
    if (point) {
      const bounded: Point = [
        Math.max(0, Math.min(group.vb, point[0])),
        Math.max(0, Math.min(group.vb, point[1])),
      ];
      const previous = raw[raw.length - 1];
      if (!previous || pointDistance(bounded, previous) >= 0.08) raw.push(bounded);
    }
    clearTrace();
    event.preventDefault();
    if (raw.length < 2) {
      setTraceStatus("笔画太短，再拖一笔试试。");
      return;
    }
    const recognized = traceMode === "smart" ? recognizeStroke(raw, group.vb, strokeStyleNow()) : null;
    const result = recognized || preserveTrace(raw, group.vb);
    if (!result) {
      setTraceStatus("笔画太短，再拖一笔试试。");
      return;
    }
    const nextIndex = currentItems.length;
    // 手迹留在原地淡出，墨线补上来时淡入 —— 交接的那一下不留空档。
    startTraceEcho(raw);
    inkFadeWantedRef.current = performance.now();
    updateItems((items) => [...items, {
      t: "path",
      segs: result.segs,
      ...(recognized ? {} : { traceMode: "original" }),
      // 拉丁字形的字宽记在第一笔上：新库里落第一笔时就带上，右栏那根滑杆才有东西可拖，
      // 导出排版也不会退回 viewBox 那么宽。
      ...(isLatinLayout && !items.length ? { adv: DEFAULT_LATIN_ADV } : {}),
      // 保留复杂轨迹的结构，但仍让确定性种子驱动线条手感。
      amp: group.vb <= 32 ? 1 : 0.65,
    }]);
    setSelectedStrokes([nextIndex]);
    setSelectedPoint({ si: nextIndex, gi: result.segs.length - 1 });
    setTraceStatus(recognized ? `识别为${result.type} · 继续拖动可添加下一笔。` : traceMode === "smart" ? "已自动保留手迹 · 继续拖动可添加下一笔。" : "已保留手迹 · 继续拖动可添加下一笔。");
  };

  const tracePointerCancel = (event: React.PointerEvent<SVGSVGElement>) => {
    if (marqueeRef.current?.pointerId === event.pointerId) { clearMarquee(true); return; }
    if (!drawMode || event.pointerId !== tracePointerIdRef.current) return;
    clearTrace();
    setTraceStatus("描摹已取消，继续拖动可重试。");
  };

  /** 拖骨架：给了 gi 就是拖智能识别的锚点，只给 si 就是整笔平移。 */
  const startDrag = (event: React.PointerEvent<SVGElement>, target: PointTarget) => {
    if (referenceNeedsEntry || drawMode || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = toUnit(event.clientX, event.clientY);
    const snapshot = clone(currentItems[target.si]?.segs || []);
    if (!start || !snapshot.length) return;
    if (event.shiftKey) {
      setSelectedStrokes((previous) => previous.includes(target.si) ? previous.filter((index) => index !== target.si) : [...previous, target.si]);
      setSelectedPoint(null);
      return;
    }
    const moving = target.gi === undefined && selectedStrokes.includes(target.si) ? selectedStrokes : [target.si];
    const snapshots = clone(currentItems);
    setSelectedStrokes(moving);
    setSelectedPoint(target.gi !== undefined ? target : null);

    const move = (moveEvent: PointerEvent) => {
      const point = toUnit(moveEvent.clientX, moveEvent.clientY);
      if (!point || moveEvent.pointerId !== event.pointerId || pointDistance([event.clientX, event.clientY], [moveEvent.clientX, moveEvent.clientY]) < 3) return;
      const rawX = point[0] - start[0];
      const rawY = point[1] - start[1];
      updateItems((items) => {
        const element = items[target.si];
        if (!element?.segs) return items;
        if (target.gi === undefined) {
          const base = snapshot.flatMap((segment) => segment.p)[0];
          if (!base) return items;
          const dx = snap(base[0] + rawX, moveEvent.altKey) - base[0];
          const dy = snap(base[1] + rawY, moveEvent.altKey) - base[1];
          for (const index of moving) {
            const source = snapshots[index]?.segs;
            if (!source || !items[index]) continue;
            items[index].segs = clone(source);
            for (const segment of items[index].segs!) {
              for (const p of segment.p) { p[0] += dx; p[1] += dy; }
            }
          }
        } else {
          const from = snapshot[target.gi]?.p;
          const to = element.segs[target.gi]?.p;
          if (!from?.length || !to?.length) return items;
          const fromPoint = from[from.length - 1];
          const toIndex = to.length - 1;
          if (!fromPoint || !to[toIndex]) return items;
          to[toIndex] = [snap(fromPoint[0] + rawX, moveEvent.altKey), snap(fromPoint[1] + rawY, moveEvent.altKey)];
        }
        return items;
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  React.useEffect(() => {
    if (!helpOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && helpRef.current?.contains(target)) return;
      setHelpOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setHelpOpen(false); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [helpOpen]);

  React.useEffect(() => {
    if (!batchAddMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && batchAddMenuRef.current?.contains(target)) return;
      setBatchAddMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setBatchAddMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [batchAddMenu]);

  React.useEffect(() => () => {
    if (addMenuClickTimerRef.current !== null) {
      window.clearTimeout(addMenuClickTimerRef.current);
      addMenuClickTimerRef.current = null;
    }
  }, []);

  const setZoomClamped = (next: number) => setZoom(Math.min(4, Math.max(0.25, Number(next.toFixed(3)))));

  React.useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewportHeight(entry.contentRect.height);
      setViewportWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading]);

  // ⌘/Ctrl + 滚轮缩放。
  React.useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      setZoom((value) => Math.min(4, Math.max(0.25, Number((value * (event.deltaY > 0 ? 0.92 : 1.08)).toFixed(3)))));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [loading]);

  const save = async (payload?: GeoPayload, options: SaveOptions = {}) => {
    const target = payload ?? geo;
    if (!target) return false;
    const explicitSave = payload === undefined;
    const referenceTextAtSave = referenceText;
    const savedReference = firstReferenceCharacter(referenceTextAtSave);
    if (explicitSave && rightPanelSaveTimerRef.current !== null) {
      window.clearTimeout(rightPanelSaveTimerRef.current);
      rightPanelSaveTimerRef.current = null;
      rightPanelSaveTargetRef.current = null;
    }
    let saveTarget = target;
    let renamedFrom: string | null = null;
    let renamedGlyph: string | null = null;
    const targetGlyphs = target.glyphs;
    const draftName = targetGlyphs
      ? Object.keys(targetGlyphs.items).find((name) => isDraftGlyph(name)) || null
      : null;

    if (draftName) {
      // 结构性自动保存不应把内部草稿名写进字库；只有用户明确保存时才提交命名。
      if (!explicitSave) return false;
      const base = firstReferenceCharacter(referenceText);
      if (!base) {
        setError("请先在画布下方输入一个字，再保存这个空白字形。");
        return false;
      }
      const mismatch = glyphNameFitsMode(base, targetGlyphs.mode);
      if (mismatch) {
        setError(mismatch);
        return false;
      }
      let nextName = base;
      if (Object.hasOwn(targetGlyphs.items, nextName)) {
        let variant = 2;
        while (Object.hasOwn(targetGlyphs.items, `${base}${variant}`)) variant += 1;
        nextName = `${base}${variant}`;
      }
      const nextItems: Record<string, EditableElement[]> = {};
      for (const [name, items] of Object.entries(targetGlyphs.items)) {
        nextItems[name === draftName ? nextName : name] = items;
      }
      const nextSeeds = { ...targetGlyphs.glyphSeeds };
      const nextSeedMemory = { ...(targetGlyphs.glyphSeedMemory || {}) };
      if (Object.hasOwn(nextSeeds, draftName)) {
        nextSeeds[nextName] = nextSeeds[draftName];
        delete nextSeeds[draftName];
      }
      if (Object.hasOwn(nextSeedMemory, draftName)) {
        nextSeedMemory[nextName] = nextSeedMemory[draftName];
        delete nextSeedMemory[draftName];
      }
      const nextEditor = targetGlyphs.editor ? { ...targetGlyphs.editor } : undefined;
      if (nextEditor?.ink && Object.hasOwn(nextEditor.ink, draftName)) {
        const ink = { ...nextEditor.ink, [nextName]: clone(nextEditor.ink[draftName]) };
        delete ink[draftName];
        nextEditor.ink = ink;
      }
      const nextGlyphs: GlyphLibrary = {
        ...targetGlyphs,
        items: nextItems,
        glyphSeeds: nextSeeds,
        glyphSeedMemory: nextSeedMemory,
      };
      if (nextEditor) nextGlyphs.editor = nextEditor;
      saveTarget = {
        ...target,
        glyphs: nextGlyphs,
      };
      renamedFrom = draftName;
      renamedGlyph = nextName;
    } else if (explicitSave && glyphName) {
      const mismatch = glyphNameFitsMode(firstReferenceCharacter(referenceText), targetGlyphs.mode);
      if (mismatch) {
        setError(mismatch);
        return false;
      }
      const renamed = renameGlyphInLibrary(targetGlyphs, glyphName, referenceText);
      if (renamed) {
        saveTarget = { ...target, glyphs: renamed.glyphs };
        renamedFrom = glyphName;
        renamedGlyph = renamed.name;
      }
    }

    try {
      await requestJSON<{ ok: boolean; file?: string }>("/api/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ glyphs: saveTarget.glyphs }),
      });
      if (renamedGlyph) {
        setGeo(saveTarget);
        setGlyphName(renamedGlyph);
        if (renamedFrom) {
          setLiveAdvances((previous) => {
            if (!Object.hasOwn(previous, renamedFrom)) return previous;
            const next = { ...previous, [renamedGlyph]: previous[renamedFrom] };
            delete next[renamedFrom];
            return next;
          });
          setInkPreferences((previous) => {
            const fromKey = inkPreferenceKey(saveTarget.file, renamedFrom);
            const toKey = inkPreferenceKey(saveTarget.file, renamedGlyph);
            if (!Object.hasOwn(previous, fromKey)) return previous;
            const next = { ...previous, [toKey]: previous[fromKey] };
            delete next[fromKey];
            return next;
          });
        }
      }
      const savedGlyphs = clone(saveTarget.glyphs);
      savedGlyphsRef.current = savedGlyphs;
      setSavedPreviewGlyphs(savedGlyphs);
      if (!options.preserveCanvasUnsaved) canvasDirtyRef.current = false;
      setHasUnsavedChanges(options.preserveCanvasUnsaved ? canvasDirtyRef.current : false);
      if (explicitSave) {
        referenceInputRef.current?.blur();
        if (savedReference && savedReference !== referenceTextAtSave) {
          setReferenceText(savedReference);
        }
      }
      setError("");
      return true;
    } catch (reason) {
      // 自动保存失败也要留下保护提示，避免右栏改动静默丢失。
      setHasUnsavedChanges(true);
      setError(reason instanceof Error ? reason.message : "保存失败");
      return false;
    }
  };

  const showSaveToast = React.useCallback(() => {
    if (saveToastTimerRef.current !== null) window.clearTimeout(saveToastTimerRef.current);
    setSaveToastOpen(true);
    saveToastTimerRef.current = window.setTimeout(() => {
      saveToastTimerRef.current = null;
      setSaveToastOpen(false);
    }, 1400);
  }, []);

  React.useEffect(() => () => {
    if (saveToastTimerRef.current !== null) window.clearTimeout(saveToastTimerRef.current);
  }, []);

  const flushRightPanelSave = () => {
    rightPanelSaveTimerRef.current = null;
    if (rightPanelSaveInFlightRef.current) {
      rightPanelSaveTimerRef.current = window.setTimeout(flushRightPanelSave, 240);
      return;
    }
    const target = rightPanelSaveTargetRef.current;
    rightPanelSaveTargetRef.current = null;
    if (!target) return;
    rightPanelSaveInFlightRef.current = true;
    rightPanelSaveInFlightTargetRef.current = target;
    let scheduleNext = false;
    void save(target, { preserveCanvasUnsaved: true }).then((saved) => {
      // 失败时保留最后一次目标，后续仍可重试；如果期间已有更新，
      // 新目标已经包含这次改动，不要把它覆盖回旧快照。
      const queuedDuringSave = !!rightPanelSaveTargetRef.current;
      if (!saved && !queuedDuringSave) rightPanelSaveTargetRef.current = target;
      scheduleNext = queuedDuringSave;
    }).finally(() => {
      rightPanelSaveInFlightRef.current = false;
      rightPanelSaveInFlightTargetRef.current = null;
      if (scheduleNext && rightPanelSaveTargetRef.current && rightPanelSaveTimerRef.current === null) {
        rightPanelSaveTimerRef.current = window.setTimeout(flushRightPanelSave, 240);
      }
    });
  };

  const queueRightPanelSave = (target: GeoPayload, patch: RightPanelPatch) => {
    if (Object.keys(target.glyphs.items).some((name) => isDraftGlyph(name))) {
      // 空白新字形必须先在画布下方命名，仍由用户明确点击保存。
      setHasUnsavedChanges(true);
      return;
    }
    // 始终从已写回的快照（或正在写回的目标）开始叠加右栏变化。
    // 这样画布有未保存改动时，右栏自动保存不会把画布坐标带进请求。
    const base = rightPanelSaveTargetRef.current
      || rightPanelSaveInFlightTargetRef.current
      || (savedGlyphsRef.current
        ? { ...target, glyphs: clone(savedGlyphsRef.current) }
        : target);
    rightPanelSaveTargetRef.current = {
      ...target,
      glyphs: patch(clone(base.glyphs)),
    };
    if (rightPanelSaveTimerRef.current !== null) window.clearTimeout(rightPanelSaveTimerRef.current);
    rightPanelSaveTimerRef.current = window.setTimeout(flushRightPanelSave, 240);
  };

  React.useEffect(() => () => {
    if (rightPanelSaveTimerRef.current !== null) window.clearTimeout(rightPanelSaveTimerRef.current);
    rightPanelSaveTargetRef.current = null;
    rightPanelSaveInFlightTargetRef.current = null;
  }, []);

  const updateGlyphsAndSave = (patch: Partial<GlyphLibrary>) => {
    if (!geo?.glyphs) return;
    const nextGeo: GeoPayload = {
      ...geo,
      glyphs: { ...geo.glyphs, ...patch },
    };
    setGeo(nextGeo);
    queueRightPanelSave(nextGeo, (base) => ({ ...base, ...clone(patch) }));
  };

  const updateEditorAndSave = (patch: Partial<EditorConfig>) => {
    if (!geo?.glyphs) return;
    const nextEditor = mergeEditorConfig(geo.glyphs.editor, patch);
    const nextGeo: GeoPayload = {
      ...geo,
      glyphs: { ...geo.glyphs, editor: nextEditor },
    };
    setGeo(nextGeo);
    queueRightPanelSave(nextGeo, (base) => ({
      ...base,
      editor: mergeEditorConfig(base.editor, patch),
    }));
  };

  const updateInkStyle = (patch: Partial<InkStyle>) => {
    if (!currentInkKey || !geo?.glyphs || !glyphName) return;
    const previous = inkPreferences[currentInkKey] || DEFAULT_INK_STYLE;
    const nextStyle = { ...previous, ...patch };
    setInkPreferences((previousPreferences) => ({
      ...previousPreferences,
      [currentInkKey]: nextStyle,
    }));
    updateEditorAndSave({ ink: { [glyphName]: nextStyle } });
  };

  const setInkColor = (value: string) => updateInkStyle({ color: normalizeHexColor(value) });
  const setInkOpacity = (value: number) => updateInkStyle({ opacity: clampOpacity(value) });

  const updateItemsAndSave = (updater: (items: EditableElement[]) => EditableElement[]) => {
    if (!geo?.glyphs || !glyphName) return;
    const beforeItems = clone(geo.glyphs.items[glyphName] || []);
    const nextItems = updater(clone(beforeItems));
    const nextGeo: GeoPayload = {
      ...geo,
      glyphs: {
        ...geo.glyphs,
        items: { ...geo.glyphs.items, [glyphName]: nextItems },
      },
    };
    setGeo(nextGeo);
    queueRightPanelSave(nextGeo, (base) => ({
      ...base,
      items: {
        ...base.items,
        [glyphName]: mergeRightPanelItemFields(base.items[glyphName] || [], beforeItems, nextItems),
      },
    }));
  };

  React.useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.defaultPrevented || event.isComposing || target?.closest('[role="dialog"], [role="menu"], [role="listbox"], [role="combobox"]')) return;
      const typing = !!target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable);
      const meta = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      const textEditing = typing && !(target instanceof HTMLInputElement && ["range", "checkbox"].includes(target.type));
      if (meta && !textEditing && (key === "z" || key === "y")) {
        event.preventDefault();
        const restored = restore(key === "y" || event.shiftKey);
        if (restored) {
          inkFadeWantedRef.current = performance.now();   // 撤掉的那笔淡出，重做回来的那笔淡入
          clearMarquee();
          clearTrace();
          setSelectedStrokes([]);
          setSelectedPoint(null);
          setHasUnsavedChanges(JSON.stringify(restored.glyphs) !== JSON.stringify(savedGlyphsRef.current));
          if (!Object.hasOwn(restored.glyphs?.items || {}, glyphName)) {
            const nextGlyph = Object.keys(restored.glyphs?.items || {})[0] || "";
            setGlyphName(nextGlyph);
            setReferenceText(glyphInfo(nextGlyph).base);
          }
        }
        return;
      }
      if (meta && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save().then((saved) => {
          if (saved) showSaveToast();
        });
        return;
      }
      if (meta && event.shiftKey && event.key.toLowerCase() === "e") {
        event.preventDefault();
        void exportActionRef.current?.();
        return;
      }
      if (meta && (event.key === "=" || event.key === "+")) { event.preventDefault(); setZoom((v) => Math.min(4, Number((v * 1.15).toFixed(3)))); return; }
      if (meta && event.key === "-") { event.preventDefault(); setZoom((v) => Math.max(0.25, Number((v / 1.15).toFixed(3)))); return; }
      if (meta && event.key === "0") { event.preventDefault(); setZoom(1); return; }
      if (meta && event.key.toLowerCase() === "a" && !typing && !drawMode) {
        event.preventDefault();
        setSelectedStrokes(currentItems.flatMap((item, index) => item.segs ? [index] : []));
        setSelectedPoint(null);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (typing) return;
      if (event.key === "Escape" && drawMode) { event.preventDefault(); setDrawMode(false); return; }
      if (event.key === "Escape") { clearMarquee(); setSelectedStrokes([]); setSelectedPoint(null); return; }
      if (drawMode) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        if (event.repeat) return;
        const selected = selectedStrokes.filter((index) => currentItems[index]);
        if (selected.length) {
          updateItems((items) => items.filter((_, index) => !selected.includes(index)));
          const remaining = currentItems.length - selected.length;
          setSelectedStrokes(remaining ? [Math.min(Math.min(...selected), remaining - 1)] : []);
          setSelectedPoint(null);
        } else {
          removeGlyph(glyphName);
        }
        return;
      }
      if (event.key === "[") { event.preventDefault(); setLeftOpen((value) => !value); }
      else if (event.key === "]") { event.preventDefault(); setRightOpen((value) => !value); }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => {
      window.removeEventListener("keydown", handleShortcut);
    };
  }, [geo, drawMode, glyphName, restore, selectedStrokes, selectedPoint, showSaveToast]);

  const exportContent = async () => {
    const exportNames = names.filter((name) => !isDraftGlyph(name));
    if (!group || !exportNames.length || exportBusy) return;
    const format = exportFormat;
    const scale = format === "png" ? Number(exportScale) : 1;
    setExportBusy(true);
    setExportMessage(exportScope === "glyphs" ? `准备 ${exportNames.length} 个单字…` : "准备整段预览…");

    try {
      const base = exportSafeName((geo.file.split("/").pop() || "glyphs").replace(/\.[^.]+$/, ""));
      const suffix = format === "svg" ? "SVG" : `${scale}x-PNG`;

      if (exportScope === "glyphs") {
        const used = new Set<string>();
        const files: Array<{ name: string; data: Uint8Array }> = [];
        for (let index = 0; index < exportNames.length; index += 1) {
          const name = exportNames[index];
          const info = glyphInfo(name);
          setExportMessage(`正在处理 ${index + 1}/${exportNames.length} · ${glyphLabel(name)}`);
          const stem = exportSafeName(info.variant > 1 ? `${info.base}-v${info.variant}` : info.base);
          let fileName = stem;
          let collision = 2;
          while (used.has(fileName)) fileName = `${stem}-${collision++}`;
          used.add(fileName);
          const style = inkStyleFor(name);
          files.push({
            name: `${fileName}.${format}`,
            data: await renderExportGlyph(group, name, index, format, scale, style.color, style.opacity),
          });
        }
        const zip = zipStore(files);
        const filename = `${base}-glyphs-${suffix}.zip`;
        downloadBlob(new Blob([zip], { type: "application/zip" }), filename);
        setExportMessage(`已导出 ${files.length} 个单字文件`);
        return;
      }

      if (!rowResult?.svg) throw new Error("整段预览还没有生成");
      const [rowWidth, rowHeight] = rowExportBox(rowResult);
      const outWidth = Math.max(1, Math.round(rowWidth * scale));
      const outHeight = Math.max(1, Math.round(rowHeight * scale));
      // 关键点：不重新请求、不重新拼路径，直接下载当前行预览的 SVG。
      const svg = addSvgSize(colorizeRowSvg(rowResult.svg, rowInkStyles), outWidth, outHeight);
      const filename = `${base}-row-${suffix}.${format}`;
      if (format === "svg") {
        downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), filename);
      } else {
        downloadBlob(await svgToPng(svg, outWidth, outHeight), filename);
      }
      setExportMessage("已导出当前整段预览");
    } catch (reason) {
      setExportMessage(`导出失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setExportBusy(false);
    }
  };

  exportActionRef.current = exportContent;

  const batchAddPlan = React.useMemo(
    () => buildBatchGlyphPlan(glyphs?.items || {}, batchAddText),
    [glyphs?.items, batchAddText],
  );
  const batchAddCharacterCount = batchGlyphCharacters(batchAddText).length;
  const batchAddOverLimit = batchAddCharacterCount > BATCH_ADD_LIMIT;

  const clearAddMenuClickTimer = () => {
    if (addMenuClickTimerRef.current !== null) {
      window.clearTimeout(addMenuClickTimerRef.current);
      addMenuClickTimerRef.current = null;
    }
  };

  const openBatchAddMenuAt = (clientX: number, clientY: number) => {
    const menuWidth = 156;
    const menuHeight = 78;
    setBatchAddMenu({
      x: Math.max(8, Math.min(clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(clientY, window.innerHeight - menuHeight - 8)),
    });
  };

  const openBatchAddMenuFromClick = (_open: boolean, event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.detail !== 1) return;
    clearAddMenuClickTimer();
    const { clientX, clientY } = event;
    addMenuClickTimerRef.current = window.setTimeout(() => {
      addMenuClickTimerRef.current = null;
      openBatchAddMenuAt(clientX, clientY);
    }, 220);
  };

  const quickAddGlyph = (_open: boolean, event: React.MouseEvent<HTMLButtonElement>) => {
    clearAddMenuClickTimer();
    event.preventDefault();
    setBatchAddMenu(null);
    addGlyph();
  };

  const addSingleGlyphFromMenu = () => {
    setBatchAddMenu(null);
    addGlyph();
  };

  const openBatchAddDialog = () => {
    clearAddMenuClickTimer();
    setBatchAddMenu(null);
    setBatchAddText("");
    setBatchAddError("");
    setBatchAddOpen(true);
  };

  const batchAddGlyphs = () => {
    if (!geo || !glyphs) return;
    if (batchAddOverLimit) {
      setBatchAddError(`最多添加 ${BATCH_ADD_LIMIT} 个字形，请删减输入内容。`);
      return;
    }
    if (!batchAddPlan.length) {
      setBatchAddError("请输入一段文字。");
      return;
    }
    if (names.some((name) => isDraftGlyph(name))) {
      setBatchAddError("请先输入一个字并保存当前空白字形。");
      return;
    }
    for (const entry of batchAddPlan) {
      const mismatch = glyphNameFitsMode(entry.character, glyphs.mode);
      if (mismatch) {
        setBatchAddError(mismatch);
        return;
      }
    }

    const nextItems: Record<string, EditableElement[]> = { ...glyphs.items };
    const nextSeeds = { ...(glyphs.glyphSeeds || {}) };
    const nextSeedMemory = { ...(glyphs.glyphSeedMemory || {}) };
    const nextInk = { ...(glyphs.editor?.ink || {}) };
    for (const entry of batchAddPlan) {
      const base = glyphInfo(entry.character).base || entry.character;
      const source = nextItems[base];
      nextItems[entry.name] = source ? clone(source) : [];
      if (Object.hasOwn(nextSeeds, base)) nextSeeds[entry.name] = nextSeeds[base];
      if (Object.hasOwn(nextSeedMemory, base)) nextSeedMemory[entry.name] = nextSeedMemory[base];
      if (Object.hasOwn(nextInk, base)) nextInk[entry.name] = clone(nextInk[base]);
    }

    const nextGlyphs: GlyphLibrary = {
      ...glyphs,
      items: nextItems,
      glyphSeeds: nextSeeds,
    };
    if (Object.keys(nextInk).length || glyphs.editor?.ink !== undefined) {
      nextGlyphs.editor = { ...(glyphs.editor || {}), ink: nextInk };
    }
    if (Object.keys(nextSeedMemory).length || glyphs.glyphSeedMemory !== undefined) {
      nextGlyphs.glyphSeedMemory = nextSeedMemory;
    } else {
      delete nextGlyphs.glyphSeedMemory;
    }
    const nextGeo: GeoPayload = { ...geo, glyphs: nextGlyphs };
    if (drawMode) setDrawMode(false);
    setHasUnsavedChanges(true);
    setGeo(nextGeo);
    setBatchAddOpen(false);
    setBatchAddText("");
    setBatchAddError("");
    setError("");
    // 批量添加与右侧“复制字形”保持一致：一次性写回，当前正在编辑的字形不变。
    void save(nextGeo, { preserveCanvasUnsaved: true });
  };

  const addGlyph = () => {
    if (!geo || !glyphs) return false;
    if (names.some((name) => isDraftGlyph(name))) {
      setError("请先输入一个字并保存当前空白字形。");
      return false;
    }
    const nextName = nextDraftGlyphName(glyphs.items);
    // 先创建内部草稿名的空白字形；参考字只在用户保存时写入正式标题。
    const source: EditableElement[] = [];
    if (drawMode) setDrawMode(false);
    updateGlyphs({ items: { ...glyphs.items, [nextName]: source } });
    setGlyphName(nextName);
    setReferenceText("");
    setSelectedStrokes([]);
    setSelectedPoint(null);
    return true;
  };

  const copyGlyph = (name: string) => {
    if (!geo || !glyphs || !name || isDraftGlyph(name) || !Object.hasOwn(glyphs.items, name)) return;
    if (names.some((entry) => isDraftGlyph(entry))) {
      setError("请先输入一个字并保存当前空白字形。");
      return;
    }
    const nextName = nextGlyphVariantName(glyphs.items, name);
    const nextItems: Record<string, EditableElement[]> = {};
    for (const [entry, items] of Object.entries(glyphs.items)) {
      nextItems[entry] = items;
      if (entry === name) nextItems[nextName] = clone(items);
    }
    const glyphSeeds = { ...glyphs.glyphSeeds };
    if (Object.hasOwn(glyphSeeds, name)) glyphSeeds[nextName] = glyphSeeds[name];
    const glyphSeedMemory = { ...(glyphs.glyphSeedMemory || {}) };
    if (Object.hasOwn(glyphSeedMemory, name)) glyphSeedMemory[nextName] = glyphSeedMemory[name];
    const editor = { ...(glyphs.editor || {}) };
    if (glyphs.editor?.ink && Object.hasOwn(glyphs.editor.ink, name)) {
      editor.ink = { ...glyphs.editor.ink, [nextName]: clone(glyphs.editor.ink[name]) };
    }
    const nextGeo: GeoPayload = {
      ...geo,
      glyphs: { ...glyphs, items: nextItems, glyphSeeds, glyphSeedMemory, editor },
    };
    setHasUnsavedChanges(true);
    setGeo(nextGeo);
    setGlyphName(nextName);
    setReferenceText(glyphInfo(nextName).base);
    setSelectedStrokes([]);
    setSelectedPoint(null);
    void save(nextGeo, { preserveCanvasUnsaved: true });
  };

  const removeGlyph = (name: string) => {
    if (!geo || !glyphs || names.length <= 1) return;
    if (drawMode) setDrawMode(false);
    const nextItems = { ...glyphs.items };
    delete nextItems[name];
    const glyphSeeds = { ...glyphs.glyphSeeds };
    delete glyphSeeds[name];
    const glyphSeedMemory = { ...(glyphs.glyphSeedMemory || {}) };
    delete glyphSeedMemory[name];
    const editor = glyphs.editor ? { ...glyphs.editor } : undefined;
    if (editor?.ink) {
      const ink = { ...editor.ink };
      delete ink[name];
      if (Object.keys(ink).length) editor.ink = ink;
      else delete editor.ink;
    }
    const nextGeo: GeoPayload = {
      ...geo,
      glyphs: { ...glyphs, items: nextItems, glyphSeeds, glyphSeedMemory, ...(editor ? { editor } : {}) },
    };
    setHasUnsavedChanges(true);
    setGeo(nextGeo);
    // 移除是结构性操作，点击后立即写回字库，不再等用户手动保存。
    void save(nextGeo, { preserveCanvasUnsaved: true });
    if (name === glyphName) {
      const remaining = Object.keys(nextItems);
      const nextGlyph = remaining[Math.min(names.indexOf(name), remaining.length - 1)] || "";
      setGlyphName(nextGlyph);
      setReferenceText(glyphInfo(nextGlyph).base);
      setSelectedStrokes([]);
      setSelectedPoint(null);
    }
  };

  /* 换顺序不只是挪位置：idx 参与种子（见 render() 的 idx），
     所以移动过的字会整个重抖一遍 —— 形状不变，抖法变。
     拖动经过某行时只换列表的可见顺序；松手后才提交 geo，避免每一次
     dragover 都让画布、整段预览和所有缩略图重新请求渲染。ref 保存拖动中的键序，
     避免连续 dragover 事件还没等 React 重绘就拿到旧的 names。 */
  const captureGlyphRowRects = () => {
    const rects = new Map<string, DOMRect>();
    for (const [name, row] of glyphRowRefs.current) rects.set(name, row.getBoundingClientRect());
    for (const motion of glyphRowMotion.current.values()) {
      if (motion.frame !== null) window.cancelAnimationFrame(motion.frame);
      if (motion.timer !== null) window.clearTimeout(motion.timer);
      motion.row.style.transition = "none";
      motion.row.style.transform = "none";
    }
    glyphRowMotion.current.clear();
    glyphRowFirstRects.current = rects;
  };

  const beginGlyphPointerDrag = (event: React.PointerEvent<HTMLDivElement>, name: string) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement).closest(".row-menu")) return;
    glyphDragRef.current = {
      name,
      order: [...names],
      initialOrder: [...names],
      preview: geo,
      wasUnsaved: hasUnsavedChanges,
      pointerFrame: null,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      active: false,
    };
  };

  const moveGlyphPointerDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = glyphDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active) {
      const moved = Math.hypot(event.clientX - drag.startClientX, event.clientY - drag.startClientY);
      if (moved < 5) return;
      drag.active = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      setDragName(drag.name);
    }
    event.preventDefault();
    drag.lastClientX = event.clientX;
    drag.lastClientY = event.clientY;
    if (drag.pointerFrame !== null) return;
    drag.pointerFrame = window.requestAnimationFrame(() => {
      const current = glyphDragRef.current;
      if (!current) return;
      current.pointerFrame = null;
      processGlyphPointerPosition(current, current.lastClientX, current.lastClientY);
    });
  };

  const reorderGlyphsLive = (targetName: string, afterTarget: boolean) => {
    const drag = glyphDragRef.current;
    if (!drag || drag.name === targetName) return;
    const from = drag.order.indexOf(drag.name);
    const target = drag.order.indexOf(targetName);
    if (from < 0 || target < 0) return;

    const insertion = afterTarget ? target + 1 : target;
    const nextOrder = [...drag.order];
    const [moved] = nextOrder.splice(from, 1);
    if (!moved) return;
    const nextIndex = insertion > from ? insertion - 1 : insertion;
    if (nextIndex === from) return;
    captureGlyphRowRects();
    nextOrder.splice(nextIndex, 0, moved);
    drag.order = nextOrder;
    const preview = drag.preview || geo;
    if (preview?.glyphs) {
      const currentGlyphs = preview.glyphs;
      const currentNames = Object.keys(currentGlyphs.items);
      if (currentNames.length === nextOrder.length && currentNames.every((name) => nextOrder.includes(name))) {
        const nextItems: Record<string, EditableElement[]> = {};
        for (const name of nextOrder) nextItems[name] = currentGlyphs.items[name];
        drag.preview = {
          ...preview,
          glyphs: { ...currentGlyphs, items: nextItems },
        };
      }
    }
    setDragOrder(nextOrder);
  };

  const processGlyphPointerPosition = (drag: GlyphDragState, clientX: number, clientY: number) => {
    if (glyphDragRef.current !== drag || !drag.active) return;
    const target = document.elementFromPoint(clientX, clientY)?.closest(".glyph-row");
    const targetRow = target instanceof HTMLDivElement ? target : null;
    const targetName = targetRow?.dataset.glyphName;
    if (!targetRow || !targetName) return;

    const list = targetRow.parentElement;
    const rect = targetRow.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();
    // FLIP 会给行加临时 transform；用 offsetTop 算布局中的中线，
    // 不让正在移动的行把判断线一起带走，避免临界点来回抖动。
    const layoutTop = list && listRect && targetRow.offsetParent === list
      ? listRect.top + targetRow.offsetTop - list.scrollTop
      : rect.top;
    const afterTarget = clientY - layoutTop > targetRow.offsetHeight / 2;
    reorderGlyphsLive(targetName, afterTarget);
  };

  const finishGlyphDrag = (clientX?: number, clientY?: number) => {
    const drag = glyphDragRef.current;
    if (drag && drag.pointerFrame !== null) {
      window.cancelAnimationFrame(drag.pointerFrame);
      drag.pointerFrame = null;
    }
    if (drag?.active) {
      processGlyphPointerPosition(drag, clientX ?? drag.lastClientX, clientY ?? drag.lastClientY);
    }
    if (!drag?.active) {
      glyphDragRef.current = null;
      setDragName(null);
      setDragOrder(null);
      if (drag) setHasUnsavedChanges(drag.wasUnsaved);
      return;
    }
    glyphDragRef.current = null;
    setDragName(null);
    setDragOrder(null);
    if (!drag) return;
    const changed = drag.order.some((name, index) => name !== drag.initialOrder[index]);
    if (!changed) {
      setHasUnsavedChanges(drag.wasUnsaved);
      return;
    }
    // 只在手势结束时写一次，避免每经过一行都触发保存请求。
    const payload = drag.preview ?? geo;
    if (payload) {
      setHasUnsavedChanges(true);
      setGeo(payload);
      void save(payload, { preserveCanvasUnsaved: true });
    }
  };

  const cancelGlyphDrag = () => {
    const drag = glyphDragRef.current;
    if (!drag) return;
    if (drag.pointerFrame !== null) window.cancelAnimationFrame(drag.pointerFrame);
    glyphDragRef.current = null;
    setDragName(null);
    setDragOrder(null);
    setHasUnsavedChanges(drag.wasUnsaved);
  };

  /* 单字种子：给这个字钉一个自己的种子，全局种子再怎么换它都不变。
     glyphSeeds 保存当前启用的局部覆盖；跟随全局时把上次的值放在 memory 里，
     这样切回局部种子不会重新随机；记忆值和全局种子都会随字库保存。 */
  const localSeed = readGlyphSeed(glyphs?.glyphSeeds?.[glyphName]);
  const rememberedSeed = readGlyphSeed(glyphs?.glyphSeedMemory?.[glyphName]);

  /* 抖动是**逐笔**的结构属性（SKILL.md：「口」抖散了就不是字了），
     所以滑杆的目标跟着画布上选中的那一笔走；没选中笔画时才作用于全部。
     值等于 1 就把键删掉，保持文件 diff 干净。 */
  const strokeAmp = (index: number) => {
    const value = currentItems[index]?.amp;
    return typeof value === "number" && Number.isFinite(value) ? value : 1;
  };

  /* 抖动是逐笔的结构属性（SKILL.md：「口」抖散了就不是字了），
     所以只有画布上选中某一笔时才能调；没选中就是不可调状态。 */
  const ampStroke = selectedStrokes.find((index) => currentItems[index]) ?? null;
  const mixedAmp = ampStroke !== null && selectedStrokes.some((index) => strokeAmp(index) !== strokeAmp(ampStroke));

  const setStrokeAmpValue = (value: number) => {
    if (ampStroke === null) return;
    const rounded = Number(value.toFixed(3));
    updateItemsAndSave((items) => items.map((element, index) => {
      if (!selectedStrokes.includes(index)) return element;
      const next = { ...element };
      if (Math.abs(rounded - 1) < 1e-9) delete next.amp;
      else next.amp = rounded;
      return next;
    }));
  };

  const setLocalSeed = (next: number | null) => {
    if (!glyphs || !glyphName) return;
    const seeds = { ...(glyphs.glyphSeeds || {}) };
    const memory = { ...(glyphs.glyphSeedMemory || {}) };
    if (next === null) {
      const active = readGlyphSeed(seeds[glyphName]);
      if (active === null) return;
      memory[glyphName] = active;
      delete seeds[glyphName];
    } else {
      const value = Math.max(1, Math.min(999, Math.round(next)));
      seeds[glyphName] = value;
      memory[glyphName] = value;
    }
    updateGlyphsAndSave({ glyphSeeds: seeds, glyphSeedMemory: memory });
  };

  const setGlyphSeedFollow = (follow: boolean) => {
    if (follow) {
      setLocalSeed(null);
      return;
    }
    setLocalSeed(rememberedSeed ?? Math.floor(Math.random() * 999) + 1);
  };

  const toggleSection = (key: string) => (open: boolean) => setOpenSections((previous) => ({ ...previous, [key]: open }));

  const setRowTrackAndSave = (value: number) => {
    const next = Number(value);
    setRowTrack(next);
    updateGlyphsAndSave({ track: next });
  };

  const setViewSeedAndSave = (value: number) => {
    const next = Math.max(1, Math.min(999, Math.round(Number(value))));
    setViewSeed(next);
    updateGlyphsAndSave({ seed: next });
  };

  const setExportScopeAndSave = (scope: ExportScope) => {
    setExportScope(scope);
    updateEditorAndSave({ export: { scope } });
  };

  const setExportFormatAndSave = (format: ExportFormat) => {
    setExportFormat(format);
    updateEditorAndSave({ export: { format } });
  };

  const setExportScaleAndSave = (scale: string) => {
    if (!(EXPORT_SCALES as readonly string[]).includes(scale)) return;
    setExportScale(scale);
    updateEditorAndSave({ export: { scale } });
  };

  const setGlyph = (name: string) => {
    if (name !== glyphName && !confirmNavigation()) return false;
    if (drawMode) setDrawMode(false);
    setGlyphName(name);
    setReferenceText(glyphInfo(name).base);
    setSelectedStrokes([]);
    setSelectedPoint(null);
    return true;
  };

  /* 这一段必须待在提前 return **之前**：React 按调用顺序认 hook，
     加载中那一帧早退、加载完那一帧多跑一个 useMemo，就是
     "Rendered more hooks than during the previous render"。 */
  const allMetrics = rowResult?.table ?? [];
  const metricRows = React.useMemo(() => {
    const sizes = allMetrics
      .filter((cell) => cell.name !== null && Number.isFinite(cell.s))
      .map((cell) => cell.s)
      .sort((a, b) => a - b);
    const middle = Math.floor(sizes.length / 2);
    const reference = sizes.length === 0
      ? null
      : sizes.length % 2 === 0
        ? (sizes[middle - 1] + sizes[middle]) / 2
        : sizes[middle];

    return allMetrics.map((cell) => {
      if (cell.name === null || reference === null || reference === 0) {
        return { ...cell, sizeDelta: null, sizeAlert: null as "large" | "small" | null };
      }
      const sizeDelta = ((cell.s - reference) / reference) * 100;
      const sizeAlert = sizeDelta > METRICS_SIZE_ALERT_PERCENT
        ? "large" as const
        : sizeDelta < -METRICS_SIZE_ALERT_PERCENT
          ? "small" as const
          : null;
      return { ...cell, sizeDelta, sizeAlert };
    });
  }, [allMetrics]);

  if (loading) {
    return <div className="loading-screen"><span className="loading-mark">hg</span><span>正在读取字库…</span></div>;
  }

  if (!geo || !group) {
    return (
      <div className="loading-screen error-screen">
        <span className="loading-mark">!</span>
        <strong>字库读不出来</strong>
        <span>{error || "这份几何 JSON 解析失败了。"}</span>
        <button className="library-file-action" type="button" onClick={() => handleDocumentNew("han")}>
          新建一份空的
        </button>
      </div>
    );
  }

  /* 参数按"改一下到底影响谁"分：
     - groupParams 进单字渲染（/api/render 的 amp/over）和整行，这一组每个字都变；
       线宽不进滤镜，是 SVG 上的 stroke-width，但同样是整组的。
     - lineParams 只在排整行时起作用（render_row 的 ampk/varyk），单字画布上看不出来。 */
  const groupParams = [
    { label: "线宽", key: "sw" as const, min: 1, max: 7, step: 0.1, suffix: "" },
    { label: "抖动倍率", key: "amp" as const, min: 0, max: 2, step: 0.05, suffix: "" },
    { label: "越位", key: "over" as const, min: 0, max: 2, step: 0.05, suffix: "" },
    { label: "大小起伏", key: "jit" as const, min: 0, max: 2, step: 0.05, suffix: "" },
    { label: "重写幅度", key: "vary" as const, min: 0, max: 2, step: 0.05, suffix: "" },
  ];

  const canvasBase = Math.max(208, Math.min(480, viewportHeight - 160, viewportWidth - 32));
  const canvasPx = Math.round(canvasBase);
  const canvasFramePx = canvasPx + 32;


  const railStyle = {
    "--rail-l": leftOpen ? "288px" : "112px",
    "--rail-r": rightOpen ? "304px" : "112px",
  } as React.CSSProperties;

  return (
    <Tooltip.Provider delayDuration={350} skipDelayDuration={120}>
      <div className="app" data-row-open={rowOpen} style={railStyle} onPointerDown={(event) => {
        const target = event.target as Element;
        if (!target.closest(".section-trigger-action")) clearAddMenuClickTimer();
        if (event.button !== 0 || drawMode) return;
        if (!target.matches(".app, .workspace, .stage, .viewport, .canvas-col")) return;
        setSelectedStrokes([]);
        setSelectedPoint(null);
      }}>
        {/* ── 中间：画布 + 工具条 + 行预览 ──────────────────────────── */}
        <div className="workspace">
          <div className="stage">
            <div
              className="viewport"
              ref={viewportRef}
            >
              <div className="canvas-col">
                <div className="canvas-zoom-stage" style={{ width: canvasFramePx * zoom, height: canvasFramePx * zoom }}>
                  <section
                    className="canvas-sheet"
                    aria-label="字形编辑"
                    style={{ width: canvasFramePx, transform: `scale(${zoom})` }}
                  >
                    <div className={`canvas-wrap${referenceNeedsEntry ? " is-reference-locked" : ""}`} data-trace-mode={traceMode} style={{ width: canvasPx }}>
                      {underlay && (
                        <div
                          className="canvas-under"
                          style={{ fontFamily: referenceFont, fontSize: canvasPx * 0.78 }}
                        >
                          {firstReferenceCharacter(referenceText)}
                        </div>
                      )}
                      <MemoCanvasArtwork
                        group={group}
                        glyphName={glyphName}
                        ink={ink}
                        inkFade={inkFade}
                        inkColor={inkColor}
                        inkOpacity={inkOpacity}
                        isPlaying={previewPlaying}
                        showGrid={showGrid}
                        showSkeleton={showSkeleton}
                        canvasLocked={referenceNeedsEntry}
                        drawMode={drawMode}
                        tracePoints={tracePoints}
                        traceEcho={traceEcho}
                        selectedStrokes={selectedStrokes}
                        marquee={marquee}
                        selectedPoint={selectedPoint}
                        unitPx={group && canvasPx ? canvasPx / group.vb : 1}
                        onStartDrag={startDrag}
                        onTracePointerDown={tracePointerDown}
                        onTracePointerMove={tracePointerMove}
                        onTracePointerUp={tracePointerUp}
                        onTracePointerCancel={tracePointerCancel}
                        svgRef={svgRef}
                      />
                    </div>
                  </section>
                  <span className="canvas-selection canvas-selection--outside" data-active={selectedStrokes.length > 0 || drawMode} role="status">
                    {drawMode ? `描摹中 · ${TRACE_MODES.find((mode) => mode.value === traceMode)?.label ?? ""}` : selectedStrokes.length ? `已选 ${selectedStrokes.length} 笔` : `${currentItems.length} 个笔画`}
                  </span>
                </div>
                <div className="tools" role="group" aria-label="画布操作">
                  <ToolButton label="印刷体底图" active={underlay} onClick={() => setUnderlay((value) => !value)}>{UnderIcon}</ToolButton>
                  <ToolButton label="网格" active={showGrid} onClick={() => setShowGrid((value) => !value)}>{GridToolIcon}</ToolButton>
                  <ToolButton label="骨架" active={showSkeleton} onClick={() => setShowSkeleton((value) => !value)}>{BoneIcon}</ToolButton>
                  <span className="sep" />
                  <label className={`write-content${referenceNeedsEntry ? " is-reference-required" : ""}`} htmlFor="reference-glyph">
                    <input
                      id="reference-glyph"
                      ref={referenceInputRef}
                      type="text"
                      value={referenceText}
                      onChange={(event) => setReferenceText(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        const key = event.key.toLowerCase();
                        if (event.key === "Enter" || ((event.metaKey || event.ctrlKey) && key === "s")) {
                          event.preventDefault();
                          event.stopPropagation();
                          void save().then((saved) => {
                            if (saved) showSaveToast();
                          });
                        }
                      }}
                      onFocus={(event) => event.currentTarget.select()}
                      aria-label="当前字形 / 参考字"
                      aria-required={referenceNeedsEntry}
                      spellCheck={false}
                    />
                  </label>
                  <Select.Root value={referenceFont} onValueChange={setReferenceFont}>
                    <Select.Trigger className="select-trigger reference-font-select" aria-label="参考字体">
                      <Select.Value />
                      <Select.Icon><ChevronDownIcon className="pika-ui-icon" /></Select.Icon>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content className="select-content reference-font-content" position="popper" sideOffset={6}>
                        <Select.Viewport>
                          {REFERENCE_FONTS.map((font) => (
                            <Select.Item className="select-item" value={font.value} key={font.value}>
                              <Select.ItemText>{font.label}</Select.ItemText>
                              <Select.ItemIndicator><CheckIcon className="pika-ui-icon" /></Select.ItemIndicator>
                            </Select.Item>
                          ))}
                        </Select.Viewport>
                      </Select.Content>
                    </Select.Portal>
                  </Select.Root>
                  <span className="sep tools-save-sep" aria-hidden="true" />
                  <div className="save-action">
                    <button
                      className="save-button"
                      type="button"
                      disabled={referenceNeedsEntry}
                      aria-label="保存字形"
                      onClick={() => {
                        void save().then((saved) => {
                          if (saved) showSaveToast();
                        });
                      }}
                    >
                      保存
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="help-anchor" ref={helpRef}>
              <div className="zoom-controls zoom-controls--corner" role="group" aria-label="画布缩放">
                <IconButton label="缩小（⌘/Ctrl−）" onClick={() => setZoomClamped(zoom / 1.15)}><MinusIcon className="pika-ui-icon" /></IconButton>
                <button className="zoom-readout" onClick={() => setZoom(1)} title="回到 100%（⌘/Ctrl0）">{Math.round(zoom * 100)}%</button>
                <IconButton label="放大（⌘/Ctrl+）" onClick={() => setZoomClamped(zoom * 1.15)}><PlusIcon className="pika-ui-icon" /></IconButton>
              </div>
              <button
                className="help-button"
                type="button"
                data-open={helpOpen}
                aria-expanded={helpOpen}
                aria-controls="editor-help"
                title="快捷键与规矩"
                onClick={() => setHelpOpen((value) => !value)}
              >
                ?
              </button>
              {helpOpen && (
                <div className="help-pop" id="editor-help" role="dialog" aria-label="快捷键与规矩">
                  <b>这是什么</b>
                  拖动智能识别的锚点调整结构，预览线条会实时更新。
                  画布下方的当前字形 / 参考字可以输入多个字，但画布参考字只显示第一个字；保存成功后输入框会只保留第一个字，并用它更新当前字形名称，同名则自动进入下一个变体。
                  <b>画布编辑</b>
                  空白处 <ShortcutKey label="拖动" icon={<MouseIcon />} /> 框选，<ShortcutKey label="Shift" /> 点击增减选择，<ShortcutKey label="Shift" /> 框选追加。<ShortcutKey label="拖动" icon={<MouseIcon />} /> 选中笔画可一起移动，<ShortcutKey label="Esc" /> 清空，<span className="shortcut-sequence"><ShortcutModifier /><ShortcutKey label="A" /></span> 全选。
                  <b>快捷键</b>
                  <div className="shortcut-list">
                    <div className="row">
                    <span>删除笔画 / 字形</span>
                    <span className="shortcut-keys">
                      <ShortcutKey label="Delete" icon={<ShortcutDeleteIcon />} iconOnly />
                    </span>
                    </div>
                    <div className="row">
                    <span>撤销 / 重做</span>
                    <span className="shortcut-keys shortcut-keys--stacked">
                      <span className="shortcut-sequence">
                        <ShortcutModifier />
                        <ShortcutKey label="Z" />
                      </span>
                      <span className="shortcut-sequence">
                        <ShortcutModifier />
                        <ShortcutKey label="Shift" />
                        <ShortcutKey label="Z" />
                      </span>
                    </span>
                    </div>
                    <div className="row">
                    <span>保存（输入框回车也可）</span>
                    <span className="shortcut-keys">
                      <ShortcutModifier />
                      <ShortcutKey label="S" />
                    </span>
                    </div>
                    <div className="row">
                    <span>画布缩放</span>
                    <span className="shortcut-keys">
                      <ShortcutModifier />
                      <ShortcutKey label="+" />
                      <span className="shortcut-sequence-divider" aria-hidden="true">/</span>
                      <ShortcutKey label="-" />
                    </span>
                    </div>
                    <div className="row">
                    <span>缩放（滚轮）</span>
                    <span className="shortcut-keys">
                      <ShortcutModifier />
                      <ShortcutKey label="滚轮" icon={<MouseIcon />} />
                    </span>
                    </div>
                    <div className="row">
                    <span>收起 / 展开两侧面板</span>
                    <span className="shortcut-keys">
                      <ShortcutKey label="[" />
                      <ShortcutKey label="]" />
                    </span>
                    </div>
                    <div className="row">
                    <span>拖动时不吸格</span>
                    <span className="shortcut-keys"><ShortcutKey label="Alt" /></span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="rowbar" data-open={rowOpen}>
            <div className="rowbar-head">
              <b>预览</b>
              <span className="spacer" />
              <div className="metrics-anchor" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setMetricsOpen(false); } }}>
                <button className="metrics-toggle" type="button" aria-label="逐字数据" title="逐字数据" aria-expanded={metricsOpen} aria-controls="glyph-metrics" onClick={() => setMetricsOpen((open) => !open)}>
                  <MetricsIcon />
                </button>
                {metricsOpen && (
                  <section className="metrics-panel" id="glyph-metrics" aria-label="逐字数据">
                    <div className="metrics-panel-head">
                      <strong>逐字数据</strong><span>{allMetrics.length} 字</span>
                      <IconButton label="收起逐字数据" className="icon-button--square" onClick={() => setMetricsOpen(false)}><Cross2Icon className="pika-ui-icon" /></IconButton>
                    </div>
                    <div className="metrics-scroll">
                      <table className="metrics-table">
                        <thead><tr><th scope="col">字形</th><th scope="col">大小</th><th scope="col">行内偏差</th><th scope="col">相邻差</th></tr></thead>
                        <tbody>{metricRows.map((cell, index) => (
                          <tr className={cell.thin ? "thin" : undefined} key={`${cell.name}-${index}`}>
                            <th scope="row">{cell.name == null ? "·" : glyphLabel(cell.name)}</th>
                            <td>{cell.s.toFixed(3)}</td>
                            <td
                              className={`metrics-size-delta${cell.sizeAlert ? ` ${cell.sizeAlert}` : ""}`}
                              title={cell.sizeDelta === null
                                ? undefined
                                : `${cell.sizeAlert === "large" ? "偏大" : cell.sizeAlert === "small" ? "偏小" : "正常"}，相对本行中位大小 ${cell.sizeDelta >= 0 ? "+" : ""}${cell.sizeDelta.toFixed(1)}%`}
                            >
                              {cell.sizeDelta === null ? "—" : (
                                <>
                                  {cell.sizeAlert && <small>{cell.sizeAlert === "large" ? "偏大" : "偏小"}</small>}
                                  {cell.sizeDelta >= 0 ? "+" : ""}{cell.sizeDelta.toFixed(1)}%
                                </>
                              )}
                            </td>
                            <td>{cell.diff === null ? "—" : `${cell.diff.toFixed(1)}%`}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                      {!allMetrics.length && <div className="empty-state">正在计算逐字数据…</div>}
                    </div>
                    <p className="metrics-note">浅红标记：相邻大小差小于 3.5%；行内偏差超过 ±6% 会提示偏大或偏小</p>
                  </section>
                )}
              </div>
              <IconButton
                label={rowOpen ? "折叠" : "展开"}
                className="icon-button--square"
                onClick={() => setRowOpen((value) => !value)}
              >
                <ChevronDownIcon className="pika-ui-icon" />
              </IconButton>
            </div>
            {rowResult?.svg ? (
              <>
                <div className="rowbar-art">
                  <div
                    className={`rowbar-svg${previewPlaying ? " is-playing" : ""}`}
                    dangerouslySetInnerHTML={{
                      __html: rowPreviewSvg(rowResult.svg, viewHeight, rowResult.ratio, previewPlaying, rowInkStyles),
                    }}
                  />
                </div>

              </>
            ) : <div className="rowbar-art is-empty">{rowLine ? "正在排整段…" : "这个字库还没有字"}</div>}
          </div>
        </div>

        {saveToastOpen && <span className="save-toast" role="status" aria-live="polite">已保存</span>}
        {/* setError 原来只有整页错误屏读得到 —— 字库加载之后报的错全是哑的。
            这条跟「已保存」同一个位置，点一下或者几秒后自己消失。 */}
        {!!error && (
          <button className="save-toast" type="button" role="alert" onClick={() => setError("")}>
            {error}
          </button>
        )}

        {/* ── 悬浮：缩放 ───────────────────────────────────────────── */}
        <div className="hud hud-top">
          <div className="hud-top-right">
            <div className="preview-control-wrap" role="group" aria-label="预览控制">
              <IconButton
                label={previewPlaying ? "暂停预览" : "播放预览"}
                tooltipLabel="揺らぎ"
                className={`icon-button--square preview-control preview-control--play${previewPlaying ? " is-on" : ""}`}
                aria-pressed={previewPlaying}
                onClick={() => setPreviewPlaying((value) => !value)}
              >
                <PreviewPlaybackIcon paused={previewPlaying} />
              </IconButton>
              <IconButton
                label="展示整段预览"
                tooltipLabel="𓂀 ꙮ ᛝ ⸸ 𐌗𐌏𐌗 ⸸ ᛝ ꙮ 𓂀"
                className="icon-button--square preview-control preview-control--showcase"
                disabled={!rowResult?.svg}
                onClick={() => rowResult?.svg && setShowcase({ svg: colorizeRowSvg(rowResult.svg, rowInkStyles), ratio: rowResult.ratio || 1 })}
              >
                <PreviewEggIcon />
              </IconButton>
            </div>
          </div>
        </div>

        {/* ── 左面板：字库 ─────────────────────────────────────── */}
        <aside className="panel panel--left" data-collapsed={!leftOpen} aria-hidden={!leftOpen}>
          <div className="panel-head">
            <h1>字库</h1>
            <IconButton label="收起字库（[）" className="icon-button--square" onClick={() => setLeftOpen(false)}><PanelGlyph side="left" /></IconButton>
          </div>
          <Section
            title="新建"
            className="section--library section--library-file"
            open={!!openSections.library}
            onOpenChange={toggleSection("library")}
          >
            <div className="library-file">
              <div className="library-file-actions library-mode-cards">
                <button className="library-mode-card" type="button" onClick={() => handleDocumentNew("han")}>
                  <span className="library-mode-card-icon library-mode-card-icon--han" aria-hidden="true">Han</span>
                  <span className="library-mode-card-title">汉字</span>
                </button>
                <button className="library-mode-card" type="button" onClick={() => handleDocumentNew("latin")}>
                  <span className="library-mode-card-icon library-mode-card-icon--latin" aria-hidden="true">Latin</span>
                  <span className="library-mode-card-title">拉丁<small>（英文）</small></span>
                </button>
              </div>
            </div>
          </Section>

          <Section
            title="描摹"
            className="section--library section--library-strokes"
            open={!!openSections.strokes}
            onOpenChange={toggleSection("strokes")}
          >
            <div className="drawing-actions" role="group" aria-label="描摹方式">
              {TRACE_MODES.map((mode) => {
                const active = drawMode && traceMode === mode.value;
                return (
                  <button
                    key={mode.value}
                    className={`drawing-action ${active ? "active" : ""}`}
                    type="button"
                    disabled={referenceNeedsEntry}
                    aria-pressed={active}
                    onClick={() => pickTraceMode(mode.value)}
                  >
                    <span className="drawing-action-icon">{mode.icon}</span>
                    <span className="drawing-action-copy">
                      <strong>{mode.label}</strong>
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="trace-hint" data-live={drawMode ? "true" : "false"} role="status">
              {traceStatus
                || (drawMode
                  ? `${TRACE_MODES.find((mode) => mode.value === traceMode)?.hint ?? ""}再点一次结束描摹。`
                  : "挑一种落笔方式，然后在字面上拖动写笔画。")}
            </p>
          </Section>

          <Section
            title="字形"
            className="section--library section--library-glyphs"
            open={!!openSections.libraryGlyphs}
            onOpenChange={toggleSection("libraryGlyphs")}
            indicator={<PlusIcon className="pika-ui-icon" />}
            indicatorLabel="添加字形（单击选择，双击快速添加单字）"
            indicatorHasMenu
            indicatorAction={openBatchAddMenuFromClick}
            indicatorDoubleAction={quickAddGlyph}
          >
            <div
              className="panel-scroll glyph-list"
              data-dragging={dragName ? "true" : "false"}
              onPointerMove={moveGlyphPointerDrag}
              onPointerUp={(event) => {
                if (glyphDragRef.current?.pointerId !== event.pointerId) return;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                finishGlyphDrag(event.clientX, event.clientY);
              }}
              onPointerCancel={(event) => {
                if (glyphDragRef.current?.pointerId !== event.pointerId) return;
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  event.currentTarget.releasePointerCapture(event.pointerId);
                }
                cancelGlyphDrag();
              }}
              onPointerLeave={(event) => {
                const drag = glyphDragRef.current;
                if (drag?.pointerId === event.pointerId && !drag.active) cancelGlyphDrag();
              }}
            >
                {visibleNames.length ? visibleNames.map((name) => {
                  const info = glyphInfo(name);
                  const style = inkStyleFor(name);
                  return (
                    <div
                      className={`glyph-row ${name === glyphName ? "selected" : ""}${dragName === name ? " dragging" : ""}`}
                      key={name}
                      ref={(element) => {
                        if (element) glyphRowRefs.current.set(name, element);
                        else glyphRowRefs.current.delete(name);
                      }}
                      data-glyph-name={name}
                      data-dragging={dragName === name ? "true" : "false"}
                      onPointerDown={(event) => beginGlyphPointerDrag(event, name)}
                    >
                      <button className="glyph-select" onClick={() => setGlyph(name)} aria-label={isDraftGlyph(name) ? "未命名空白字形" : undefined}>
                        <span className="thumb-wrap"><MemoGlyphThumbnail group={group} name={name} index={names.indexOf(name)} color={style.color} opacity={style.opacity} /></span>
                        <span className="glyph-copy">
                          <span className="glyph-name">{info.base}{info.variant > 1 && <small>#{info.variant}</small>}</span>
                        </span>
                      </button>
                      <DropdownMenu.Root>
                        <DropdownMenu.Trigger asChild>
                          <button className="row-menu" aria-label={`更多操作：${glyphLabel(name) || "未命名空白字形"}`}><MoreGlyph /></button>
                        </DropdownMenu.Trigger>
                        <DropdownMenu.Portal>
                            <DropdownMenu.Content className="menu-content" sideOffset={4} align="end" alignOffset={-6}>
                            <DropdownMenu.Item className="menu-item" onSelect={() => copyGlyph(name)}>
                              <CopyIcon className="pika-ui-icon" aria-hidden="true" />
                              <span>复制字形</span>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item className="menu-item danger" disabled={names.length <= 1} onSelect={() => removeGlyph(name)}>
                              <TrashIcon className="pika-ui-icon" aria-hidden="true" />
                              <span>移除字形</span>
                            </DropdownMenu.Item>
                          </DropdownMenu.Content>
                        </DropdownMenu.Portal>
                      </DropdownMenu.Root>
                    </div>
                  );
                }) : <div className="empty-state">没有字形</div>}
            </div>
          </Section>

        </aside>

        <button
          className="panel-stub panel-stub--left"
          data-hidden={leftOpen}
          aria-label="展开字库（[）"
          tabIndex={leftOpen ? -1 : 0}
          onClick={() => setLeftOpen(true)}
        >
          <span className="panel-stub-inner">
            <span>字库</span>
            <PanelGlyph side="left" />
          </span>
        </button>

        {/* ── 右面板：编辑 ─────────────────────────────────────── */}
        <aside className="panel panel--right" data-collapsed={!rightOpen} aria-hidden={!rightOpen}>
          <div className="panel-head">
            <h2>编辑</h2>
            <IconButton label="收起编辑（]）" className="icon-button--square" onClick={() => setRightOpen(false)}><PanelGlyph side="right" /></IconButton>
          </div>

          <div className="panel-scroll">
            <Section
              title="颜色"
              className="color-section"
              open={!!openSections.color}
              onOpenChange={toggleSection("color")}
            >
              <InkColorField
                color={inkColor}
                opacity={inkOpacity}
                onColorChange={setInkColor}
                onOpacityChange={setInkOpacity}
              />
            </Section>

            <Section
              title="单字"
              open={!!openSections.glyph}
              onOpenChange={toggleSection("glyph")}
            >
              <div className="field-stack">
                <SliderField
                  label="抖动"
                  value={ampStroke === null ? 1 : strokeAmp(ampStroke)}
                  min={0}
                  max={2}
                  step={0.05}
                  disabled={ampStroke === null}
                  formatValue={(value) => ampStroke === null ? "选中笔画" : mixedAmp ? "混合" : formatNumber(value)}
                  onChange={setStrokeAmpValue}
                />
                {isCurrentGlyphLatin && (
                  <SliderField
                    label="字后"
                    value={currentAdvance}
                    min={10}
                    max={58}
                    step={1}
                    formatValue={(value) => String(Math.round(value))}
                    onChange={setGlyphAdvance}
                  />
                )}
                <div className="switch-row">
                  <span>跟随全局种子</span>
                  <button
                    type="button"
                    className="switch-button"
                    role="switch"
                    aria-label="跟随全局种子"
                    aria-checked={localSeed === null}
                    data-checked={localSeed === null}
                    onClick={() => setGlyphSeedFollow(localSeed !== null)}
                  >
                    <span className="switch-track"><span /></span>
                  </button>
                </div>
                <SliderField
                  label="单字种子"
                  value={localSeed ?? rememberedSeed ?? 0}
                  min={1}
                  max={999}
                  step={1}
                  disabled={localSeed === null}
                  formatValue={(value) => localSeed === null ? "全局" : String(Math.round(value))}
                  onChange={(value) => setLocalSeed(value)}
                />
              </div>
            </Section>

            <Section
              title="全局手感"
              open={!!openSections.craft}
              onOpenChange={toggleSection("craft")}
            >
              <div className="field-stack">
                {groupParams.map((parameter) => (
                  <SliderField
                    key={parameter.key}
                    label={parameter.label}
                    value={group[parameter.key]}
                    min={parameter.min}
                    max={parameter.max}
                    step={parameter.step}
                    suffix={parameter.suffix}
                    onChange={(value) => updateGlyphsAndSave({ [parameter.key]: value })}
                  />
                ))}
              </div>
            </Section>

            <Section
              title="全局种子"
              open={!!openSections.seed}
              onOpenChange={toggleSection("seed")}
            >
              <div className="field-stack">
                <SliderField label="种子" value={viewSeed} min={1} max={999} step={1} onChange={setViewSeedAndSave} />
              </div>
            </Section>

            <Section
              title="排版"
              className="layout-section"
              open={!!openSections.layout}
              onOpenChange={toggleSection("layout")}
            >
              <div className="layout-editor">
                <div className="field-stack layout-spacing">
                  <SliderField
                    label="字距"
                    value={rowTrack}
                    min={-12}
                    max={24}
                    step={1}
                    formatValue={(value) => String(Math.round(value))}
                    onChange={setRowTrackAndSave}
                  />
                </div>
              </div>
            </Section>

            <Section
              title="导出"
              open={!!openSections.export}
              onOpenChange={toggleSection("export")}
            >
              <div className="export-section-content">
                <div className="export-stack">
                  <div className="export-control-row export-control-row--scope">
                    <Select.Root value={exportScope} onValueChange={(value) => setExportScopeAndSave(value as ExportScope)}>
                      <Select.Trigger className="select-trigger export-select" aria-label="导出范围">
                        <Select.Value />
                        <Select.Icon><ChevronDownIcon className="pika-ui-icon" /></Select.Icon>
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content className="select-content export-select-content export-scope-content" position="popper" sideOffset={6}>
                          <Select.Viewport>
                            <Select.Item className="select-item" value="row">
                              <Select.ItemText>整段导出</Select.ItemText>
                              <Select.ItemIndicator><CheckIcon className="pika-ui-icon" /></Select.ItemIndicator>
                            </Select.Item>
                            <Select.Item className="select-item" value="glyphs">
                              <Select.ItemText>单字导出</Select.ItemText>
                              <Select.ItemIndicator><CheckIcon className="pika-ui-icon" /></Select.ItemIndicator>
                            </Select.Item>
                          </Select.Viewport>
                        </Select.Content>
                      </Select.Portal>
                    </Select.Root>
                  </div>

                  <div className="export-control-row">
                    <Select.Root
                      value={exportScale}
                      disabled={exportFormat === "svg"}
                      onValueChange={setExportScaleAndSave}
                    >
                      <Select.Trigger className="select-trigger export-select" aria-label={`导出倍率 ${exportScale}x`}>
                        <Select.Value />
                        <Select.Icon><ChevronDownIcon className="pika-ui-icon" /></Select.Icon>
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content className="select-content export-select-content export-scale-content" position="popper" sideOffset={6}>
                          <Select.Viewport>
                            {EXPORT_SCALES.map((value) => (
                              <Select.Item className="select-item" value={value} key={value}>
                                <Select.ItemText>{value}x</Select.ItemText>
                                <Select.ItemIndicator><CheckIcon className="pika-ui-icon" /></Select.ItemIndicator>
                              </Select.Item>
                            ))}
                          </Select.Viewport>
                        </Select.Content>
                      </Select.Portal>
                    </Select.Root>

                    <Select.Root value={exportFormat} onValueChange={(value) => setExportFormatAndSave(value as ExportFormat)}>
                      <Select.Trigger className="select-trigger export-select" aria-label="导出格式">
                        <Select.Value />
                        <Select.Icon><ChevronDownIcon className="pika-ui-icon" /></Select.Icon>
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content className="select-content export-select-content" position="popper" sideOffset={6}>
                          <Select.Viewport>
                            {[{ value: "png", label: "PNG" }, { value: "svg", label: "SVG" }].map((option) => (
                              <Select.Item className="select-item" value={option.value} key={option.value}>
                                <Select.ItemText>{option.label}</Select.ItemText>
                                <Select.ItemIndicator><CheckIcon className="pika-ui-icon" /></Select.ItemIndicator>
                              </Select.Item>
                            ))}
                          </Select.Viewport>
                        </Select.Content>
                      </Select.Portal>
                    </Select.Root>
                  </div>

                  <button
                    className="export-action"
                    type="button"
                    onClick={() => void exportContent()}
                    disabled={exportBusy || (exportScope === "row" ? !rowResult?.svg : !names.length)}
                  >
                    <DownloadIcon className="pika-ui-icon" />
                    <span>{exportBusy ? "导出中…" : "导出"}</span>
                  </button>
                  {exportMessage && <p className="export-message" role="status">{exportMessage}</p>}

                  {/* 导出的是图，这两个进出的是**几何 JSON** —— 骨架、手感、种子都在里面。
                      浏览器那个槽位只防手滑，真正带走这一版靠下载。 */}
                  <div className="export-file-row">
                    <button className="library-file-action" type="button" onClick={() => downloadDocument()}>
                      下载工程文件
                    </button>
                    <button className="library-file-action" type="button" onClick={() => libraryFileRef.current?.click()}>
                      打开工程文件
                    </button>
                  </div>
                  <input
                    ref={libraryFileRef}
                    className="library-file-input"
                    type="file"
                    accept="application/json,.json"
                    onChange={(event) => {
                      void handleDocumentOpen(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                </div>
              </div>
            </Section>
          </div>

        </aside>

        <button
          className="panel-stub panel-stub--right"
          data-hidden={rightOpen}
          aria-label="展开编辑（]）"
          tabIndex={rightOpen ? -1 : 0}
          onClick={() => setRightOpen(true)}
        >
          <span className="panel-stub-inner">
            <span>编辑</span>
            <PanelGlyph side="right" />
          </span>
        </button>

        {batchAddMenu && (
          <div
            ref={batchAddMenuRef}
            className="batch-add-menu"
            role="menu"
            aria-label="字形添加方式"
            style={{ left: batchAddMenu.x, top: batchAddMenu.y }}
          >
            <button className="batch-add-menu-item" type="button" role="menuitem" autoFocus onClick={addSingleGlyphFromMenu}>
              <PlusIcon className="pika-ui-icon" aria-hidden="true" />
              <span className="batch-add-menu-copy">
                <strong>添加单字<small>（双击）</small></strong>
              </span>
            </button>
            <button className="batch-add-menu-item" type="button" role="menuitem" onClick={openBatchAddDialog}>
              <CopyIcon className="pika-ui-icon" aria-hidden="true" />
              <span className="batch-add-menu-copy">
                <strong>批量添加字形</strong>
              </span>
            </button>
          </div>
        )}

        {/* ── 批量添加字形 ───────────────────────────────────────────── */}
        <Dialog.Root
          open={batchAddOpen}
          onOpenChange={(open) => {
            setBatchAddOpen(open);
            if (!open) {
              setBatchAddText("");
              setBatchAddError("");
            }
          }}
        >
          <Dialog.Portal>
            <Dialog.Overlay className="batch-add-overlay" />
            <Dialog.Content className="batch-add-content">
              <div className="batch-add-head">
                <Dialog.Title className="batch-add-title">批量添加字形</Dialog.Title>
              </div>
              <form onSubmit={(event) => { event.preventDefault(); batchAddGlyphs(); }}>
                <textarea
                  className="batch-add-textarea"
                  value={batchAddText}
                  onChange={(event) => { setBatchAddText(event.currentTarget.value); setBatchAddError(""); }}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                      event.preventDefault();
                      batchAddGlyphs();
                    }
                  }}
                  placeholder={`输入文字（最多 ${BATCH_ADD_LIMIT} 个字形）`}
                  rows={2}
                  autoFocus
                  spellCheck={false}
                  aria-label="要批量添加的文字"
                />
                {batchAddPlan.length > 0 ? (
                  <div className="batch-add-summary">
                    <div className="batch-add-summary-head">
                      <strong>将添加 {batchAddPlan.length} 个字形</strong>
                    </div>
                    <div className="batch-add-preview" aria-label="批量添加预览">
                      {batchAddPlan.slice(0, 20).map((entry, index) => (
                        <span className="batch-add-chip" key={`${entry.name}-${index}`}>
                          <span>{entry.character}</span>
                          {entry.variant > 1 && <small>#{entry.variant}</small>}
                        </span>
                      ))}
                      {batchAddPlan.length > 20 && <span className="batch-add-more">+{batchAddPlan.length - 20}</span>}
                    </div>
                  </div>
                ) : null}
                {batchAddOverLimit && (
                  <p className="batch-add-error" role="alert">最多添加 {BATCH_ADD_LIMIT} 个字形，请删减输入内容。</p>
                )}
                {batchAddError && <p className="batch-add-error" role="alert">{batchAddError}</p>}
                <div className="batch-add-actions">
                  <Dialog.Close asChild>
                    <button className="batch-add-cancel" type="button">取消</button>
                  </Dialog.Close>
                  <button className="batch-add-submit" type="submit" disabled={!batchAddPlan.length || batchAddOverLimit}>
                    添加
                  </button>
                </div>
              </form>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>

        {/* ── 展示：全白画面，按笔顺把这段话写一遍 ───────────────────────── */}
        <Dialog.Root open={!!showcase} onOpenChange={(open) => { if (!open) setShowcase(null); }}>
          <Dialog.Portal>
            <Dialog.Overlay className="showcase-overlay" />
            <Dialog.Content className="showcase-content">
              <Dialog.Title className="showcase-title">展示</Dialog.Title>
              {showcase && (
                <ShowcaseStage svg={showcase.svg} ratio={showcase.ratio} name={rowLine} onClose={() => setShowcase(null)} />
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </Tooltip.Provider>
  );
}
