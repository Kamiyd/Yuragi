import * as React from "react";
import * as Collapsible from "@radix-ui/react-collapsible";
import * as Dialog from "@radix-ui/react-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as Select from "@radix-ui/react-select";
import * as Tooltip from "@radix-ui/react-tooltip";
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CommandIcon,
  CopyIcon,
  CrossIcon as Cross2Icon,
  DeleteKeyIcon as ShortcutDeleteIcon,
  DownloadIcon,
  FileIcon as ProjectFileIcon,
  MinusIcon,
  MouseIcon,
  PlusIcon,
  TrashIcon,
} from "./icons";
import DraggableInput from "./DraggableInput";
import {
  DEFAULT_LATIN_ADV,
  createDocument,
  downloadDocument,
  importDocument,
  requestJSON,
} from "../lib/api";
import { orderedGlyphNames } from "../lib/core/library";
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
  glyphOrder?: string[];
  /** 文档级画布视图开关；不随当前单字切换。 */
  underlay?: boolean;
  showGrid?: boolean;
  showSkeleton?: boolean;
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

type PreviewResizeState = {
  pointerId: number;
  startY: number;
  startHeight: number;
};

type RenderPath = { d: string; f?: boolean; w?: number };
/** 这一版墨线里哪些是刚长出来的（淡入），哪些是刚被撤掉的（留个影子淡出）。 */
type InkFade = { enter: Set<string>; leave: RenderPath[] };

/** 整行渲染的返回。右边那张逐字大小表就是靠 table 画的。 */
type RowCell = { name: string | null; s: number; diff: number | null; thin: boolean };
type RowResult = { svg: string; table: RowCell[]; miss: string[]; ratio: number; vb?: [number, number]; lineCount?: number };
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
    <TooltipHint label={label}>
      <kbd className={`shortcut-key${iconOnly ? " shortcut-key--icon" : ""}`} aria-label={label}>
        {icon && <span className="shortcut-key-icon" aria-hidden="true">{icon}</span>}
        {!iconOnly && <span>{label}</span>}
      </kbd>
    </TooltipHint>
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

type TooltipHintProps = {
  label: React.ReactNode;
  children: React.ReactElement;
};

function TooltipHint({ label, children }: TooltipHintProps) {
  if (label == null || label === "") return children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" sideOffset={8}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

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
const SOURCE_REPO_URL = "https://github.com/Kamiyd/Yuragi";
// Skill 下载地址预留位：填上链接后「更多」卡片里的下载按钮自动可用。
const SKILL_DOWNLOAD_URL = "";
const PREVIEW_MIN_HEIGHT = 88;
// 预览高度最多容纳约四行；更多内容在预览区内部滚动。
const PREVIEW_MAX_HEIGHT = 248;
const PREVIEW_STAGE_RESERVE = 160;

function previewHeightBounds(): [number, number] {
  const max = typeof window === "undefined"
    ? PREVIEW_MAX_HEIGHT
    : Math.min(PREVIEW_MAX_HEIGHT, Math.max(PREVIEW_MIN_HEIGHT, window.innerHeight - PREVIEW_STAGE_RESERVE));
  return [PREVIEW_MIN_HEIGHT, max];
}

function clampPreviewHeight(value: number) {
  const [min, max] = previewHeightBounds();
  return Math.round(Math.max(min, Math.min(max, value)));
}
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
  if (Array.isArray(record.glyphOrder)) {
    const order: string[] = [];
    const seen = new Set<string>();
    for (const value of record.glyphOrder) {
      const name = String(value);
      if (!seen.has(name)) {
        seen.add(name);
        order.push(name);
      }
    }
    if (order.length) next.glyphOrder = order;
  }
  if (typeof record.underlay === "boolean") next.underlay = record.underlay;
  if (typeof record.showGrid === "boolean") next.showGrid = record.showGrid;
  if (typeof record.showSkeleton === "boolean") next.showSkeleton = record.showSkeleton;

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
    // `currentColor` is convenient in the browser, but Figma's SVG importer
    // does not reliably resolve it from a root `color` presentation attribute.
    // Make the root paint explicit while retaining `color` for the live
    // preview/showcase code that reads the computed ink color.
    const compatibleAttributes = withoutColor.replace(
      /\b(stroke|fill)="currentColor"/gi,
      (_paint, property) => `${property}="${safeColor}"`,
    );
    return `<svg${compatibleAttributes} color="${safeColor}" opacity="${safeOpacity.toFixed(3)}">`;
  });
}

/** 将一组路径里的 currentColor 解析成显式颜色，保证 SVG 导入器能读到。 */
function explicitSvgPaint(markup: string, color: string) {
  const safeColor = normalizeHexColor(color);
  return markup.replace(
    /\b(stroke|fill)="currentColor"/gi,
    (_paint, property) => `${property}="${safeColor}"`,
  );
}

/* 导出：单字导出当前选中的字形，整段导出单独保持一行连续排版。 */
const UTF8 = new TextEncoder();
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

async function copyTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.top = "-9999px";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  const legacyDocument = document as unknown as { execCommand?: (command: string) => boolean };
  const copied = legacyDocument.execCommand?.("copy") ?? false;
  input.remove();
  if (!copied) throw new Error("当前浏览器不允许访问剪贴板");
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
  return info.variant > 1 ? `${info.base} #${info.variant}` : info.base;
}

function orderedProjectStem(names: string[]) {
  const stem = names
    .filter((name) => !isDraftGlyph(name))
    .map(glyphLabel)
    .filter(Boolean)
    .join("");
  return exportSafeName(stem || "手写字");
}

function orderedProjectFilename(names: string[]) {
  return `${orderedProjectStem(names)}.json`;
}

function GlyphLabel({ name, className = "glyph-label" }: { name: string; className?: string }) {
  if (isDraftGlyph(name)) return null;
  const info = glyphInfo(name);
  return (
    <span className={className}>
      {info.base}
      {info.variant > 1 && <small>#{info.variant}</small>}
    </span>
  );
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
  const glyphOrder = orderedGlyphNames(library.items, library.editor?.glyphOrder)
    .map((entry) => entry === from ? name : entry);
  const items: Record<string, EditableElement[]> = {};
  for (const [entry, value] of Object.entries(library.items)) {
    items[entry === from ? name : entry] = value;
  }

  const glyphSeeds = { ...(library.glyphSeeds || {}) };
  if (Object.hasOwn(glyphSeeds, from)) {
    glyphSeeds[name] = glyphSeeds[from];
    delete glyphSeeds[from];
  }

  const next: GlyphLibrary = {
    ...library,
    items,
    glyphSeeds,
    editor: { ...(library.editor || {}), glyphOrder },
  };
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

type SvgBounds = { x: number; y: number; width: number; height: number };

function svgNumber(value: number) {
  const rounded = Number(value.toFixed(3));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

/** 单字导出只保留笔画范围，避免 Figma 把整块 64×64 画布当成外框。 */
function measureGlyphBounds(paths: RenderPath[], group: GlyphLibrary): SvgBounds {
  const fallback = { x: 0, y: 0, width: group.vb, height: group.vb };
  if (typeof document === "undefined" || !document.body || paths.length === 0) return fallback;

  const svgNs = "http://www.w3.org/2000/svg";
  const host = document.createElement("div");
  host.style.cssText = "position:absolute;left:-100000px;top:-100000px;width:1px;height:1px;visibility:hidden;pointer-events:none";
  const svg = document.createElementNS(svgNs, "svg");
  const drawing = document.createElementNS(svgNs, "g");
  svg.setAttribute("viewBox", `0 0 ${group.vb} ${group.vb}`);
  svg.setAttribute("width", "1");
  svg.setAttribute("height", "1");
  drawing.setAttribute("fill", "none");
  drawing.setAttribute("stroke-linecap", "round");
  drawing.setAttribute("stroke-linejoin", "round");

  let strokePadding = 0;
  for (const path of paths) {
    const element = document.createElementNS(svgNs, "path");
    element.setAttribute("d", path.d);
    if (path.f) {
      element.setAttribute("fill", "#000000");
      element.setAttribute("stroke", "none");
    } else {
      const width = group.sw * (path.w || 1);
      element.setAttribute("fill", "none");
      element.setAttribute("stroke", "#000000");
      element.setAttribute("stroke-width", String(width));
      strokePadding = Math.max(strokePadding, width / 2);
    }
    drawing.appendChild(element);
  }

  svg.appendChild(drawing);
  host.appendChild(svg);
  document.body.appendChild(host);

  let bounds: DOMRect;
  try {
    bounds = drawing.getBBox();
  } catch {
    host.remove();
    return fallback;
  }
  host.remove();

  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)
    || bounds.width <= 0 || bounds.height <= 0) return fallback;

  const x = bounds.x - strokePadding;
  const y = bounds.y - strokePadding;
  return {
    x,
    y,
    width: bounds.width + strokePadding * 2,
    height: bounds.height + strokePadding * 2,
  };
}

function glyphExportSvg(paths: RenderPath[], group: GlyphLibrary, scale: number, color = DEFAULT_INK_COLOR, opacity = DEFAULT_INK_OPACITY) {
  const bounds = measureGlyphBounds(paths, group);
  const width = Math.max(1, Math.round(bounds.width * scale));
  const height = Math.max(1, Math.round(bounds.height * scale));
  const safeColor = normalizeHexColor(color);
  const safeOpacity = clampOpacity(opacity);
  // 和整段导出的 DOM 保持同一层级：SVG 根节点是 Figma 的外层 Frame，
  // 唯一的字形放在一个可直接选中的 Group 里；笔画仍然各自保留为 Vector。
  const body = paths.map((path) => path.f
    ? `<path d="${path.d}" fill="${safeColor}" stroke="none"/>`
    : `<path d="${path.d}"${path.w ? ` stroke-width="${(group.sw * path.w).toFixed(3)}"` : ""}/>`).join("");
  const glyph = `<g transform="translate(0 0)" color="${safeColor}" opacity="${safeOpacity.toFixed(3)}" stroke="${safeColor}">${body}</g>`;
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${svgNumber(bounds.x)} ${svgNumber(bounds.y)} ${svgNumber(bounds.width)} ${svgNumber(bounds.height)}" fill="none" stroke="${safeColor}" stroke-width="${group.sw}" stroke-linecap="round" stroke-linejoin="round" color="${safeColor}" opacity="1.000">${glyph}</svg>`,
    bounds,
  };
}

