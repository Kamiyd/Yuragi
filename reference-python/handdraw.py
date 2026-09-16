#!/usr/bin/env python3
"""手写字生成器 —— 通用入口，不绑定任何项目。

    python3 handdraw.py write   geo.json "今天好心情"  排一行字出 SVG —— **每次跑都不一样**
                                                      排完自动拉起编辑器看这一版；
                                                      不想开加 --no-edit
    python3 handdraw.py edit    geo.json [-p 8731]    浏览器里拖骨架改字（写回本文件）
    python3 handdraw.py vary    geo.json [-n 8]       同一个字写 n 遍，看变化够不够
    python3 handdraw.py gallery geo.json -o g.html    自检画廊（多尺寸 + 亮暗）
    python3 handdraw.py svg     geo.json -o out/      每个字一个 .svg
    python3 handdraw.py json    geo.json              路径 JSON，贴进代码用
    python3 handdraw.py ts      geo.json              TypeScript 模块

**真相层是几何 JSON，不是跑出来的 path。** 骨架按规规矩矩的样子画（横是平的、
竖是直的、折角是尖的），手感由滤镜统一加。所以不要手工去改跑出来的坐标，
也不要在几何里预先把线画歪 —— 两层抖动会互相打架。

滤镜是确定性的：同一份几何 + 同一个顺序 = 同一条路径。种子按字在字库里的
**顺序**算，所以新字往字库的**末尾**加；插在中间会让后面所有字重抖一遍
（形状不变，抖法变，diff 会很吵）。改一个字里的笔顺同理。

几何 JSON 支持两种写法，从简到繁：

    {"今": [ {...笔画...} ], "天": [...]}                           # 只有字形
    {"vb":64, "sw":2.8, "items": {"今": [...]}}                     # 带网格参数

字库级字段（都是**倍率**，缺省 1.0 = 老字库行为不变；新建的空库预设 0.9，
见 reference/params.md「新建空字库的预设」。编辑器右栏拖的就是这几个）：
    "sw":   2.8     线宽。不是倍率，是绝对值
    "amp":  1.0     整体的抖动倍率，跟逐笔的 amp 乘起来
    "over": 1.0     收笔越位倍率 —— 笔画两头探出去多少
    "jit":  1.0     排一行时的大小起伏倍率（逐字缩放/压扁/旋转/位移一起缩放）
    "vary": 1.0     骨架层重写的幅度倍率 —— 同一个字每次写得有多不一样

元素类型：
    {"t":"path",   "d":"M3 12 L21 12"}
    {"t":"rect",   "x":4,"y":6,"width":16,"height":12,"rx":2}
    {"t":"circle", "cx":12,"cy":12,"r":6}
    {"t":"ellipse","cx":12,"cy":12,"rx":7,"ry":5}
可选字段：
    "fill": true    实心块；填充图形自动闭合、不越位。汉字用不到
    "amp":  0.65    这一笔的抖动倍率，默认 1.0。**汉字一律 0.65，每一笔都要写**
    "w":    1.1     这一笔的**线重**倍率，默认 1.0，用来做提按，
                    范围 0.85–1.15。
                    别往下压过 0.85：sw 2.8 × 0.85 = 2.38，在 44px 的尺寸下限上
                    只剩 1.64px，已经贴着看不见的门槛了。
"""
import io, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from hand import hand
from flatten import path_to_polys, rect_to_poly, circle_to_poly, corners, dedupe
import row as rowmod
import vary as varymod

# ── 滤镜参数（24 网格上的手感，其它网格按 vb/24 等比放大）──────────────
# 抖动幅度按**弧长**分档：三五个单位长的短笔画按大图形那个幅度抖会直接散掉。
AMP_SHORT, AMP_MID, AMP_LONG = 0.14, 0.24, 0.34
TRACE_AMP = 0.65                 # 保留手迹也保留手感；旧数据里的 amp=0 视为历史默认值
LEN_SHORT, LEN_MID = 5.0, 11.0
OVER_SHORT, OVER_LONG = 0.28, 0.5   # 收笔越位：闭合图形不越位
CORNER_DEG = 32                     # 转向超过这个角度算硬角，滤镜在那儿收着
STEP = 1.35                         # 重采样步长：直接决定曲线段数，也就是体积
SIMPLIFY = 0.45                     # 进滤镜前的抽稀：圆/圆弧的密点先合并掉
PREC = 2                            # 坐标小数位 —— 1 位在 0.45 长的越位段上会把切线量化歪，
                                    # 折出半径 0.1 的假弯，Figma 这类「描边转轮廓再填充」的渲染器就缺角

