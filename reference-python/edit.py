"""`handdraw.py edit geo.json` —— 浏览器里拖骨架，改完写回同一份几何 JSON。

**这个编辑器唯一的规矩：拖的是抖动前的骨架点，看到的是抖动后的线。**
它绝不让人去改跑出来的坐标 —— 手改过的那一笔就永远脱离流水线了，
以后动一次滤镜参数，别的字跟着变、它不变，一行字里就有两支笔。

所以渲染和 d 串的读写**全部在 Python 这一侧**：浏览器只发骨架点、只收回 path。
没有 JS 版的 hand.py，也就不存在预览跟 handdraw.py 出的不是同一条线这回事。
（这是本文件最重要的一条设计：宁可每次拖动多一趟 localhost 往返 —— 单字重渲
在毫秒量级 —— 也不要两份会漂移的实现。）
"""
import http.client
import io, json, mimetypes, os, re, shutil, subprocess, sys, tempfile, webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
WEB_DIST = os.path.realpath(os.path.join(HERE, "..", "web", "dist"))
DEV_SERVER_HOST = "127.0.0.1"
DEV_SERVER_PORT = 4321
sys.path.insert(0, HERE)

import dpath, row as rowmod
import handdraw as H
from flatten import path_to_polys

PATH = None          # 正在编的几何 JSON
GEO = None           # 它的原始内容（保持键序）
ROW = None           # {text, seed}：write 刚排的那一行，用来预填行预览


# ── 几何 <-> 编辑器表示 ────────────────────────────────────────────────
def to_edit(el):
    """一个元素 -> 编辑器用的形。path 摊成 segs，别的类型原样带着。

    d0 是原始字符串：没被拖过的笔画保存时原样写回，一个字符都不动。
    （往返本来就是字节级一致的，这只是再上一道保险 —— 顺手也让 diff
    只出现在真正改过的那几笔上。）
    """
    e = dict(el)
    # 兼容早期保留手迹：amp=0 原本只是为了跳过骨架/线条抖动，
    # 现在保留复杂轨迹但恢复确定性的种子手感。
    if e.get("traceMode") == "original" and abs(float(e.get("amp", 1.0))) < 1e-9:
        e["amp"] = H.TRACE_AMP
    if e.get("t", "path") == "path":
        e["segs"] = dpath.parse(e["d"])
        e["d0"] = e["d"]
        e.pop("d", None)
    return e


def to_geo(el):
    """编辑器的形 -> 几何 JSON 的形。字段顺序跟字库现有的写法一致。"""
    if "segs" not in el:
        return {k: v for k, v in el.items() if k != "d0"}
    d = dpath.serialize(el["segs"])
    if el.get("d0") and dpath.serialize(dpath.parse(el["d0"])) == d:
        d = el["d0"]                      # 没动过 -> 原样
    out = {"t": "path", "d": d}
    for k in ("fill", "amp", "w", "adv", "traceMode"):
        if k in el and el[k] not in (None, ""):
            out[k] = el[k]
    return out


def normalize_glyphs(geo):
    """把几何文件统一成一套扁平字库。"""
    if isinstance(geo, dict) and isinstance(geo.get("items"), dict):
        return geo
    candidates = [value for value in geo.values()
                  if isinstance(value, dict) and isinstance(value.get("items"), dict)]
    if len(candidates) == 1:
        # 兼容旧版只有一个顶层字库名的文件，API 不再暴露这层包装。
        return candidates[0]
    if candidates:
        raise ValueError("这个文件包含多套字库；当前编辑器只支持一套字库，请先合并后再打开。")
    return {"items": geo}


def seed_map(value):
    """清洗可选的逐字种子表；旧字库没有这个字段也完全兼容。"""
    if not isinstance(value, dict):
        return {}
    out = {}
    for name, seed in value.items():
        try:
            out[str(name)] = int(seed)
        except (TypeError, ValueError):
            continue
    return out