async function renderExportGlyphMarkup(group: GlyphLibrary, name: string, glyphIndex: number, scale: number, color = DEFAULT_INK_COLOR, opacity = DEFAULT_INK_OPACITY) {
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
  return glyphExportSvg(paths, group, scale, color, opacity);
}

async function renderExportGlyph(group: GlyphLibrary, name: string, glyphIndex: number, format: ExportFormat, scale: number, color = DEFAULT_INK_COLOR, opacity = DEFAULT_INK_OPACITY) {
  // 单字 SVG 复用整段导出的「根 Frame + 字形 Group」层级；PNG 仍保留逐笔线重。
  const rendered = await renderExportGlyphMarkup(group, name, glyphIndex, scale, color, opacity);
  if (format === "svg") return UTF8.encode(rendered.svg);
  const width = Math.max(1, Math.round(rendered.bounds.width * scale));
  const height = Math.max(1, Math.round(rendered.bounds.height * scale));
  return new Uint8Array(await (await svgToPng(rendered.svg, width, height)).arrayBuffer());
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
      // Keep `color` for CSS/computed-style consumers, but put the actual
      // paint on the glyph group and filled paths so Figma gets the same ink.
      return `<g transform="${transform}" color="${style.color}" opacity="${style.opacity.toFixed(3)}" stroke="${style.color}">${explicitSvgPaint(body, style.color)}</g>`;
    },
  );
}

function rowPreviewSvg(svg: string, height: number, ratio: number, lineCount: number, playing: boolean, styles: InkStyle[] = []) {
  const lines = Math.max(1, Math.trunc(lineCount || 1));
  // 多行 SVG 的总高度按“每行字号 + 行距”给，不能把整段再次压回一个 44px 高的框。
  const totalHeight = height * lines + Math.max(0, lines - 1) * 4;
  const sized = colorizeRowSvg(svg, styles).replace(
    "<svg",
    `<svg height="${totalHeight}" width="${(totalHeight * (ratio || 1)).toFixed(1)}"`,
  );
  const withFilter = sized.replace(
    /(<svg\b[^>]*>)/,
    `$1<defs>${previewBoilFilterMarkup("preview-boil-row", 3.4)}</defs>`,
  );
  return withFilter.replace(/<g transform="([^"]*)" color="([^"]*)" opacity="([^"]*)" stroke="([^"]*)">([\s\S]*?)<\/g>/g, (_match, transform, color, opacity, stroke, body) => (
    `<g transform="${transform}" color="${color}" opacity="${opacity}" stroke="${stroke}"><g class="preview-glyph"${playing ? ` filter="url(#preview-boil-row)"` : ""}>${body}</g></g>`
  ));
}

/* ── 展示：全白画面上按笔顺把这段话写一遍，并把这一遍导出成视频 / GIF ─────
   排程、画帧、编码都在 src/lib/showcase.ts —— 屏幕上动的是 SVG 的 dashoffset，
   导出走 canvas，两边读同一份排程，所以导出的就是你刚看的那一遍。 */