# 改这几个数会同时改变手感和体积。动之前先跑 gallery 看 15px 下还立不立得住，
# 而且要动就动幅度那三档，别动阈值和步长 —— 后两个一动，整套字全变。


def _round(d: str) -> str:
    """把路径里的数字压到 PREC 位，去掉没用的 0 和多余空格。"""
    out, num = [], ""
    for ch in d + " ":
        if ch.isdigit() or ch in ".-":
            num += ch
        else:
            if num:
                v = round(float(num), PREC)
                s = f"{v:.{PREC}f}".rstrip("0").rstrip(".")
                if s in ("", "-0"):
                    s = "0"
                if out and out[-1] not in "MCLZ " and not s.startswith("-"):
                    out.append(" ")
                out.append(s)
                num = ""
            if ch != " ":
                out.append(ch)
    return "".join(out)


def polys_of(items):
    """一个字的笔画表 -> [(折线, 是否闭合, 是否填充, 幅度倍率)]"""
    out = []
    for el in items:
        t = el.get("t", "path")
        fill = bool(el.get("fill"))
        amp = float(el.get("amp", 1.0))
        # 早期“保留手迹”用 amp=0 代表不改几何，结果也把种子驱动的线条手感关掉了。
        # 保留 traceMode 的复杂路径，但让旧字形和新字形一样接受确定性的线条抖动。
        if el.get("traceMode") == "original" and abs(amp) < 1e-9:
            amp = TRACE_AMP
        w = float(el.get("w", 1.0))
        num = lambda k, d=0: float(el.get(k, d))
        if t == "path":
            polys = path_to_polys(el["d"])
        elif t == "rect":
            polys = [tuple(rect_to_poly(num("x"), num("y"), num("width"),
                                        num("height"), num("rx")))]
        elif t == "circle":
            polys = [tuple(circle_to_poly(num("cx"), num("cy"), num("r")))]
        elif t == "ellipse":
            polys = [tuple(circle_to_poly(num("cx"), num("cy"), num("rx"),
                                          ry=num("ry")))]
        else:
            raise SystemExit(f"未知元素类型 {t!r} —— 只支持 path / rect / circle / ellipse")
        for poly, closed in polys:
            out.append((poly, closed or fill, fill, amp, w))
    return out


def draw(items, idx, scale, g_amp=1.0, g_over=1.0):
    """一个字的全部手绘路径。idx 决定种子，所以笔顺不能乱。

    g_amp / g_over 是**整套字库**的抖动、越位倍率（几何 JSON 的 `amp` / `over`），
    跟逐笔的 `amp` 是乘起来的：逐笔那个管「这一笔经不经抖」，字库级这个管
    「这套字整体多毛」。编辑器右栏拖的就是这两个。
    """
    ds = []
    for k, (poly, closed, fill, ampk, wk) in enumerate(polys_of(items)):
        poly = dedupe(poly, eps=SIMPLIFY * scale)
        if len(poly) < 2:
            continue
        L = sum(math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1])
                for i in range(len(poly) - 1))
        base = AMP_SHORT if L < LEN_SHORT * scale else \
               AMP_MID if L < LEN_MID * scale else AMP_LONG
        over = 0.0 if closed else (OVER_SHORT if L < 7 * scale else OVER_LONG)
        d = hand(poly, seed=idx * 7 + k * 3 + 1, amp=base * scale * ampk * g_amp,
                 closed=closed, sharp=tuple(corners(poly, closed, CORNER_DEG)),
                 over=over * scale * g_over, step=STEP * scale)
        item = {"d": _round(d)}
        if fill:
            item["f"] = True
        if abs(wk - 1.0) > 1e-6:
            item["w"] = round(wk, 3)
        ds.append(item)
    return ds


# 字库级手感参数：默认全是 1.0（= 不改变现有行为，老文件照跑）
PARAMS = ("amp", "over", "jit", "vary")


def params_of(g):
    """字库的手感倍率。缺省 1.0 —— 老的几何 JSON 一个字段都不用改。"""
    return {k: float(g.get(k, 1.0)) for k in PARAMS}


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
    """读取编辑器写回的全局种子；没有设置时让 write 保持随机默认。"""
    try:
        seed = int(value)
    except (TypeError, ValueError):
        return default
    return seed if seed > 0 else default


