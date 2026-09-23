/* Browser-local API adapter: render through core modules and persist the active
   project in localStorage. No network request is required. */
import { loadGeo, serializeGeoFile, type GlyphLibrary } from "./core/library";
import { render, renderRow } from "./core/render";

export type LayoutMode = "han" | "latin";

/* Default stroke width for a new document in each layout mode. */
const PRESETS: Record<LayoutMode, number> = { han: 2.8, latin: 3.2 };

/** 拉丁新字形的起手字宽；画完再拖右栏那根「字宽」滑杆。 */
export const DEFAULT_LATIN_ADV = 30;

/* 新工程关掉收笔越位（over 0）：拙趣字一处都不出头，越位会让 T 字交接和框角支出一小截。
   汉字跟 skills/hand-glyph/assets/glyphs.json 同一组数；拉丁同样不出头。 */
const OVER: Record<LayoutMode, number | undefined> = { han: 0, latin: 0 };
/* 汉字新工程按字宽排（fit 12）：字有大有小、宽窄随字，等宽格子会让小字两边空一大块。 */
const FIT: Record<LayoutMode, number | undefined> = { han: 12, latin: undefined };
/* 新工程：线抖压到 0.65（喜茶的线几乎是直的）。错落（drift 1）只给汉字；英文字母保持规整，只调线宽这类设置。 */
const AMP: Record<LayoutMode, number> = { han: 0.65, latin: 0.65 };
/* 汉字新工程的逐字大小起伏放到 1.3（约 ±12%）；拉丁的由 latin-zhuo 命令写，编辑器新建时保持 0.9。 */
const JIT: Record<LayoutMode, number> = { han: 1.3, latin: 0.9 };
const DRIFT: Record<LayoutMode, number | undefined> = { han: 1, latin: undefined };

export function emptyDocumentText(mode: LayoutMode): string {
  return `${JSON.stringify({ vb: 64, sw: PRESETS[mode], mode, amp: AMP[mode], over: OVER[mode], jit: JIT[mode], vary: 0.9, fit: FIT[mode], drift: DRIFT[mode], items: {} }, null, 1)}\n`;
}

const DOC_KEY = "hg-document";

type Doc = { name: string; text: string };

/** 新访客从空白汉字工程开始；已有浏览器工程仍从本地槽位读取。 */
const EMPTY_DOCUMENT: Doc = { name: "手写字.json", text: emptyDocumentText("han") };

function readDoc(): Doc {
  try {
    const raw = window.localStorage.getItem(DOC_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed.text === "string") {
      return { name: String(parsed.name || EMPTY_DOCUMENT.name), text: parsed.text };
    }
  } catch { /* 读不出来就回空白工程 */ }
  return EMPTY_DOCUMENT;
}

function writeDoc(doc: Doc) {
  try { window.localStorage.setItem(DOC_KEY, JSON.stringify(doc)); } catch { /* 隐私模式：这一次不落盘 */ }
}

export function documentName(): string {
  return readDoc().name;
}

/** 新建：永远从预设开始，把当前这份顶掉（界面上先问过用户）。 */
export function createDocument(mode: LayoutMode): void {
  writeDoc({ name: mode === "latin" ? "拉丁字.json" : "手写字.json", text: emptyDocumentText(mode) });
}

/** 打开一份工程文件。坏文件当场抛，不进槽位。 */
export function importDocument(name: string, text: string): void {
  JSON.parse(text);
  writeDoc({ name: name.endsWith(".json") ? name : `${name}.json`, text });
}

/** 把这一版交给用户：下载几何 JSON —— 它仍然是唯一的真相层。 */
export function downloadDocument(filename?: string) {
  const doc = readDoc();
  const blob = new Blob([doc.text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || doc.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type RenderRequest = {
  vb: number; idx: number; items: never[]; amp?: number; over?: number; localSeed?: number | null;
};
type RowRequest = {
  text: string; seed?: number; ampk?: number; mode?: "han" | "latin"; amp?: number; over?: number;
  vary?: boolean; varyk?: number; glyphSeeds?: Record<string, number> | null;
  glyphData?: GlyphLibrary; track?: number | null; word?: number; maxWidth?: number | null; lineHeight?: number;
  glyphOrder?: string[];
};

/** Dispatch editor API calls to local rendering and storage. */
export async function requestJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const route = url.split("?")[0];
  if (route === "/api/geo") {
    const doc = readDoc();
    return loadGeo(JSON.parse(doc.text), doc.name) as T;
  }
  if (route === "/api/render") {
    const req = body as RenderRequest;
    return {
      paths: render(Number(req.vb), Number(req.idx), req.items,
        Number(req.amp ?? 1), Number(req.over ?? 1), req.localSeed ?? null),
    } as T;
  }
  if (route === "/api/row") {
    const req = body as RowRequest;
    if (!req.glyphData) throw new Error("行预览缺少字库数据");
    return renderRow({
      text: String(req.text ?? ""),
      seed: Math.trunc(Number(req.seed ?? 0)),
      ampk: Number(req.ampk ?? 1),
      mode: req.mode === "latin" ? "latin" : "han",
      amp: Number(req.amp ?? 1),
      over: Number(req.over ?? 1),
      vary: req.vary !== false,
      varyk: Number(req.varyk ?? 1),
      glyphSeeds: req.glyphSeeds ?? null,
      glyphData: req.glyphData,
      glyphOrder: req.glyphOrder,
      track: req.track ?? null,
      word: req.word === undefined ? undefined : Number(req.word),
      maxWidth: req.maxWidth === undefined || req.maxWidth === null ? null : Number(req.maxWidth),
      lineHeight: req.lineHeight === undefined ? undefined : Number(req.lineHeight),
    }) as T;
  }
  if (route === "/api/save") {
    const glyphs = (body as { glyphs?: GlyphLibrary }).glyphs;
    if (!glyphs || typeof glyphs !== "object") throw new Error("保存请求必须提供扁平的 glyphs 字段。");
    const text = serializeGeoFile(glyphs);
    const doc = readDoc();
    writeDoc({ name: doc.name, text });
    return { ok: true, bytes: text.length, file: doc.name } as T;
  }
  throw new Error(`未知的本地接口 ${route}`);
}