def preview_seed(value, default=None):
    """清洗可选的全局预览种子；没有设置时保留编辑器的默认值。"""
    try:
        seed = int(value)
    except (TypeError, ValueError):
        return default
    return seed if seed > 0 else default


def _hex_color(value):
    value = str(value or "").strip()
    value = value[1:] if value.startswith("#") else value
    if len(value) == 3 and all(c in "0123456789abcdefABCDEF" for c in value):
        value = "".join(c * 2 for c in value)
    if len(value) != 6 or not all(c in "0123456789abcdefABCDEF" for c in value):
        return None
    return "#" + value.upper()


def editor_config(value, names):
    """清洗编辑器侧的持久化设置。

    这些字段不参与几何计算，但它们确实是右栏可编辑的配置：预览种子在
    字库顶层，颜色、排版模式和导出选项放在 editor 里，避免污染 items。
    """
    if not isinstance(value, dict):
        return {}
    out = {}
    mode = value.get("rowMode")
    if mode in ("library", "custom"):
        out["rowMode"] = mode
    if "rowText" in value:
        out["rowText"] = str(value.get("rowText") or "").replace("/", "").replace("\n", "")

    ink = value.get("ink")
    if isinstance(ink, dict):
        clean_ink = {}
        for name, style in ink.items():
            if str(name) not in names or not isinstance(style, dict):
                continue
            color = _hex_color(style.get("color"))
            try:
                opacity = float(style.get("opacity"))
            except (TypeError, ValueError):
                opacity = None
            clean = {}
            if color is not None:
                clean["color"] = color
            if opacity is not None and opacity == opacity:
                clean["opacity"] = max(0.0, min(1.0, opacity))
            if clean:
                if "opacity" in clean and clean["opacity"] == int(clean["opacity"]):
                    clean["opacity"] = int(clean["opacity"])
                clean_ink[str(name)] = clean
        if clean_ink:
            out["ink"] = clean_ink

    export = value.get("export")
    if isinstance(export, dict):
        clean_export = {}
        if export.get("scope") in ("row", "glyphs"):
            clean_export["scope"] = export["scope"]
        if export.get("format") in ("svg", "png"):
            clean_export["format"] = export["format"]
        try:
            scale = float(export.get("scale"))
        except (TypeError, ValueError):
            scale = None
        if scale is not None and scale == scale and 0.5 <= scale <= 4:
            clean_export["scale"] = _num(scale)
        if clean_export:
            out["export"] = clean_export

    # 旧版编辑器仍有这两个右栏预览值；新版没有显示它们，但保留后可以无损
    # 打开旧配置，也让旧版回退页面的右栏同样满足“改了就写回”。
    try:
        height = float(value.get("viewHeight"))
    except (TypeError, ValueError):
        height = None
    if height is not None and height == height and 20 <= height <= 120:
        out["viewHeight"] = _num(height)
    if isinstance(value.get("varyEnabled"), bool):
        out["varyEnabled"] = value["varyEnabled"]
    return out


def default_track(glyphs):
    """中文默认无额外字距；只有带 adv 的拉丁字库沿用拉丁默认字距。"""
    is_latin = any(els and isinstance(els[0], dict) and "adv" in els[0]
                   for els in glyphs.get("items", {}).values())
    return rowmod.TRACK if is_latin else 0.0


def load_geo():
    global GEO
    GEO = normalize_glyphs(json.load(io.open(PATH, encoding="utf-8")))
    glyphs = GEO
    out = {
        "file": os.path.abspath(PATH),
        "glyphs": dict(H.params_of(glyphs),
                       vb=float(glyphs.get("vb", 24)), sw=float(glyphs.get("sw", 1.5)),
                       track=float(glyphs.get("track", default_track(glyphs))),
                       word=float(glyphs.get("word", rowmod.WORD)),
                       seed=preview_seed(glyphs.get("seed")),
                       glyphSeeds=seed_map(glyphs.get("glyphSeeds")),
                       glyphSeedMemory=seed_map(glyphs.get("glyphSeedMemory")),
                       editor=editor_config(glyphs.get("editor"), glyphs["items"].keys()),
                       items={n: [to_edit(e) for e in els]
                              for n, els in glyphs["items"].items()}),
    }
    if ROW:                      # 从 write 进来的：行预览直接就是刚生成的那一版
        out["row"] = ROW
    return out


