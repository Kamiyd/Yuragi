/* 原来编辑器的每一次渲染都要往 127.0.0.1:8731 上的 Python 跑一趟：
   浏览器只发骨架点、只收回 path，图就一定跟 handdraw.py 出的是同一条线。

   现在没有那个 Python 了 —— 整条流水线搬进了 src/lib/core，在浏览器里跑。
   「只有一份实现」这条规矩没变，变的是那份实现的位置：
   tools/parity 拿 Python 生成的标准结果逐条比对，四千多项全字符串相等，
   所以「预览跟出图不是同一条线」这件事仍然不可能发生。

   这一层保留了原来的 fetch 接口形状（/api/geo、/api/render、/api/row、/api/save），
   EditorApp 那边的节流、序号丢弃、缓存键全都不用动 —— 只是请求不再出门。

   **只有一份工作文档。** 不是字库管理器：没有列表、没有切换、没有内置模板库。
   浏览器里留一个槽位只为了防手滑关标签页；要带走、要回来，走「下载/打开工程文件」。
   道理很简单 —— 渐变工具的输入是七个数，丢了重拨二十秒；这里的输入是你一笔一笔
   描出来的骨架，一句话小半小时。参数可以不存，创作的内容不能不存。

   **产品输入是一段文字，但预览会按可用宽度自动换行。** core 里的 writeLines（`/` 断行、
   多行同一个 viewBox）保留着，它是 handdraw.py write 的镜像、对照测试还在跑；编辑器的
   行预览则用自己的最大宽度重新排版，保持字号不变。 */
import { loadGeo, serializeGeoFile, type GlyphLibrary } from "./core/library";
import { render, renderRow } from "./core/render";

import han-sampleText from "../data/han-sample.json?raw";

export type LayoutMode = "han" | "latin";

/* 新建工程的预设。

   汉字 sw 2.8：44px 下限上两道横留 6 个单位 = 2.2px 白缝，3.4 只剩 1.8px。
   拉丁 sw 3.2：拉丁字怀在 3.5 上都不糊，所以它不是可读性问题是颜色问题 ——
     3.2 是三套手调拉丁（3.0 / 3.2 / 3.5，字面高 25–27）的中心值。
     混排请用汉字的 2.8：拉丁上到 3.4 跟汉字并排会散成两支笔。
   amp / jit / vary 0.9：row.py 在 1.0 上那组数被 14 张上线标题验过，各收一档
     给通用场景留余量。详见 reference-python/docs/params.md。 */
const PRESETS: Record<LayoutMode, number> = { han: 2.8, latin: 3.2 };

/** 拉丁新字形的起手字宽；画完再拖右栏那根「字宽」滑杆。 */
export const DEFAULT_LATIN_ADV = 30;

/** 第一次打开给的示例 —— 分享出去别人点进来得看见这工具能干什么。 */
const SAMPLE = { name: "示例文字.json", text: han-sampleText };

export function emptyDocumentText(mode: LayoutMode): string {
  return `${JSON.stringify({ vb: 64, sw: PRESETS[mode], mode, amp: 0.9, jit: 0.9, vary: 0.9, items: {} }, null, 1)}\n`;
}

const DOC_KEY = "hg-document";

type Doc = { name: string; text: string };

function readDoc(): Doc {
  try {
    const raw = window.localStorage.getItem(DOC_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed.text === "string") {
      return { name: String(parsed.name || SAMPLE.name), text: parsed.text };
    }
  } catch { /* 读不出来就回示例 */ }
  return SAMPLE;
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
};

/** 原来那个 fetch 包装的位置换成本地调用；接口形状一模一样。 */
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