def normalize(geo):
    """把简写、完整写法和旧的单字库包装统一成一套扁平字库。

    旧版允许同一个文件里放多个命名字库；那层功能已经移除，遇到多个旧字库
    直接报错，避免悄悄选错一套字。只有一个旧包装时仍然可以无损读取。
    """
    if not isinstance(geo, dict):
        raise ValueError("几何 JSON 必须是对象")
    if isinstance(geo.get("items"), dict):
        glyphs = geo
    else:
        candidates = [value for value in geo.values()
                      if isinstance(value, dict) and isinstance(value.get("items"), dict)]
        if len(candidates) == 1:
            glyphs = candidates[0]
        elif candidates:
            raise ValueError("这个文件包含多套字库；当前版本只支持一套扁平字库，请先合并后再打开。")
        else:
            glyphs = {"items": geo}

    vb = float(glyphs.get("vb", 24))
    p = params_of(glyphs)
    glyph_seeds = seed_map(glyphs.get("glyphSeeds"))
    return dict(p, vb=vb, sw=float(glyphs.get("sw", 1.5)),
                seed=preview_seed(glyphs.get("seed")), raw=glyphs["items"],
                glyphSeeds=glyph_seeds,
                items={name: draw(items, rowmod.hand_seed(
                            i, rowmod.local_seed(glyph_seeds, name)),
                            vb / 24.0, p["amp"], p["over"])
                       for i, (name, items) in enumerate(glyphs["items"].items())})


def load(path):
    return normalize(json.load(io.open(path, encoding="utf-8")))


# ── 输出 ──────────────────────────────────────────────────────────────
def svg_markup(paths, size, vb, sw, extra=""):
    def one(p):
        if p.get("f"):
            return '<path d="%s" fill="currentColor" stroke="none"/>' % p["d"]
        if p.get("w"):     # 逐笔线重：只有汉字用得上，其余图元不带这个属性
            return '<path d="%s" stroke-width="%g"/>' % (p["d"], sw * p["w"])
        return '<path d="%s"/>' % p["d"]
    ps = "".join(one(p) for p in paths)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" '
            f'viewBox="0 0 {vb:g} {vb:g}" fill="none" stroke="currentColor" '
            f'stroke-width="{sw:g}" stroke-linecap="round" stroke-linejoin="round"'
            f'{extra}>{ps}</svg>')


def cmd_svg(glyphs, out):
    out = out or "hand-svg"
    os.makedirs(out, exist_ok=True)
    n = 0
    for name, paths in glyphs["items"].items():
        f = os.path.join(out, f"{name}.svg")
        io.open(f, "w", encoding="utf-8").write(
            svg_markup(paths, glyphs["vb"], glyphs["vb"], glyphs["sw"]) + "\n")
        n += 1
    print(f"写出 {n} 个 .svg → {out}/")
    print("每个都是 currentColor + fill=none，颜色跟着父元素走，亮暗主题各一份不用。")


def cmd_json(glyphs, out):
    data = {"vb": glyphs["vb"], "sw": glyphs["sw"], "items": glyphs["items"]}
    text = json.dumps(data, ensure_ascii=False, indent=2)
    if out:
        io.open(out, "w", encoding="utf-8").write(text)
        print("写出", out)
    else:
        print(text)


def cmd_ts(glyphs, out):
    L = ["/* 由 handdraw.py 从几何 JSON 生成 —— 不要手改坐标。",
         " * 要改一个字的形，改几何再重跑。手改的那一个跟其它几十个不是同一支笔。 */",
         "", "export interface HandPath { d: string; f?: boolean; w?: number }",
         "export interface HandSet { vb: number; sw: number; items: Record<string, HandPath[]> }",
         "", "export const GLYPHS: HandSet = {",
         f"  vb: {glyphs['vb']:g},", f"  sw: {glyphs['sw']:g},", "  items: {"]
    for name, paths in glyphs["items"].items():
        def one(p):
            extra = ", f: true" if p.get("f") else ""
            if p.get("w"):
                extra += ", w: %g" % p["w"]
            return '{ d: "%s"%s }' % (p["d"], extra)
        body = ", ".join(one(p) for p in paths)
        L.append(f"    {name}: [{body}],")
    L += ["  },", "};", ""]
    text = "\n".join(L)
    if out:
        io.open(out, "w", encoding="utf-8").write(text)
        print("写出", out)
    else:
        print(text)