def _num(v):
    """64.0 要写成 64 —— 不然一次空保存就把字库表头改一遍，diff 全是噪音。"""
    f = float(v)
    return int(f) if f == int(f) else f


def save_geo(glyphs):
    out = {"vb": _num(glyphs["vb"]), "sw": _num(glyphs["sw"])}
    for k in H.PARAMS:                         # 默认值不写进文件，diff 才干净
        if abs(float(glyphs.get(k, 1.0)) - 1.0) > 1e-9:
            out[k] = _num(glyphs[k])
    if abs(float(glyphs.get("track", default_track(glyphs))) - default_track(glyphs)) > 1e-9:
        out["track"] = _num(glyphs["track"])
    if abs(float(glyphs.get("word", rowmod.WORD)) - rowmod.WORD) > 1e-9:
        out["word"] = _num(glyphs["word"])
    seed = preview_seed(glyphs.get("seed"))
    if seed is not None:
        out["seed"] = seed
    seeds = {name: _num(value) for name, value in seed_map(glyphs.get("glyphSeeds")).items()
             if name in glyphs["items"]}
    if seeds:
        out["glyphSeeds"] = seeds
    seed_memory = {name: _num(value) for name, value in seed_map(glyphs.get("glyphSeedMemory")).items()
                   if name in glyphs["items"]}
    if seed_memory:
        out["glyphSeedMemory"] = seed_memory
    editor = editor_config(glyphs.get("editor"), glyphs["items"].keys())
    if editor:
        out["editor"] = editor
    out["items"] = {n: [to_geo(e) for e in els] for n, els in glyphs["items"].items()}
    text = json.dumps(out, ensure_ascii=False, indent=1)
    io.open(PATH, "w", encoding="utf-8").write(text + "\n" if not text.endswith("\n") else text)
    return len(text)


# ── 渲染 ──────────────────────────────────────────────────────────────
def render(vb, idx, items, g_amp=1.0, g_over=1.0, local=None):
    """一个字的手绘路径。idx 必须是它在字库里的真实序号 —— 种子按序号算。"""
    return H.draw([to_geo(e) for e in items], rowmod.hand_seed(idx, local),
                  vb / 24.0, g_amp, g_over)