function ShowcaseStage({ svg, ratio, filenameBase, onClose }: {
  svg: string;
  ratio: number;
  filenameBase: string;
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
      const base = `${exportSafeName(filenameBase || "手写")}-showcase`;
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

/** 品牌标记：甲骨文的「永」。右侧一条长 S 的主流（水道）、左上斜支流、左下折回的分支。
    《说文》「永，长也，象水巠理之长」—— 本义是水流长，后来才引申成永远。
    骨架照《甲骨文編》450.4 收的第 1 式描的；那一条收了 18 个写法，各不相同 ——
    三千年前这个字就没有一个固定的样子，跟本项目「每次写都是新写的一遍」是同一件事。
    几何在 brand/yuragi-mark.json，这几条 d 是流水线跑出来的，别手改。 */
const YuragiMark = (
  <svg className="brand-mark" viewBox="0 0 64 64" fill="none" stroke="currentColor"
    strokeWidth="6.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M48.03 6.17C47.99 6.29 47.97 6.34 47.77 6.92C47.57 7.51 47.11 8.76 46.84 9.68C46.57 10.6 46.34 11.53 46.15 12.45C45.95 13.37 45.81 14.3 45.67 15.22C45.53 16.14 45.41 17.05 45.31 17.96C45.21 18.87 45.1 19.77 45.04 20.68C44.99 21.58 44.95 22.48 44.99 23.38C45.03 24.27 45.13 25.16 45.29 26.04C45.44 26.91 45.69 27.78 45.92 28.63C46.15 29.48 46.43 30.31 46.65 31.16C46.87 32 47.07 32.83 47.23 33.69C47.39 34.55 47.48 35.42 47.6 36.31C47.73 37.2 47.92 38.22 47.98 39.01C48.04 39.79 47.94 40.38 47.95 41.01C47.97 41.65 48 42.23 48.05 42.81C48.09 43.39 48.18 43.95 48.22 44.5C48.26 45.05 48.3 45.59 48.29 46.12C48.27 46.65 48.21 47.18 48.14 47.69C48.06 48.2 47.93 48.69 47.82 49.19C47.72 49.68 47.6 50.17 47.49 50.66C47.39 51.15 47.3 51.64 47.19 52.13C47.09 52.62 46.99 53.1 46.88 53.59C46.76 54.07 46.62 54.55 46.49 55.03C46.36 55.51 46.2 55.99 46.1 56.48C46 56.97 45.97 57.51 45.91 57.98C45.85 58.45 45.77 59.08 45.74 59.3" />
    <path d="M35.43 5.31C35.34 5.41 35.28 5.47 34.88 5.89C34.48 6.31 33.64 7.16 33.04 7.83C32.43 8.49 31.88 9.2 31.27 9.86C30.66 10.52 29.97 11.13 29.36 11.79C28.74 12.46 28.08 13.1 27.56 13.86C27.03 14.63 26.74 15.62 26.21 16.39C25.68 17.16 25.07 17.87 24.36 18.47C23.65 19.08 22.7 19.45 21.96 20.03C21.21 20.6 20.56 21.27 19.88 21.92C19.21 22.57 18.57 23.26 17.89 23.91C17.22 24.56 16.5 25.18 15.83 25.83C15.15 26.49 14.54 27.21 13.85 27.85C13.16 28.49 12.22 29.24 11.69 29.69C11.16 30.14 10.85 30.41 10.68 30.56" />
    <path d="M4.38 55.51C4.48 55.42 4.69 55.22 4.96 54.96C5.23 54.7 5.64 54.29 5.99 53.96C6.35 53.62 6.73 53.3 7.11 52.96C7.48 52.62 7.87 52.27 8.24 51.92C8.62 51.56 8.99 51.18 9.36 50.8C9.73 50.42 10.09 50.02 10.47 49.65C10.86 49.27 11.25 48.89 11.66 48.53C12.07 48.16 12.51 47.82 12.93 47.47C13.36 47.11 13.8 46.76 14.19 46.37C14.59 45.98 14.96 45.58 15.29 45.13C15.61 44.68 15.89 44.18 16.15 43.69C16.41 43.19 16.54 42.61 16.85 42.14C17.17 41.67 17.83 41.08 18.03 40.87C18.16 41.13 18.7 41.9 18.85 42.41C18.99 42.92 18.89 43.43 18.89 43.94C18.89 44.45 18.85 44.96 18.84 45.46C18.84 45.96 18.84 46.46 18.86 46.95C18.87 47.44 18.92 47.93 18.94 48.42C18.97 48.91 19.01 49.39 19.02 49.87C19.03 50.35 19.02 50.83 19.01 51.3C19 51.77 18.97 52.24 18.96 52.7C18.94 53.17 18.93 53.63 18.93 54.08C18.93 54.53 18.95 54.98 18.95 55.42C18.95 55.86 18.95 56.3 18.92 56.73C18.88 57.16 18.8 57.57 18.74 58C18.68 58.43 18.59 59.1 18.56 59.32" />
  </svg>
);

/* 「更多」卡片里的入口图标：跟预览播放 / 彩蛋同一套规格 —— 16 网格、1.7 线宽、转角在路径里带圆角。 */
function GithubMark() {
  return (
    <svg className="ui-icon github-mark" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4.3 9.1Q2.7 8.2 2.8 6.2L3.4 3.2Q3.65 2.35 4.4 2.75L6 3.6Q8 3.2 10 3.6L11.6 2.75Q12.35 2.35 12.6 3.2L13.2 6.2Q13.3 8.2 11.7 9.1Q8 10.3 4.3 9.1Z" />
      <path d="M6.5 10.4V13.6M9.5 10.4V13.6" />
      <path d="M6.5 12.4Q4.4 13 3.6 11.6" />
    </svg>
  );
}

function SkillMark() {
  return (
    <svg className="ui-icon skill-mark" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="1.9" width="10" height="12.2" rx="2.6" />
      <path d="M8 5.1Q8.5 7.5 10.9 8Q8.5 8.5 8 10.9Q7.5 8.5 5.1 8Q7.5 7.5 8 5.1Z" />
    </svg>
  );
}

function MoreMark() {
  return (
    <svg className="more-mark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5.5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="18.5" cy="12" r="1.7" />
    </svg>
  );
}

function ExternalMark() {
  return (
    <svg className="ui-icon external-mark" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 11L10.6 5.4" />
      <path d="M6.3 5H10Q11 5 11 6V9.7" />
    </svg>
  );
}

function PanelGlyph({ side }: { side: "left" | "right" }) {
  return (
    <svg className="ui-icon panel-glyph" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="1.6" y="2.9" width="12.8" height="10.2" rx="2.6" />
      <path d={side === "left" ? "M6.3 2.9V13.1" : "M9.7 2.9V13.1"} />
    </svg>
  );
}

function PreviewPlaybackIcon({ paused = false }: { paused?: boolean }) {
  return (
    <svg className="ui-icon preview-playback-icon" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
    <svg className="ui-icon preview-egg-icon" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
    <svg className="ui-icon metrics-toggle-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.4 3.1h7.2a2.3 2.3 0 0 1 2.3 2.3v7.2a2.3 2.3 0 0 1-2.3 2.3H5.4a2.3 2.3 0 0 1-2.3-2.3V5.4a2.3 2.3 0 0 1 2.3-2.3Z" />
      <path d="M5.7 8.9c.7.7 1.2 1.2 2 1.9 1.2-1.3 2.3-2.5 3.8-3.9" />
    </svg>
  );
}

function IconButton({ label, tooltipLabel = label, children, className = "", ...props }: IconButtonProps) {
  return (
    <TooltipHint label={tooltipLabel}>
      <button {...props} className={`icon-button ${className}`} aria-label={label}>
        {children}
      </button>
    </TooltipHint>
  );
}

const UnderIcon = (
  <svg className="ui-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
    <path d="M4 14.5 L9 3.5 L14 14.5" /><path d="M6.2 10.5h5.6" />
  </svg>
);
const GridToolIcon = (
  <svg className="ui-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    <path d="M3.5 3.5h11v11h-11zM3.5 9h11M9 3.5v11" />
  </svg>
);
/* 描摹两枚图标跟预览播放 / 彩蛋同一套规格：16 网格、1.7 线宽、转角带圆角。 */
/** 智能识别：一横一竖带收尾的笔画落到位，右上角一颗星表示「认出来了」。 */
const TraceSmartIcon = (
  <svg className="ui-icon" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M1.6 7H6.7" />
    <path d="M4.4 4V10.2Q4.4 12.9 2.1 13.8" />
    <path d="M11.8 2.2Q12.45 4.55 14.8 5.2Q12.45 5.85 11.8 8.2Q11.15 5.85 8.8 5.2Q11.15 4.55 11.8 2.2Z" />
  </svg>
);
/** 保留手迹：原样留下的一条起伏笔迹。 */
const TraceRawIcon = (
  <svg className="ui-icon" width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M2.2 11.2C3 7.6 4 4.8 5.2 5C6.6 5.2 5.8 10.8 7.4 11C8.9 11.2 9.4 6 10.9 6.1C12.2 6.2 11.6 9.8 12.7 9.9C13.3 10 13.8 9.4 14 8.8" />
  </svg>
);
const TRACE_MODES = [
  { value: "smart", label: "智能识别", shortcut: "S", icon: TraceSmartIcon, hint: "对着汉字笔画识别，照现有字库的写法落笔。" },
  { value: "original", label: "保留手迹", shortcut: "D", icon: TraceRawIcon, hint: "保留走向和回环，适合英文、连笔与手绘。" },
] as const;
const BoneIcon = (
  <svg className="ui-icon" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
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
            <span className="section-chevron" aria-hidden="true"><ChevronRightIcon /></span>
            {aside && <span className="section-aside">{aside}</span>}
          </Collapsible.Trigger>
          <TooltipHint label={indicatorLabel || (open ? `添加${title}项` : `展开${title}`)}>
            <button
              className="section-trigger-action"
              type="button"
              aria-label={indicatorLabel || (open ? `添加${title}项` : `展开${title}`)}
              aria-haspopup={indicatorHasMenu ? "menu" : undefined}
              onClick={(event) => indicatorAction(open, event)}
              onDoubleClick={(event) => indicatorDoubleAction?.(open, event)}
            >
              {indicator}
            </button>
          </TooltipHint>
        </div>
      ) : (
        <Collapsible.Trigger className="section-trigger">
          <span className="section-title">{title}</span>
          <span className="section-chevron" aria-hidden="true"><ChevronRightIcon /></span>
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
      <TooltipHint label="选择文字颜色">
        <button
          className="color-swatch-trigger"
          type="button"
          aria-label={`选择文字颜色 ${color}`}
          onClick={() => nativeInputRef.current?.click()}
        >
          <span className="color-swatch" style={{ backgroundColor: color }} aria-hidden="true" />
        </button>
      </TooltipHint>
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
      <TooltipHint label="文字不透明度">
        <label className={`color-opacity${opacityScrubbing ? " is-scrubbing" : ""}`}>
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
      </TooltipHint>
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

/** 工具栏上的显示开关按钮；显示开关属于编辑器视图，不绑定到某个字形。 */
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
    <TooltipHint label={label}>
      <button className={`tool-toggle${active ? " on" : ""}`} onClick={onClick} aria-label={label} aria-pressed={active}>
        {children}
      </button>
    </TooltipHint>
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
  // 每次载入一份字库时由它的版式给出起手画笔；载入完成后按钮仍可自由切换。
  const [traceMode, setTraceMode] = React.useState<"smart" | "original">("smart");
  const [draftStartPending, setDraftStartPending] = React.useState(false);
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
  // 默认只给一行的预览空间，用户拖动后再展开到更多行。
  const [previewHeight, setPreviewHeight] = React.useState<number | null>(PREVIEW_MIN_HEIGHT);
  const [previewResizing, setPreviewResizing] = React.useState(false);
  const [rowTrack, setRowTrack] = React.useState(DEFAULT_ROW_TRACK);
  const [rowPreviewWidth, setRowPreviewWidth] = React.useState(0);
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
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [batchAddMenu, setBatchAddMenu] = React.useState<{ x: number; y: number } | null>(null);
  const [batchAddOpen, setBatchAddOpen] = React.useState(false);
  const [batchAddText, setBatchAddText] = React.useState("");
  const [batchAddError, setBatchAddError] = React.useState("");
  const [viewportHeight, setViewportHeight] = React.useState(760);
  const [viewportWidth, setViewportWidth] = React.useState(760);
  const [leftOpen, setLeftOpen] = React.useState(true);
  const [rightOpen, setRightOpen] = React.useState(true);
  const [mobilePanel, setMobilePanel] = React.useState<"left" | "right" | null>(null);
  const [isMobile, setIsMobile] = React.useState(() => (
    typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches
  ));
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
  const [toastMessage, setToastMessage] = React.useState("");
  const [copySvgBusy, setCopySvgBusy] = React.useState(false);
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const viewportRef = React.useRef<HTMLDivElement | null>(null);
  const helpRef = React.useRef<HTMLDivElement | null>(null);
  const batchAddMenuRef = React.useRef<HTMLDivElement | null>(null);
  const previewBarRef = React.useRef<HTMLDivElement | null>(null);
  const rowArtRef = React.useRef<HTMLDivElement | null>(null);
  const previewResizeRef = React.useRef<PreviewResizeState | null>(null);
  const previewResizeHeightRef = React.useRef<number | null>(null);
  const previewResizeFrameRef = React.useRef<number | null>(null);
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
  const names = glyphs ? orderedGlyphNames(glyphs.items, glyphs.editor?.glyphOrder) : [];
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
  const projectStem = orderedProjectStem(visibleNames);
  const projectFilename = orderedProjectFilename(visibleNames);

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
    // 新工程切换时，旧字库的墨线不会随着空 items 自动消失：空库没有
    // currentRenderBody，也就没有后续渲染请求来覆盖旧的 ink。先清空画布
    // 和交互状态，保证加载期间以及新库落地后都不会残留上一份内容。
    setInk([]);
    setInkFade(null);
    setTraceEcho([]);
    setTracePoints([]);
    setTraceStatus("");
    setSelectedStrokes([]);
    setSelectedPoint(null);
    setMarquee(null);
    setDrawModeState(false);
    tracePointerIdRef.current = null;
    tracePointsRef.current = [];
    marqueeRef.current = null;
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
      importDocument(file.name, text);
      reloadDocument();
    } catch (reason) {
      setError(reason instanceof Error ? `这份文件不是几何 JSON：${reason.message}` : "打开失败");
    }
  }, [reloadDocument]);

  const handleDocumentImportClick = React.useCallback(() => {
    if (!window.confirm("导入会替换当前这一份。没下载过的话就找不回来了，确定？")) return;
    libraryFileRef.current?.click();
  }, []);

  React.useEffect(() => {
    requestJSON<GeoPayload>("/api/geo")
      .then((payload) => {
        const firstGlyph = orderedGlyphNames(
          payload.glyphs?.items || {},
          payload.glyphs?.editor?.glyphOrder,
        )[0] || "";
        // 空字库也要有一个可交互的目标：先放入 UI 草稿，让新建后马上进入
        // “输入首字 → 选择落笔方式 → 开始描摹”的流程，而不是落笔到空 key 上。
        const initialGlyphName = firstGlyph || nextDraftGlyphName(payload.glyphs.items);
        const initialPayload = firstGlyph ? payload : {
          ...payload,
          glyphs: {
            ...payload.glyphs,
            items: { ...payload.glyphs.items, [initialGlyphName]: [] },
          },
        };
        const savedGlyphs = clone(payload.glyphs);
        const editor = readEditorConfig(payload.glyphs?.editor);
        setGeo(initialPayload);
        savedGlyphsRef.current = savedGlyphs;
        setSavedPreviewGlyphs(savedGlyphs);
        canvasDirtyRef.current = false;
        rightPanelSaveTargetRef.current = null;
        rightPanelSaveInFlightTargetRef.current = null;
        setHasUnsavedChanges(false);
        setGlyphName(initialGlyphName);
        setDraftStartPending(!firstGlyph || isDraftGlyph(firstGlyph));
        // 推荐只在一份字库载入时设一次；后续用户可以在“描摹”面板中自由切换。
        setTraceMode(libraryIsLatin(initialPayload.glyphs) ? "original" : "smart");
        setLiveAdvances({});
        setReferenceText(firstGlyph ? glyphInfo(firstGlyph).base : "");
        setRowTrack(Number.isFinite(Number(payload.glyphs?.track))
          ? Number(payload.glyphs.track)
          : libraryIsLatin(payload.glyphs) ? DEFAULT_ROW_TRACK : DEFAULT_HAN_ROW_TRACK);
        /* 换一份工程就是换一套设置：新文件没写的字段要回默认，不能沿用上一份。
           不复位的话，新建的空库会顶着上一份的种子开局。 */
        setUnderlay(editor.underlay ?? true);
        setShowGrid(editor.showGrid ?? true);
        setShowSkeleton(editor.showSkeleton ?? true);
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

  // reloadDocument 会把 libraryRevision 加一。作废旧字库尚未返回的渲染，
  // 否则它可能在新库已经显示后把上一份字的墨线写回来；行预览同理。
  React.useEffect(() => {
    renderSeqRef.current += 1;
    renderPendingRef.current = null;
    renderLastSentRef.current = "";
    renderErroredRef.current = false;
    if (renderTimerRef.current !== null) {
      window.clearTimeout(renderTimerRef.current);
      renderTimerRef.current = null;
    }
    previousInkRef.current = [];
    inkFadeWantedRef.current = 0;
    if (inkFadeTimerRef.current !== null) {
      window.clearTimeout(inkFadeTimerRef.current);
      inkFadeTimerRef.current = null;
    }

    rowSeqRef.current += 1;
    rowPendingRef.current = null;
    rowLastSentRef.current = "";
    if (rowTimerRef.current !== null) {
      window.clearTimeout(rowTimerRef.current);
      rowTimerRef.current = null;
    }
    setRowResult(null);
  }, [libraryRevision]);

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
  const selectedExportGlyph = glyphName && !isDraftGlyph(glyphName) && glyphs && Object.hasOwn(glyphs.items, glyphName)
    ? glyphName
    : "";
  const selectedExportGlyphLabel = selectedExportGlyph ? glyphLabel(selectedExportGlyph) : "未选择字形";
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
  /* core 用实际渲染后的 viewBox 宽高来判断换行，这里只传预览区的真实像素宽度。
     这样拉丁窄体、矮体不会被固定的“每字多少单位”误判。 */
  // 只留很小的边界余量，避免在接近容器边缘时过早换行造成大块空白。
  const rowMaxWidth = rowPreviewWidth > 0 ? Math.max(96, rowPreviewWidth - 2) : null;
  const rowBody = rowLine && glyphs ? JSON.stringify({
    glyphData: {
      vb: glyphs.vb,
      sw: glyphs.sw,
      // Structural edits stay on the main canvas until a save succeeds.
      items: rowPreviewItems,
      glyphSeeds: glyphs.glyphSeeds,
    },
    glyphOrder: names,
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
    maxWidth: rowMaxWidth,
    lineHeight: viewHeight,
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

  // 输入首字后直接把画布切进描摹态，用交互状态引导下一步，不额外弹提示。
  React.useEffect(() => {
    if (!draftStartPending || referenceNeedsEntry || drawMode) return;
    setDrawModeState(true);
    setTraceStatus("");
    setDraftStartPending(false);
  }, [draftStartPending, referenceNeedsEntry, drawMode]);

  /** 两个按钮既是落笔方式也是开关：点正在用的那种就收笔。 */
  const pickTraceMode = (mode: "smart" | "original") => {
    if (referenceNeedsEntry) return;
    if (drawMode && traceMode === mode) { setDrawMode(false); return; }
    clearTrace();
    setTraceMode(mode);
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
    if (!helpOpen && !moreOpen) return;
    const close = () => { setHelpOpen(false); setMoreOpen(false); };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && helpRef.current?.contains(target)) return;
      close();
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [helpOpen, moreOpen]);

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

  const startPreviewResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const bar = previewBarRef.current;
    if (!bar) return;
    event.preventDefault();
    event.stopPropagation();
    const startHeight = clampPreviewHeight(bar.getBoundingClientRect().height);
    previewResizeRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
    };
    previewResizeHeightRef.current = startHeight;
    bar.style.height = `${startHeight}px`;
    setPreviewHeight(startHeight);
    setPreviewResizing(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePreviewResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = previewResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    event.preventDefault();
    const nextHeight = clampPreviewHeight(resize.startHeight - (event.clientY - resize.startY));
    previewResizeHeightRef.current = nextHeight;
    if (previewResizeFrameRef.current === null) {
      previewResizeFrameRef.current = window.requestAnimationFrame(() => {
        previewResizeFrameRef.current = null;
        const bar = previewBarRef.current;
        const height = previewResizeHeightRef.current;
        if (bar && height !== null) bar.style.height = `${height}px`;
      });
    }
  };

  const endPreviewResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const resize = previewResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    previewResizeRef.current = null;
    if (previewResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(previewResizeFrameRef.current);
      previewResizeFrameRef.current = null;
    }
    const finalHeight = previewResizeHeightRef.current;
    if (finalHeight !== null && previewBarRef.current) {
      previewBarRef.current.style.height = `${finalHeight}px`;
      setPreviewHeight(finalHeight);
    }
    previewResizeHeightRef.current = null;
    setPreviewResizing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handlePreviewResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = previewHeight
      ?? previewBarRef.current?.getBoundingClientRect().height
      ?? PREVIEW_MIN_HEIGHT;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      setPreviewHeight(clampPreviewHeight(current + (event.key === "ArrowUp" ? 8 : -8)));
    } else if (event.key === "Home") {
      event.preventDefault();
      setPreviewHeight(previewHeightBounds()[0]);
    } else if (event.key === "End") {
      event.preventDefault();
      setPreviewHeight(previewHeightBounds()[1]);
    }
  };

  React.useEffect(() => {
    const onResize = () => {
      setPreviewHeight((value) => value === null ? value : clampPreviewHeight(value));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  React.useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

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

  React.useEffect(() => {
    const element = rowArtRef.current;
    if (!element) return;
    const update = (width: number) => {
      const next = Math.max(0, Math.round(width));
      setRowPreviewWidth((current) => current === next ? current : next);
    };
    update(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [loading, !!rowResult?.svg]);

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
      ? orderedGlyphNames(targetGlyphs.items, targetGlyphs.editor?.glyphOrder)
        .find((name) => isDraftGlyph(name)) || null
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
      // 单独添加已有字时，默认沿用基础字形，避免新手先得到一个空白变体。
      // 如果用户已经在草稿上画过内容，则尊重这份手动画法，不用基础字覆盖它。
      const draftItems = targetGlyphs.items[draftName] || [];
      const reuseBase = !draftItems.length && Object.hasOwn(targetGlyphs.items, base);
      const glyphOrder = orderedGlyphNames(targetGlyphs.items, targetGlyphs.editor?.glyphOrder)
        .map((entry) => entry === draftName ? nextName : entry);
      const nextItems: Record<string, EditableElement[]> = {};
      for (const [name, items] of Object.entries(targetGlyphs.items)) {
        nextItems[name === draftName ? nextName : name] = name === draftName && reuseBase
          ? clone(targetGlyphs.items[base])
          : items;
      }
      const nextSeeds = { ...targetGlyphs.glyphSeeds };
      const nextSeedMemory = { ...(targetGlyphs.glyphSeedMemory || {}) };
      if (Object.hasOwn(nextSeeds, draftName)) {
        nextSeeds[nextName] = nextSeeds[draftName];
        delete nextSeeds[draftName];
      } else if (reuseBase && Object.hasOwn(nextSeeds, base)) {
        nextSeeds[nextName] = nextSeeds[base];
      }
      if (Object.hasOwn(nextSeedMemory, draftName)) {
        nextSeedMemory[nextName] = nextSeedMemory[draftName];
        delete nextSeedMemory[draftName];
      } else if (reuseBase && Object.hasOwn(nextSeedMemory, base)) {
        nextSeedMemory[nextName] = nextSeedMemory[base];
      }
      const nextEditor: EditorConfig = {
        ...(targetGlyphs.editor || {}),
        glyphOrder,
      };
      if (nextEditor?.ink) {
        const ink = { ...nextEditor.ink };
        if (Object.hasOwn(ink, draftName)) {
          ink[nextName] = clone(ink[draftName]);
          delete ink[draftName];
        } else if (reuseBase && Object.hasOwn(ink, base)) {
          ink[nextName] = clone(ink[base]);
        }
        nextEditor.ink = ink;
      }
      const nextGlyphs: GlyphLibrary = {
        ...targetGlyphs,
        items: nextItems,
        glyphSeeds: nextSeeds,
        glyphSeedMemory: nextSeedMemory,
        editor: nextEditor,
      };
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

  const showToast = React.useCallback((message: string) => {
    if (saveToastTimerRef.current !== null) window.clearTimeout(saveToastTimerRef.current);
    setToastMessage(message);
    saveToastTimerRef.current = window.setTimeout(() => {
      saveToastTimerRef.current = null;
      setToastMessage("");
    }, 1400);
  }, []);

  const showSaveToast = React.useCallback(() => showToast("已保存"), [showToast]);

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

  // 这三个开关属于当前工程的画布视图：按钮可以留在画布下方，但状态写在
  // editor 配置里，所以切换单字不会各自记一份，也会随工程保存/恢复。
  const toggleUnderlay = () => {
    const next = !underlay;
    setUnderlay(next);
    updateEditorAndSave({ underlay: next });
  };

  const toggleGrid = () => {
    const next = !showGrid;
    setShowGrid(next);
    updateEditorAndSave({ showGrid: next });
  };

  const toggleSkeleton = () => {
    const next = !showSkeleton;
    setShowSkeleton(next);
    updateEditorAndSave({ showSkeleton: next });
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
            const nextGlyph = orderedGlyphNames(
              restored.glyphs?.items || {},
              restored.glyphs?.editor?.glyphOrder,
            )[0] || "";
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
      const traceShortcut = TRACE_MODES.find((mode) => mode.shortcut.toLowerCase() === key);
      if (traceShortcut) {
        if (event.repeat) return;
        event.preventDefault();
        pickTraceMode(traceShortcut.value);
        return;
      }
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
  }, [geo, drawMode, traceMode, referenceNeedsEntry, glyphName, restore, selectedStrokes, selectedPoint, showSaveToast]);

  const copyCurrentSvg = async () => {
    if (!group || !selectedExportGlyph || !group.items[selectedExportGlyph]?.length || copySvgBusy) return;
    setCopySvgBusy(true);
    try {
      const style = inkStyleFor(selectedExportGlyph);
      const rendered = await renderExportGlyphMarkup(
        group,
        selectedExportGlyph,
        names.indexOf(selectedExportGlyph),
        1,
        style.color,
        style.opacity,
      );
      await copyTextToClipboard(rendered.svg);
      showToast("SVG 已复制");
    } catch (reason) {
      setError(`复制 SVG 失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setCopySvgBusy(false);
    }
  };

  const exportContent = async () => {
    const exportNames = names.filter((name) => !isDraftGlyph(name));
    if (!group || !exportNames.length || exportBusy) return;
    if (exportScope === "glyphs" && (!selectedExportGlyph || !group.items[selectedExportGlyph]?.length)) {
      setExportMessage("请先选择一个已有笔画的字形");
      return;
    }
    const format = exportFormat;
    const scale = format === "png" ? Number(exportScale) : 1;
    setExportBusy(true);
    setExportMessage(exportScope === "glyphs" ? `准备导出 ${selectedExportGlyphLabel}…` : "准备整段预览…");

    try {
      const base = projectStem;
      const suffix = format === "svg" ? "SVG" : `${scale}x-PNG`;

      if (exportScope === "glyphs") {
        const name = selectedExportGlyph;
        const info = glyphInfo(name);
        setExportMessage(`正在处理 ${glyphLabel(name)}`);
        const style = inkStyleFor(name);
        const data = await renderExportGlyph(group, name, names.indexOf(name), format, scale, style.color, style.opacity);
        const stem = exportSafeName(info.variant > 1 ? `${info.base}-v${info.variant}` : info.base);
        const filename = `${base}-${stem}.${format}`;
        const contentType = format === "svg" ? "image/svg+xml;charset=utf-8" : "image/png";
        downloadBlob(new Blob([data], { type: contentType }), filename);
        setExportMessage("");
        return;
      }

      if (!rowResult?.svg || !rowBody) throw new Error("整段预览还没有生成");
      // 预览可以按容器宽度换行，但整段导出保持传统的一行连续排版。
      const exportRowResult = await requestJSON<RowResult>("/api/row", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...JSON.parse(rowBody), maxWidth: null }),
      });
      const [rowWidth, rowHeight] = rowExportBox(exportRowResult);
      const outWidth = Math.max(1, Math.round(rowWidth * scale));
      const outHeight = Math.max(1, Math.round(rowHeight * scale));
      const svg = addSvgSize(colorizeRowSvg(exportRowResult.svg, rowInkStyles), outWidth, outHeight);
      const filename = `${base}-row-${suffix}.${format}`;
      if (format === "svg") {
        downloadBlob(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }), filename);
      } else {
        downloadBlob(await svgToPng(svg, outWidth, outHeight), filename);
      }
      setExportMessage("");
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
    const glyphOrder = [...names, ...batchAddPlan.map((entry) => entry.name)];
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
      editor: { ...(glyphs.editor || {}), glyphOrder },
    };
    if (Object.keys(nextInk).length || glyphs.editor?.ink !== undefined) {
      nextGlyphs.editor = { ...(nextGlyphs.editor || {}), ink: nextInk };
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
    updateGlyphs({
      items: { ...glyphs.items, [nextName]: source },
      editor: { ...(glyphs.editor || {}), glyphOrder: [...names, nextName] },
    });
    setGlyphName(nextName);
    setReferenceText("");
    setDraftStartPending(true);
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
    const nextOrder = [...names];
    const sourceIndex = nextOrder.indexOf(name);
    nextOrder.splice(sourceIndex + 1, 0, nextName);
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
      glyphs: {
        ...glyphs,
        items: nextItems,
        glyphSeeds,
        glyphSeedMemory,
        editor: { ...editor, glyphOrder: nextOrder },
      },
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
    const nextOrder = names.filter((entry) => entry !== name);
    const editor: EditorConfig = { ...(glyphs.editor || {}), glyphOrder: nextOrder };
    if (editor?.ink) {
      const ink = { ...editor.ink };
      delete ink[name];
      if (Object.keys(ink).length) editor.ink = ink;
      else delete editor.ink;
    }
    const nextGeo: GeoPayload = {
      ...geo,
      glyphs: { ...glyphs, items: nextItems, glyphSeeds, glyphSeedMemory, editor },
    };
    setHasUnsavedChanges(true);
    setGeo(nextGeo);
    // 移除是结构性操作，点击后立即写回字库，不再等用户手动保存。
    void save(nextGeo, { preserveCanvasUnsaved: true });
    if (name === glyphName) {
      const remaining = nextOrder;
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
      const currentNames = orderedGlyphNames(currentGlyphs.items, currentGlyphs.editor?.glyphOrder);
      if (currentNames.length === nextOrder.length && currentNames.every((name) => nextOrder.includes(name))) {
        const nextItems: Record<string, EditableElement[]> = {};
        for (const name of nextOrder) nextItems[name] = currentGlyphs.items[name];
        drag.preview = {
          ...preview,
          glyphs: {
            ...currentGlyphs,
            items: nextItems,
            editor: { ...(currentGlyphs.editor || {}), glyphOrder: nextOrder },
          },
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
    return <div className="loading-screen"><span className="loading-mark">{YuragiMark}</span><span>正在读取字库…</span></div>;
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
  const canvasFramePx = canvasPx + 16;


  const railStyle = {
    "--rail-l": leftOpen ? "288px" : "112px",
    "--rail-r": rightOpen ? "304px" : "112px",
  } as React.CSSProperties;

  const toggleMobilePanel = (side: "left" | "right") => {
    setMobilePanel((current) => current === side ? null : side);
  };

  const closeMobilePanel = () => {
    const closingPanel = mobilePanel;
    setMobilePanel(null);
    if (isMobile && closingPanel) {
      window.requestAnimationFrame(() => {
        document.getElementById(`mobile-${closingPanel}-panel-trigger`)?.focus();
      });
    }
  };

  const closePanel = (side: "left" | "right") => {
    closeMobilePanel();
    if (isMobile) return;
    if (side === "left") setLeftOpen(false);
    else setRightOpen(false);
  };

  return (
    <Tooltip.Provider delayDuration={350} skipDelayDuration={120}>
      <div className="app" style={railStyle} onPointerDown={(event) => {
        const target = event.target as Element;
        if (!target.closest(".section-trigger-action")) clearAddMenuClickTimer();
        if (event.button !== 0 || drawMode) return;
        if (!target.matches(".app, .workspace, .stage, .viewport, .canvas-col")) return;
        setSelectedStrokes([]);
        setSelectedPoint(null);
      }}>
        <div className="mobile-toolbar" role="toolbar" aria-label="移动端工作区">
          <button
            id="mobile-left-panel-trigger"
            className={`mobile-panel-trigger${mobilePanel === "left" ? " is-active" : ""}`}
            type="button"
            aria-expanded={mobilePanel === "left"}
            aria-controls="mobile-left-panel"
            onClick={() => toggleMobilePanel("left")}
          >
            <PanelGlyph side="left" />
            <span>字库</span>
          </button>
          <div className="mobile-brand" aria-label="Yuragi 手绘字生成器">
            <span className="mobile-brand-icon">{YuragiMark}</span>
            <span>Yuragi</span>
          </div>
          <button
            id="mobile-right-panel-trigger"
            className={`mobile-panel-trigger mobile-panel-trigger--right${mobilePanel === "right" ? " is-active" : ""}`}
            type="button"
            aria-expanded={mobilePanel === "right"}
            aria-controls="mobile-right-panel"
            onClick={() => toggleMobilePanel("right")}
          >
            <span>编辑</span>
            <PanelGlyph side="right" />
          </button>
        </div>

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
                    <div className={`canvas-wrap${showGrid ? " has-grid" : ""}${referenceNeedsEntry ? " is-reference-locked" : ""}`} data-trace-mode={traceMode} style={{ width: canvasPx }}>
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
                  <ToolButton label="印刷体底图" active={underlay} onClick={toggleUnderlay}>{UnderIcon}</ToolButton>
                  <ToolButton label="网格" active={showGrid} onClick={toggleGrid}>{GridToolIcon}</ToolButton>
                  <ToolButton label="骨架" active={showSkeleton} onClick={toggleSkeleton}>{BoneIcon}</ToolButton>
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
                      placeholder={referenceNeedsEntry ? "输入首字" : undefined}
                      spellCheck={false}
                    />
                  </label>
                  <Select.Root value={referenceFont} onValueChange={setReferenceFont}>
                    <Select.Trigger className="select-trigger reference-font-select" aria-label="参考字体">
                      <Select.Value />
                      <Select.Icon><ChevronDownIcon /></Select.Icon>
                    </Select.Trigger>
                    <Select.Portal>
                      <Select.Content className="select-content reference-font-content" position="popper" sideOffset={6}>
                        <Select.Viewport>
                          {REFERENCE_FONTS.map((font) => (
                            <Select.Item className="select-item" value={font.value} key={font.value}>
                              <Select.ItemText>{font.label}</Select.ItemText>
                              <Select.ItemIndicator><CheckIcon /></Select.ItemIndicator>
                            </Select.Item>
                          ))}
                        </Select.Viewport>
                      </Select.Content>
                    </Select.Portal>
                  </Select.Root>
                  <span className="sep tools-save-sep" aria-hidden="true" />
                  <IconButton
                    className="copy-svg-button"
                    type="button"
                    label={copySvgBusy ? "正在复制 SVG" : "复制当前字形 SVG"}
                    tooltipLabel={copySvgBusy ? "正在复制 SVG" : "复制当前字形 SVG"}
                    disabled={copySvgBusy || referenceNeedsEntry || !selectedExportGlyph || !group?.items[selectedExportGlyph]?.length}
                    onClick={() => { void copyCurrentSvg(); }}
                  >
                    <CopyIcon aria-hidden="true" />
                  </IconButton>
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
              <div className="corner-actions">
                <div className="zoom-controls zoom-controls--corner" role="group" aria-label="画布缩放">
                  <IconButton label="缩小（⌘/Ctrl−）" onClick={() => setZoomClamped(zoom / 1.15)}><MinusIcon /></IconButton>
                  <TooltipHint label="回到 100%（⌘/Ctrl0）">
                    <button className="zoom-readout" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
                  </TooltipHint>
                  <IconButton label="放大（⌘/Ctrl+）" onClick={() => setZoomClamped(zoom * 1.15)}><PlusIcon /></IconButton>
                </div>
                <TooltipHint label="快捷键与规矩">
                  <button
                    className="help-button"
                    type="button"
                    data-open={helpOpen}
                    aria-expanded={helpOpen}
                    aria-controls="editor-help"
                    onClick={() => { setMoreOpen(false); setHelpOpen((value) => !value); }}
                  >
                    ?
                  </button>
                </TooltipHint>
              </div>
              {/* 「更多」叠在「?」正上方，和它右对齐；卡片从这个按钮往上弹。 */}
              <div className="more-anchor">
                <TooltipHint label="更多">
                  <button
                    className="help-button more-button"
                    type="button"
                    data-open={moreOpen}
                    aria-label="更多"
                    aria-expanded={moreOpen}
                    aria-controls="editor-more"
                    onClick={() => { setHelpOpen(false); setMoreOpen((value) => !value); }}
                  >
                    <MoreMark />
                  </button>
                </TooltipHint>
                {moreOpen && (
                  <div className="more-pop" id="editor-more" role="dialog" aria-label="更多">
                    <a className="more-link" href={SOURCE_REPO_URL} target="_blank" rel="noopener noreferrer">
                      <span className="more-link-icon"><GithubMark /></span>
                      <span className="more-link-text">
                        <b>开源项目</b>
                        <small>在 GitHub 查看 Yuragi 源码</small>
                      </span>
                      <ExternalMark />
                    </a>
                    {SKILL_DOWNLOAD_URL ? (
                      <a className="more-link" href={SKILL_DOWNLOAD_URL} target="_blank" rel="noopener noreferrer">
                        <span className="more-link-icon"><SkillMark /></span>
                        <span className="more-link-text">
                          <b>不想自己动手？</b>
                          <small>试试 Skill，让 AI 帮你写</small>
                        </span>
                        <ExternalMark />
                      </a>
                    ) : (
                      <div className="more-link" aria-disabled="true">
                        <span className="more-link-icon"><SkillMark /></span>
                        <span className="more-link-text">
                          <b>不想自己动手？</b>
                          <small>试试 Skill，让 AI 帮你写（即将开放）</small>
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
              {helpOpen && (
                <div className="help-pop" id="editor-help" role="dialog" aria-label="快捷键与规矩">
                  <b>这是什么</b>
                  Yuragi 是一个拙趣感手绘字生成器：把随手写下的笔画变成一段带有手写温度和自然变化的文字，实时预览并导出。
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
                    <div className="row">
                    <span>切换描摹方式</span>
                    <span className="shortcut-keys">
                      <ShortcutKey label="S" />
                      <span className="shortcut-sequence-divider" aria-hidden="true">/</span>
                      <ShortcutKey label="D" />
                    </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div
            className={`rowbar${previewResizing ? " is-resizing" : ""}`}
            ref={previewBarRef}
            style={previewHeight === null ? undefined : { height: `${previewHeight}px` }}
          >
            <div
              className="preview-resize-handle"
              role="separator"
              aria-label="调整预览高度"
              aria-orientation="horizontal"
              aria-valuemin={PREVIEW_MIN_HEIGHT}
              aria-valuemax={previewHeightBounds()[1]}
              aria-valuenow={previewHeight ?? undefined}
              tabIndex={0}
              onPointerDown={startPreviewResize}
              onPointerMove={movePreviewResize}
              onPointerUp={endPreviewResize}
              onPointerCancel={endPreviewResize}
              onLostPointerCapture={endPreviewResize}
              onKeyDown={handlePreviewResizeKeyDown}
            />
            <div className="rowbar-head">
              <b>预览</b>
              <span className="spacer" />
              <div className="metrics-anchor" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setMetricsOpen(false); } }}>
                <TooltipHint label="逐字数据">
                  <button className="metrics-toggle" type="button" aria-label="逐字数据" aria-expanded={metricsOpen} aria-controls="glyph-metrics" onClick={() => setMetricsOpen((open) => !open)}>
                    <MetricsIcon />
                  </button>
                </TooltipHint>
                {metricsOpen && (
                  <section className="metrics-panel" id="glyph-metrics" aria-label="逐字数据">
                    <div className="metrics-panel-head">
                      <strong>逐字数据</strong><span>{allMetrics.length} 字</span>
                      <IconButton label="收起逐字数据" className="icon-button--square" onClick={() => setMetricsOpen(false)}><Cross2Icon /></IconButton>
                    </div>
                    <div className="metrics-scroll">
                      <table className="metrics-table">
                        <thead><tr><th scope="col">字形</th><th scope="col">大小</th><th scope="col">行内偏差</th><th scope="col">相邻差</th></tr></thead>
                        <tbody>{metricRows.map((cell, index) => (
                          <tr className={cell.thin ? "thin" : undefined} key={`${cell.name}-${index}`}>
                            <th scope="row">{cell.name == null ? "·" : <GlyphLabel name={cell.name} className="metrics-glyph-label" />}</th>
                            <td>{cell.s.toFixed(3)}</td>
                            <TooltipHint
                              label={cell.sizeDelta === null
                                ? null
                                : `${cell.sizeAlert === "large" ? "偏大" : cell.sizeAlert === "small" ? "偏小" : "正常"}，相对本行中位大小 ${cell.sizeDelta >= 0 ? "+" : ""}${cell.sizeDelta.toFixed(1)}%`}
                            >
                              <td className={`metrics-size-delta${cell.sizeAlert ? ` ${cell.sizeAlert}` : ""}`}>
                                {cell.sizeDelta === null ? "—" : (
                                  <>
                                    {cell.sizeAlert && <small>{cell.sizeAlert === "large" ? "偏大" : "偏小"}</small>}
                                    {cell.sizeDelta >= 0 ? "+" : ""}{cell.sizeDelta.toFixed(1)}%
                                  </>
                                )}
                              </td>
                            </TooltipHint>
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
            </div>
            {rowResult?.svg ? (
              <>
                <div className="rowbar-art" ref={rowArtRef}>
                  <div
                    className={`rowbar-svg${rowResult.lineCount && rowResult.lineCount > 1 ? " is-multiline" : ""}${previewPlaying ? " is-playing" : ""}`}
                    dangerouslySetInnerHTML={{
                      __html: rowPreviewSvg(rowResult.svg, viewHeight, rowResult.ratio, rowResult.lineCount ?? 1, previewPlaying, rowInkStyles),
                    }}
                  />
                </div>

              </>
            ) : <div className="rowbar-art is-empty" ref={rowArtRef}>{rowLine ? "正在排整段…" : null}</div>}
          </div>
        </div>

        {isMobile && mobilePanel && (
          <button
            className="mobile-panel-backdrop"
            type="button"
            aria-label="关闭面板"
            onClick={closeMobilePanel}
          />
        )}

        {toastMessage && <span className="save-toast" role="status" aria-live="polite">{toastMessage}</span>}
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
        <aside
          id="mobile-left-panel"
          className="panel panel--left"
          data-collapsed={!leftOpen}
          data-mobile-open={isMobile && mobilePanel === "left"}
          aria-hidden={isMobile ? mobilePanel !== "left" : !leftOpen}
        >
          <div className="panel-head">
            <h1>字库</h1>
            <IconButton label="收起字库（[）" className="icon-button--square" onClick={() => closePanel("left")}><PanelGlyph side="left" /></IconButton>
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
                  <span className="library-mode-card-title">拉丁</span>
                </button>
                <button
                  className="library-mode-card library-mode-card--import"
                  type="button"
                  aria-label="导入 JSON 字库"
                  onClick={handleDocumentImportClick}
                >
                  <span className="library-mode-card-icon library-mode-card-icon--import" aria-hidden="true">.json</span>
                  <span className="library-mode-card-title">导入</span>
                </button>
              </div>
              <input
                ref={libraryFileRef}
                className="library-file-input"
                type="file"
                accept="application/json,.json"
                aria-label="导入 JSON 字库"
                onChange={(event) => {
                  void handleDocumentOpen(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
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
                    aria-keyshortcuts={mode.shortcut}
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
            {!referenceNeedsEntry && (traceStatus || drawMode) && <p className="trace-hint" data-live={drawMode ? "true" : "false"} role="status">
              {traceStatus
                || (drawMode
                  ? `${TRACE_MODES.find((mode) => mode.value === traceMode)?.hint ?? ""}再点一次结束描摹。`
                  : "")}
            </p>}
          </Section>

          <Section
            title="字形"
            className="section--library section--library-glyphs"
            open={!!openSections.libraryGlyphs}
            onOpenChange={toggleSection("libraryGlyphs")}
            indicator={<PlusIcon />}
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
                              <CopyIcon aria-hidden="true" />
                              <span>复制字形</span>
                            </DropdownMenu.Item>
                            <DropdownMenu.Item className="menu-item danger" disabled={names.length <= 1} onSelect={() => removeGlyph(name)}>
                              <TrashIcon aria-hidden="true" />
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
          data-hidden={leftOpen || mobilePanel === "left"}
          aria-label="展开字库（[）"
          tabIndex={leftOpen || mobilePanel === "left" ? -1 : 0}
          onClick={() => setLeftOpen(true)}
        >
          <span className="panel-stub-inner">
            <span>字库</span>
            <PanelGlyph side="left" />
          </span>
        </button>

        {/* ── 右面板：编辑 ─────────────────────────────────────── */}
        <aside
          id="mobile-right-panel"
          className="panel panel--right"
          data-collapsed={!rightOpen}
          data-mobile-open={isMobile && mobilePanel === "right"}
          aria-hidden={isMobile ? mobilePanel !== "right" : !rightOpen}
        >
          <div className="panel-head">
            <h2>编辑</h2>
            <IconButton label="收起编辑（]）" className="icon-button--square" onClick={() => closePanel("right")}><PanelGlyph side="right" /></IconButton>
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
                        <Select.Icon><ChevronDownIcon /></Select.Icon>
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content className="select-content export-select-content export-scope-content" position="popper" sideOffset={6}>
                          <Select.Viewport>
                            <Select.Item className="select-item" value="row">
                              <Select.ItemText>导出整段</Select.ItemText>
                              <Select.ItemIndicator><CheckIcon /></Select.ItemIndicator>
                            </Select.Item>
                            <Select.Item className="select-item" value="glyphs">
                              <Select.ItemText>
                                导出单字{" "}
                                {selectedExportGlyph
                                  ? <GlyphLabel name={selectedExportGlyph} className="export-glyph-label" />
                                  : "未选择字形"}
                              </Select.ItemText>
                              <Select.ItemIndicator><CheckIcon /></Select.ItemIndicator>
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
                        <Select.Icon><ChevronDownIcon /></Select.Icon>
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content className="select-content export-select-content export-scale-content" position="popper" sideOffset={6}>
                          <Select.Viewport>
                            {EXPORT_SCALES.map((value) => (
                              <Select.Item className="select-item" value={value} key={value}>
                                <Select.ItemText>{value}x</Select.ItemText>
                                <Select.ItemIndicator><CheckIcon /></Select.ItemIndicator>
                              </Select.Item>
                            ))}
                          </Select.Viewport>
                        </Select.Content>
                      </Select.Portal>
                    </Select.Root>

                    <Select.Root value={exportFormat} onValueChange={(value) => setExportFormatAndSave(value as ExportFormat)}>
                      <Select.Trigger className="select-trigger export-select" aria-label="导出格式">
                        <Select.Value />
                        <Select.Icon><ChevronDownIcon /></Select.Icon>
                      </Select.Trigger>
                      <Select.Portal>
                        <Select.Content className="select-content export-select-content" position="popper" sideOffset={6}>
                          <Select.Viewport>
                            {[{ value: "png", label: "PNG" }, { value: "svg", label: "SVG" }].map((option) => (
                              <Select.Item className="select-item" value={option.value} key={option.value}>
                                <Select.ItemText>{option.label}</Select.ItemText>
                                <Select.ItemIndicator><CheckIcon /></Select.ItemIndicator>
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
                    disabled={exportBusy || (exportScope === "row" ? !rowResult?.svg : !selectedExportGlyph || !group.items[selectedExportGlyph]?.length)}
                  >
                    <DownloadIcon />
                    <span>{exportBusy ? "导出中…" : "导出"}</span>
                  </button>
                  {exportMessage && <p className="export-message" role="status">{exportMessage}</p>}
                </div>
              </div>
            </Section>

            <div className="section data-section">
              <div className="section-trigger data-section-title" role="heading" aria-level={3}>
                <span className="section-title">数据</span>
              </div>
              <div className="section-body data-section-body">
                <div className="export-file-row">
                  <button className="library-file-action library-file-action--download" type="button" onClick={() => downloadDocument(projectFilename)}>
                    <ProjectFileIcon aria-hidden="true" />
                    <span>下载工程文件</span>
                  </button>
                </div>
              </div>
            </div>
          </div>

        </aside>

        <button
          className="panel-stub panel-stub--right"
          data-hidden={rightOpen || mobilePanel === "right"}
          aria-label="展开编辑（]）"
          tabIndex={rightOpen || mobilePanel === "right" ? -1 : 0}
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
              <PlusIcon aria-hidden="true" />
              <span className="batch-add-menu-copy">
                <strong>添加单字<small>（双击）</small></strong>
              </span>
            </button>
            <button className="batch-add-menu-item" type="button" role="menuitem" onClick={openBatchAddDialog}>
              <CopyIcon aria-hidden="true" />
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
                <ShowcaseStage svg={showcase.svg} ratio={showcase.ratio} filenameBase={projectStem} onClose={() => setShowcase(null)} />
              )}
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      </div>
    </Tooltip.Provider>
  );
}