def cmd_gallery(glyphs, out):
    """自检画廊：每枚在真实使用尺寸下各看一遍，亮暗背景各一遍。

    小尺寸看三件事：内部空隙有没有糊、细节有没有粘成一团、折角是不是还立着。
    放大好看、缩小散架，说明细节多了 —— 回去重画轮廓，不要调滤镜参数救。
    """
    sections = ""
    icon = glyphs["vb"] <= 32
    big = 56 if icon else 104
    sizes = [24, 18, 15] if icon else [48, 32, 24]
    cells = ""
    for k, v in glyphs["items"].items():
        small = "".join(svg_markup(v, s, glyphs["vb"], glyphs["sw"]) for s in sizes)
        cells += (f'<figure><div class="big" style="height:{big + 8}px">'
                  f'{svg_markup(v, big, glyphs["vb"], glyphs["sw"])}</div>'
                  f'<div class="row">{small}</div><figcaption>{k}</figcaption></figure>')
    col = 118 if icon else 172
    sections += (f'<h2>{len(glyphs["items"])} 枚 · {glyphs["vb"]:g} 网格 · 线宽 {glyphs["sw"]:g}'
                 f' <span>下排 {" / ".join(str(s) + "px" for s in sizes)}</span></h2>'
                 f'<div class="grid" style="grid-template-columns:'
                 f'repeat(auto-fill,minmax({col}px,1fr))">{cells}</div>')

    html = f"""<!doctype html><meta charset="utf-8"><title>手绘自检</title>
<style>
body{{margin:0;padding:24px 28px;background:#F5F5F4;color:#141414;
 font:13px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}}
h1{{font-size:15px;font-weight:600;margin:0 0 3px}}
p.sub{{color:#8a8a85;font-size:12px;margin:0 0 4px}}
h2{{font-size:11px;font-weight:600;color:#8a8a85;margin:24px 0 10px}}
h2 span{{font-weight:400;opacity:.7}}
.grid{{display:grid;gap:10px}}
figure{{margin:0;background:#fff;border:1px solid #EDEDEA;border-radius:10px;
 padding:12px 8px 8px;text-align:center}}
.big{{display:grid;place-items:center}}
.row{{display:flex;gap:9px;align-items:center;justify-content:center;height:26px;opacity:.92}}
figcaption{{margin-top:5px;font-size:10px;color:#8a8a85;word-break:break-all}}
.dark{{background:#141414;margin:24px -28px -24px;padding:24px 28px 32px}}
.dark h2{{color:#6e6e69}}
.dark figure{{background:#1D1D1B;border-color:#2A2A27;color:#EDEDEA}}
.dark figcaption{{color:#6e6e69}}
</style>
<h1>手绘自检画廊</h1>
<p class="sub">大图看轮廓，小图看糊不糊。放大好看、缩小散架 = 细节多了，回去重画轮廓，别调滤镜。</p>
{sections}
<div class="dark"><p class="sub" style="color:#6e6e69">暗色下再看一遍 —— 确认它不是靠某个背景色才成立。</p>{sections}</div>"""
    out = out or "gallery.html"
    io.open(out, "w", encoding="utf-8").write(html)
    print("画廊：", os.path.abspath(out))