def render_row(text, seed, ampk, mode, g_amp=1.0, g_over=1.0,
               do_vary=True, varyk=1.0, glyph_seeds=None, glyph_data=None,
               track=None, word=rowmod.WORD):
    """底下那条行预览。

    **这里的每一步都照抄 handdraw.write_lines 的单行分支** —— 种子怎么算、
    重写在哪一层、摆正拿哪份几何，全一样。所以同一个种子下，这条预览就是
    `write` 出的那一行，不是「差不多的一行」。改动这个函数时对着那边一起改。
    """
    # Live previews use an isolated draft, never mutate the saved library.
    g = glyph_data if glyph_data is not None else GEO
    if track is None:
        track = rowmod.TRACK if mode == "latin" else 0.0
    vb = float(g.get("vb", 64))
    sw = float(g.get("sw", 2.8))
    names = list(g["items"].keys())
    glyph_seeds = seed_map(g.get("glyphSeeds") if glyph_seeds is None else glyph_seeds)
    picked = rowmod.pick(text, g["items"])

    miss = [ch for nm, ch, ok in picked if nm is None]
    dup = []          # 兼容旧 API；显式变体与叠字轮换都由 row.pick 处理
    seq = [nm for nm, ch, ok in picked]

    # 每一次出现都自己重写一遍 —— 跟 write 同一个种子公式（li=0 这一行）
    geos = {}
    for oi, n in enumerate(seq):
        if not n or n not in g["items"]:
            continue
        els = [to_geo(e) for e in g["items"][n]]
        local = rowmod.local_seed(glyph_seeds, n)
        vary_seed = (local if local is not None else seed) * 131 + oi * 17
        geos[oi] = H.varymod.vary(els, vary_seed, cell=vb, amp=varyk) \
            if do_vary else els

    def item_seed(name, oi):
        return rowmod.effective_seed(glyph_seeds, name, seed)

    def polys(n, oi=None):
        """这一次出现实际要渲的那份几何 —— 摆正必须按它算，不是字库里那份。"""
        els = geos.get(oi) if oi is not None and oi in geos else \
            [to_geo(e) for e in g["items"].get(n, [])]
        out = []
        for el in els:
            if el.get("t", "path") == "path":
                out += path_to_polys(el["d"])
        return out

    if mode == "latin":
        advs = {n: float(els[0].get("adv", vb)) for n, els in g["items"].items() if els}
        L, width = rowmod.latin_layout([n if n else " " for n in seq], polys, advs,
                                       seed=seed, amp_k=ampk,
                                       track=float(track), word=float(word),
                                       seed_for=lambda name, oi: item_seed(name, oi),
                                       local_for=lambda name, oi: rowmod.local_seed(glyph_seeds, name) is not None)
        for it in L:
            it["baseline_dy"] = it["dy"]
    else:
        L = rowmod.han_layout(seq, polys, cell=vb, seed=seed, amp_k=ampk,
                              track=float(track),
                              seed_for=lambda name, oi: item_seed(name, oi),
                              local_for=lambda name, oi: rowmod.local_seed(glyph_seeds, name) is not None)
        width = vb * len(seq)

    x0, y0, x1, y1 = rowmod.bounds(L, polys, cell=vb)
    pad = 5.0
    vbx, vby = x0 - pad, y0 - pad
    vbw, vbh = (x1 - x0) + 2 * pad, (y1 - y0) + 2 * pad

    body = []
    for layout_index, it in enumerate(L):
        oi = it.get("source_index", layout_index)
        n = it["name"]
        if oi not in geos or not n:
            continue
        # idx 决定笔迹的种子；每次出现都换一个，两个「天」的线也不会同一个抖法
        paths = H.draw(geos[oi], rowmod.hand_seed(names.index(n) + 97 * oi,
                                                  rowmod.local_seed(glyph_seeds, n)),
                       vb / 24.0, g_amp, g_over)
        inner = "".join(
            ('<path d="%s" fill="currentColor" stroke="none"/>' % p["d"]) if p.get("f")
            else ('<path d="%s" stroke-width="%g"/>' % (p["d"], sw * p["w"])) if p.get("w")
            else ('<path d="%s"/>' % p["d"]) for p in paths)
        body.append('<g transform="%s">%s</g>' % (it["tf"], inner))

    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="%.2f %.2f %.2f %.2f" '
           'fill="none" stroke="currentColor" stroke-width="%g" stroke-linecap="round" '
           'stroke-linejoin="round">%s</svg>' % (vbx, vby, vbw, vbh, sw, "".join(body)))

    prev = None
    table = []
    for it in L:
        d = None if prev is None else abs(it["s"] - prev) * 100
        table.append({"name": it["name"], "s": round(it["s"], 3),
                      "diff": None if d is None else round(d, 1),
                      "thin": d is not None and d < 3.5 * ampk})
        prev = it["s"]
    return {"svg": svg, "table": table, "miss": miss, "dup": dup,
            "vb": [vbw, vbh], "ratio": vbw / vbh if vbh else 1}


