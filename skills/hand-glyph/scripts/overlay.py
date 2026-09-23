"""骨架叠图：把字库里的骨架（红线）叠在黑体上，核结构。

    python3 overlay.py geo.json "白日依山尽" -o ov.png
    python3 overlay.py geo.json "白日依山尽" --format svg -o ov.svg   # 不需要 Pillow
    python3 overlay.py geo.json "白日依山尽" --han /path/黑体.ttc

PNG 要 Pillow（`pip install -r requirements.txt`）；没装时自动改出 SVG：参照字交给浏览器
用系统字体渲染，骨架是原始路径。SVG 版居中按字体度量算，和 PNG 可能差一两个单位，
读结构够用。

**黑体只核结构**：笔画数、笔顺、部件位置。**样子不照它** —— 比例、框的大小、笔长、
横的斜度都按 reference/glyphs.md「骨架要拙」自己写。以前这里还叠一排手写体（小赖）
定比例，结果骨架被它带成「一款手写体字体」，规整得不像手写，已经去掉了。
想对照别的字体，用 --hand 自己指定，多出一排；只看，别照抄。

字库里还没有的字只渲参照，照着读坐标写骨架。读坐标用最细的字重（黑体 Light），
粗字重的笔画中线会偏。网格每 8 个单位一条线，32 处加深，坐标直接从刻度上读。
"""
import argparse
import json
import os
import sys

from flatten import path_to_polys

HAN_FONTS = [
    "/System/Library/Fonts/STHeiti Light.ttc",     # macOS 自带黑体里最细的一档
    "/System/Library/Fonts/STHeiti Medium.ttc",
]


def first_existing(paths):
    return next((p for p in paths if p and os.path.exists(p)), None)


def main():
    ap = argparse.ArgumentParser(description="骨架叠在黑体上出对照图（只核结构）")
    ap.add_argument("geo")
    ap.add_argument("text")
    ap.add_argument("-o", "--out", default="overlay.png")
    ap.add_argument("--han", help="结构参照字体（默认系统黑体 Light）")
    ap.add_argument("--hand", help="可选：再叠一排你指定的字体（只看，别照抄比例）")
    ap.add_argument("--scale", type=int, default=6, help="一个网格单位多少像素")
    ap.add_argument("--format", choices=["auto", "png", "svg"], default="auto",
                    help="auto：有 Pillow 出 PNG，没有就出 SVG")
    a = ap.parse_args()

    fmt = a.format
    if fmt != "svg":
        try:
            import PIL  # noqa: F401
            fmt = "png"
        except ImportError:
            if fmt == "png":
                sys.exit("PNG 需要 Pillow：python3 -m pip install -r requirements.txt；或者 --format svg")
            fmt = "svg"
            print("没装 Pillow，改出 SVG（浏览器打开看）。要 PNG：python3 -m pip install -r requirements.txt")
    if fmt == "svg" and a.out.endswith(".png"):
        a.out = a.out[:-4] + ".svg"

    rows = []
    han = a.han or first_existing(HAN_FONTS)
    if han:
        rows.append(("黑体", han))
    else:
        print("没找到系统黑体，用 --han 指定一个简体印刷体")
    if a.hand:
        if os.path.exists(a.hand):
            rows.append((os.path.splitext(os.path.basename(a.hand))[0], a.hand))
        else:
            print("--hand 指定的字体不存在：%s" % a.hand)
    if not rows:
        sys.exit(1)

    g = json.load(open(a.geo, encoding="utf-8"))
    items = g.get("items", g)
    chars = [ch for ch in a.text if not ch.isspace()]
    if fmt == "svg":
        write_svg(rows, items, chars, a.out)
        print("写出", os.path.abspath(a.out), "（%s）" % " / ".join(name for name, _ in rows))
        return
    from PIL import Image, ImageDraw, ImageFont
    S = a.scale
    C = 64 * S
    im = Image.new("RGB", (C * len(chars), C * len(rows)), "white")
    d = ImageDraw.Draw(im)
    for r, (_, path) in enumerate(rows):
        # 字号取格子的 0.87：黑体的字面大致落在 7–57 里
        font = ImageFont.truetype(path, int(56 * S))
        oy = r * C
        for i, ch in enumerate(chars):
            ox = i * C
            for k in range(0, 65, 8):
                col = (228, 228, 228) if k % 32 else (190, 190, 190)
                d.line([(ox + k * S, oy), (ox + k * S, oy + C)], fill=col)
                d.line([(ox, oy + k * S), (ox + C, oy + k * S)], fill=col)
            d.text((ox + C / 2, oy + C / 2), ch, font=font, fill=(160, 160, 160), anchor="mm")
            for el in items.get(ch, []):
                if el.get("t", "path") != "path":
                    continue
                for pts, _ in path_to_polys(el["d"]):
                    d.line([(ox + x * S, oy + y * S) for x, y in pts], fill=(220, 40, 40), width=max(2, S // 2))
    im.save(a.out)
    print("写出", os.path.abspath(a.out), "（%s）" % " / ".join(name for name, _ in rows))


# 系统里装好时浏览器按名字找得到；--hand 指定的文件靠 @font-face 的 file:// 地址，
# 有的浏览器会拦本地字体，拦了就退到通用字体
FAMILIES = {"黑体": "'Heiti SC', 'STHeiti', 'PingFang SC', sans-serif"}


def write_svg(rows, items, chars, out):
    C = 64
    faces, body = [], []
    for r, (name, path) in enumerate(rows):
        faces.append("@font-face{font-family:ref%d;src:url('file://%s')}" % (r, path))
        oy = r * C
        for i, ch in enumerate(chars):
            ox = i * C
            for k in range(0, 65, 8):
                col = "#bebebe" if k % 32 == 0 else "#e4e4e4"
                body.append('<path d="M%d %d v64 M%d %d h64" stroke="%s" stroke-width="0.15"/>'
                            % (ox + k, oy, ox, oy + k, col))
            weight = ' font-weight="300"' if name == "黑体" else ""
            body.append('<text x="%d" y="%d" font-size="56" font-family="ref%d, %s"%s fill="#a0a0a0" '
                        'text-anchor="middle" dominant-baseline="central">%s</text>'
                        % (ox + 32, oy + 32, r, FAMILIES.get(name, "sans-serif").replace("'", "&apos;"), weight, ch))
            paths = "".join('<path d="%s"/>' % el["d"] for el in items.get(ch, []) if el.get("t", "path") == "path")
            if paths:
                body.append('<g transform="translate(%d %d)" fill="none" stroke="#dc2828" stroke-width="0.7" '
                            'stroke-linecap="round" stroke-linejoin="round">%s</g>' % (ox, oy, paths))
    W, H = C * len(chars), C * len(rows)
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
           '<style>%s</style><rect width="%d" height="%d" fill="#fff"/>%s</svg>\n'
           % (W * 6, H * 6, W, H, "".join(faces), W, H, "".join(body)))
    open(out, "w", encoding="utf-8").write(svg)


if __name__ == "__main__":
    main()