def write_lines(g, text, seed, do_vary=True):
    """一行或多行字 -> 一整张 SVG。

    多行放进同一个 viewBox：文档要的「两行绑在一起缩」就是白送的 ——
    各行单独写 max-width 会让长的那行先被卡住，出来一行大一行小。
    """
    lines = [l for l in text.replace("/", "\n").split("\n") if l != ""]
    blocks, W, H = [], 0.0, 0.0
    for li, line in enumerate(lines):
        has_latin_metrics = any(items and items[0].get("adv") is not None
                                for items in g["items"].values())
        mode = "latin" if line.strip() and has_latin_metrics else "han"
        vb, sw = float(g.get("vb", 64)), float(g.get("sw", 2.8))
        p = params_of(g)
        names = list(g["items"])
        glyph_seeds = seed_map(g.get("glyphSeeds"))
        picked = rowmod.pick(line, g["items"])
        seq = [n for n, _, _ in picked]

        # 每一次出现都自己重写一遍；如果字库还有 `天2` 等显式变体，pick 会轮换它们
        geos = {}
        for oi, n in enumerate(seq):
            if not n or n not in g["items"]:
                continue
            els = g["items"][n]
            local = rowmod.local_seed(glyph_seeds, n)
            vary_seed = (local if local is not None else seed) * 131 + oi * 17 + li * 7
            geos[oi] = varymod.vary(els, vary_seed, cell=vb,
                                    amp=p["vary"]) \
                if do_vary else [dict(e) for e in els]

        def item_seed(name, oi):
            return rowmod.effective_seed(glyph_seeds, name, seed + li)

        def polys(n, oi=None):
            """这一次出现实际要渲的那份几何 —— 摆正必须按它算，不是字库里那份。"""
            els = geos.get(oi) if oi is not None and oi in geos else g["items"].get(n, [])
            out = []
            for el in els:
                if el.get("t", "path") == "path":
                    out += path_to_polys(el["d"])
            return out

        if mode == "latin":
            advs = {n: float(e[0].get("adv", vb)) for n, e in g["items"].items() if e}
            L, _ = rowmod.latin_layout([n or " " for n in seq], polys, advs,
                                       seed=seed + li, amp_k=p["jit"],
                                       seed_for=lambda name, oi: item_seed(name, oi),
                                       local_for=lambda name, oi: rowmod.local_seed(glyph_seeds, name) is not None)
            for it in L:
                it["baseline_dy"] = it["dy"]
        else:
            L = rowmod.han_layout(seq, polys, cell=vb, seed=seed + li, amp_k=p["jit"],
                                  seed_for=lambda name, oi: item_seed(name, oi),
                                  local_for=lambda name, oi: rowmod.local_seed(glyph_seeds, name) is not None)

        body = []
        for layout_index, it in enumerate(L):
            oi = it.get("source_index", layout_index)
            n = it["name"]
            if oi not in geos or not n:
                continue
            # idx 决定笔迹的种子；每次出现都换一个，两个「天」的线也不会同一个抖法
            paths = draw(geos[oi], rowmod.hand_seed(
                         names.index(n) + 97 * oi + 977 * li,
                         rowmod.local_seed(glyph_seeds, n)), vb / 24.0,
                         p["amp"], p["over"])
            inner = "".join(
                ('<path d="%s" fill="currentColor" stroke="none"/>' % p["d"]) if p.get("f")
                else ('<path d="%s" stroke-width="%g"/>' % (p["d"], sw * p["w"])) if p.get("w")
                else ('<path d="%s"/>' % p["d"]) for p in paths)
            body.append('<g transform="%s">%s</g>' % (it["tf"], inner))
        x0, y0, x1, y1 = rowmod.bounds(L, polys, cell=vb)
        blocks.append({"body": "".join(body), "box": (x0, y0, x1, y1), "sw": sw, "vb": vb})
        W = max(W, x1 - x0)

    pad, gap = 5.0, 7.0
    parts, y = [], pad
    for b in blocks:
        x0, y0, x1, y1 = b["box"]
        parts.append('<g transform="translate(%.2f %.2f)" stroke-width="%g">%s</g>'
                     % (pad - x0, y - y0, b["sw"], b["body"]))
        y += (y1 - y0) + gap
    H = y - gap + pad
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %.2f %.2f" fill="none" '
           'stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">%s</svg>'
           % (W + 2 * pad, H, "".join(parts)))
    return svg, (W + 2 * pad) / H


def cmd_write(g, text, out, seed, do_vary):
    # 缺字必须当场报死。渲出一张空 SVG 还打印「写出」是最糟的失败方式 ——
    # 文件在那儿、命令没报错，等发现的时候图已经贴到页面上了。
    have = set()
    have |= {rowmod.base_name(name) for name in g["items"]}
    miss = []
    for ch in text:
        if ch not in ("/", "\n", " ") and ch not in have and ch not in miss:
            miss.append(ch)
    if miss:
        print("字库里没有这几个字：%s" % " ".join(miss))
        print("先照 reference/glyphs.md「画一个新字」把它们画出来，加到字库的末尾。")
        raise SystemExit(1)
    svg, ratio = write_lines(g, text, seed, do_vary)
    out = out or "title.svg"
    io.open(out, "w", encoding="utf-8").write(svg + "\n")
    print("写出", os.path.abspath(out))
    print("  种子 %d —— 不带 -s 的话每次跑都是新的一版。想固定这一版就 -s %d。"
          % (seed, seed))
    print("  宽高比 %.2f。显示高度别低于 44px（汉字的尺寸下限）。" % ratio)