# ── HTTP ──────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        b = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(b)

    def _send_file(self, path):
        try:
            with io.open(path, "rb") as stream:
                body = stream.read()
        except OSError:
            return False
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self._send(200, body, ctype)
        return True

    def _proxy_dev_get(self):
        """开发时把前端请求交给 Astro，保证 8731 和 4321 用同一份源码。

        Python 服务仍然只负责 `/api/*` 和旧版静态回退；只要 4321 在运行，
        页面、源码模块和 Vite 的开发资源都从那里来。这样改 `web/src` 后，
        不需要再手动 build 一次才能让 8731 看到同样的界面。
        """
        # 避免用户把 Python 服务也绑定到 4321 时代理到自己。
        if self.server.server_port == DEV_SERVER_PORT:
            return False
        conn = http.client.HTTPConnection(DEV_SERVER_HOST, DEV_SERVER_PORT, timeout=0.35)
        try:
            conn.request("GET", self.path, headers={
                "Host": "%s:%d" % (DEV_SERVER_HOST, DEV_SERVER_PORT),
                "Accept-Encoding": "identity",
            })
            response = conn.getresponse()
            body = response.read()
        except (OSError, http.client.HTTPException):
            return False
        finally:
            conn.close()

        self.send_response(response.status, response.reason)
        hop_by_hop = {
            "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
            "te", "trailer", "transfer-encoding", "upgrade", "content-length",
        }
        for name, value in response.getheaders():
            if name.lower() not in hop_by_hop:
                self.send_header(name, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
        return True

    def do_GET(self):
        route = urlsplit(self.path).path
        if route.startswith("/api/geo"):
            return self._send(200, json.dumps(load_geo(), ensure_ascii=False))
        if self._proxy_dev_get():
            return
        if route in ("/", "/index.html"):
            built_index = os.path.join(WEB_DIST, "index.html")
            if os.path.isfile(built_index):
                return self._send_file(built_index)
            html = io.open(os.path.join(HERE, "editor.html"), encoding="utf-8").read()
            return self._send(200, html, "text/html; charset=utf-8")
        if os.path.isdir(WEB_DIST):
            candidate = os.path.realpath(os.path.join(WEB_DIST, route.lstrip("/")))
            if os.path.commonpath((WEB_DIST, candidate)) == WEB_DIST and os.path.isfile(candidate):
                return self._send_file(candidate)
        self._send(404, "{}")

    def _remux(self, blob):
        """浏览器录不出 mp4 时的后路：把它录的那份转封装成 H.264 的 mp4。

        只有 MediaRecorder 不支持 video/mp4 的浏览器会走到这儿（Chrome / Safari
        的新版本都直接录 mp4，压根不发这个请求）。没装 ffmpeg 就明说，
        不要悄悄退回 webm —— 要的是 mp4。"""
        ffmpeg = shutil.which("ffmpeg")
        if not ffmpeg:
            return self._send(501, json.dumps(
                {"error": "这个浏览器录不出 mp4，本机也没有 ffmpeg 可以转。"
                          "装一个（brew install ffmpeg）或者换 Chrome / Safari 新版。"},
                ensure_ascii=False))
        tmp = tempfile.mkdtemp(prefix="hand-glyph-")
        src, dst = os.path.join(tmp, "in"), os.path.join(tmp, "out.mp4")
        try:
            with io.open(src, "wb") as f:
                f.write(blob)
            r = subprocess.run([ffmpeg, "-y", "-i", src, "-c:v", "libx264", "-preset", "veryfast",
                                "-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart", dst],
                               capture_output=True)
            if r.returncode != 0 or not os.path.isfile(dst):
                tail = r.stderr.decode("utf-8", "replace")[-400:]
                return self._send(500, json.dumps({"error": "ffmpeg 转码失败：" + tail},
                                                  ensure_ascii=False))
            with io.open(dst, "rb") as f:
                return self._send(200, f.read(), "video/mp4")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        route = urlsplit(self.path).path
        if route == "/api/mp4":          # 二进制进、二进制出，不走 JSON
            return self._remux(self.rfile.read(n))
        req = json.loads(self.rfile.read(n) or b"{}")
        try:
            if route == "/api/render":
                paths = render(req["vb"], req["idx"], req["items"],
                               float(req.get("amp", 1.0)), float(req.get("over", 1.0)),
                               req.get("localSeed"))
                return self._send(200, json.dumps({"paths": paths}, ensure_ascii=False))
            if route == "/api/row":
                mode = req.get("mode", "han")
                track = req.get("track")
                if track is None:
                    track = rowmod.TRACK if mode == "latin" else 0.0
                return self._send(200, json.dumps(
                    render_row(req["text"], int(req.get("seed", 0)),
                               float(req.get("ampk", 1.0)), mode,
                               float(req.get("amp", 1.0)), float(req.get("over", 1.0)),
                               bool(req.get("vary", True)), float(req.get("varyk", 1.0)),
                               req.get("glyphSeeds"), req.get("glyphData"),
                               float(track),
                               float(req.get("word", rowmod.WORD))),
                    ensure_ascii=False))
            if route == "/api/save":
                global GEO
                glyphs = req.get("glyphs")
                if not isinstance(glyphs, dict):
                    return self._send(400, json.dumps(
                        {"error": "保存请求必须提供扁平的 glyphs 字段。"},
                        ensure_ascii=False))
                GEO = {"vb": _num(glyphs["vb"]), "sw": _num(glyphs["sw"]),
                       "track": _num(glyphs.get("track", default_track(glyphs))),
                       "word": _num(glyphs.get("word", rowmod.WORD)),
                       "seed": preview_seed(glyphs.get("seed")),
                       "glyphSeeds": seed_map(glyphs.get("glyphSeeds")),
                       "glyphSeedMemory": seed_map(glyphs.get("glyphSeedMemory")),
                       "editor": editor_config(glyphs.get("editor"), glyphs["items"].keys()),
                       "items": {n: [to_geo(e) for e in els]
                                 for n, els in glyphs["items"].items()}}
                size = save_geo(glyphs)
                # Once a right-panel edit is written, the one-shot `write` preview
                # must no longer override the persisted seed/text on a refresh.
                global ROW
                ROW = None
                return self._send(200, json.dumps({"ok": True, "bytes": size,
                                                   "file": os.path.abspath(PATH)}))
        except Exception as e:
            import traceback
            traceback.print_exc()
            return self._send(500, json.dumps({"error": "%s: %s" % (type(e).__name__, e)},
                                              ensure_ascii=False))
        self._send(404, "{}")


EMPTY = """{
 "vb": 64,
 "sw": 2.8,
 "amp": 0.9,
 "jit": 0.9,
 "vary": 0.9,
 "items": {}
}
"""


def _bind(port, tries=20):
    """端口被占就顺着往后找。`write` 默认拉起编辑器，连着跑两回很正常，
    第二回不该因为「Address already in use」就死在这儿。"""
    for p in range(port, port + tries):
        try:
            return ThreadingHTTPServer(("127.0.0.1", p), Handler), p
        except OSError:
            continue
    raise SystemExit("%d–%d 都被占着，用 -p 指一个端口。" % (port, port + tries - 1))


def serve(path, port=8731, open_browser=True, row=None):
    """row = {"text":…, "seed":…}：从 write 进来时把刚排的那一行预填进行预览。"""
    global PATH, ROW
    PATH, ROW = path, row
    if not os.path.exists(path):          # 空库开局：字库是每次自己攒的，不预置字形
        io.open(path, "w", encoding="utf-8").write(EMPTY)
        print("新建空字库 %s（64 网格 / 线重 2.8 / 手感 0.9），"
              "用「＋ 新字」开始加。" % path)
    load_geo()
    n = len(GEO["items"])
    srv, port = _bind(port)
    url = "http://127.0.0.1:%d/" % port
    print("编辑 %s（%d 个字形）" % (os.path.abspath(path), n))
    print("  " + url)
    print("  拖的是骨架点，看到的是抖动后的线。存盘直接写回上面这个文件。")
    print("  Ctrl-C 退出。")
    if open_browser:
        webbrowser.open(url)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n退出。")