def cmd_vary(g, n, out):
    """同一个字写 n 遍摆一排 —— 判据只有一条：像同一个人写了 n 遍，
    不是同一张图，也不是 n 个人写的。"""
    sec = ""
    vb, sw = float(g.get("vb", 64)), float(g.get("sw", 2.8))
    rows = ""
    for i, (name, els) in enumerate(g["items"].items()):
        cells = ""
        local = rowmod.local_seed(g.get("glyphSeeds"), name)
        for k in range(n):
            base = local if local is not None else 0
            v = els if k == 0 else varymod.vary(els, base * 131 + k * 7919, cell=vb)
            paths = draw(v, rowmod.hand_seed(i + 97 * k, local), vb / 24.0)
            fell = k and all(a.get("d") == b.get("d") for a, b in zip(els, v))
            cells += ('<div class="c%s">%s</div>'
                      % (" same" if fell else "", svg_markup(paths, 64, vb, sw)))
        rows += ('<div class="r"><div class="nm">%s</div>%s</div>' % (name, cells))
    sec += '<h2>每个字写 %d 遍</h2><div class="rows">%s</div>' % (n, rows)
    html = """<!doctype html><meta charset="utf-8"><title>重写自检</title><style>
body{margin:0;padding:22px 26px;background:#F5F5F4;color:#141414;
 font:13px/1.5 -apple-system,"PingFang SC",sans-serif}
h1{font-size:15px;margin:0 0 3px}p.sub{color:#8a8a85;font-size:12px;margin:0 0 16px}
h2{font-size:11px;color:#8a8a85;margin:22px 0 8px}
.r{display:flex;align-items:center;gap:6px;margin-bottom:6px}
.nm{width:34px;font-size:11px;color:#8a8a85}
.c{width:64px;height:64px;background:#fff;border:1px solid #EDEDEA;border-radius:8px;
 display:grid;place-items:center}
.c:first-of-type{border-color:#141414}
.c.same{background:#FBF3EF;border-color:#E4C4B4}
.c svg{width:56px;height:56px}
</style><h1>同一个字，写 %d 遍</h1>
<p class="sub">第一格是字库里那份，后面每一格都是重摇的写法。判据：<b>像同一个人写了 %d 遍</b> ——
像同一张图 ✗，像 %d 个人写的 ✗。<span style="color:#B4552B">浅红格</span>= 摇不出合格写法退回了原样（笔画太挤）。</p>
%s""" % (n, n, n, sec)
    out = out or "vary.html"
    io.open(out, "w", encoding="utf-8").write(html)
    print("重写自检：", os.path.abspath(out))


CMDS = {"svg": cmd_svg, "gallery": cmd_gallery, "json": cmd_json, "ts": cmd_ts}

if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or (a[0] not in CMDS and a[0] not in ("edit", "write", "vary")) or len(a) < 2:
        print(__doc__)
        sys.exit(2)
    cmd, geo = a[0], a[1]
    out = a[a.index("-o") + 1] if "-o" in a else None
    if cmd == "edit":
        import edit
        port = int(a[a.index("-p") + 1]) if "-p" in a else 8731
        edit.serve(geo, port=port)
    elif cmd == "write":
        import random
        normalized = normalize(json.load(io.open(geo, encoding="utf-8")))
        raw = dict({p: normalized[p] for p in PARAMS},
                   vb=normalized["vb"], sw=normalized["sw"],
                   seed=normalized.get("seed"),
                   glyphSeeds=normalized.get("glyphSeeds", {}),
                   items=normalized["raw"])
        seed = (int(a[a.index("-s") + 1]) if "-s" in a
                else normalized.get("seed") or random.randrange(1, 10 ** 6))
        cmd_write(raw, a[2], out, seed, "--same" not in a)
        # 排完直接把编辑器递到手上：这一版长什么样、哪个字要改，在浏览器里看着调。
        # 不想开就 --no-edit（脚本里批量跑、CI 里都该带上）。
        if "--no-edit" not in a:
            import edit
            port = int(a[a.index("-p") + 1]) if "-p" in a else 8731
            print()
            edit.serve(geo, port=port, row={"text": a[2], "seed": seed})
    elif cmd == "vary":
        normalized = normalize(json.load(io.open(geo, encoding="utf-8")))
        raw = dict({p: normalized[p] for p in PARAMS},
                   vb=normalized["vb"], sw=normalized["sw"],
                   seed=normalized.get("seed"),
                   glyphSeeds=normalized.get("glyphSeeds", {}),
                   items=normalized["raw"])
        cmd_vary(raw, int(a[a.index("-n") + 1]) if "-n" in a else 6, out)
    else:
        CMDS[cmd](load(geo), out)
