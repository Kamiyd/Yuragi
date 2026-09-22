"""骨架叠图：把字库里的骨架（红线）叠在参照字体上，一眼看出偏在哪。

    python3 overlay.py geo.json "白日依山尽" -o ov.png
    python3 overlay.py geo.json "白日依山尽" --format svg -o ov.svg   # 不需要 Pillow
    python3 overlay.py geo.json "白日依山尽" --han /path/黑体.ttc --hand /path/Xiaolai-Regular.ttf

PNG 要 Pillow（`pip install -r requirements.txt`）；没装时自动改出 SVG：参照字交给浏览器
用系统字体渲染，骨架是原始路径。SVG 版居中按字体度量算，和 PNG 可能差一两个单位，
读结构、定比例够用。

每个参照字体一排，上排黑体（核结构：笔画数、笔顺、部件位置），下排小赖（定比例：
重心、笔画长短、笔与笔的呼应）。字库里还没有的字只渲参照，照着读坐标写骨架。

参照字只用来看，不描轮廓：读坐标用最细的字重（黑体 Light），粗字重的笔画中线会偏。
网格每 8 个单位一条线，32 处加深，坐标直接从刻度上读。

小赖先找本机装好的；没装的话第一次运行会从 lxgw/kose-font 的固定版本下载，
按 SHA-256 校验后放进缓存目录（~/.cache/hand-glyph/fonts），以后直接用。
不装进系统字体。小赖是 SIL OFL 1.1，版权 LXGW / Nozomi Seto。
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

from flatten import path_to_polys

HAN_FONTS = [
    "/System/Library/Fonts/STHeiti Light.ttc",     # macOS 自带黑体里最细的一档
    "/System/Library/Fonts/STHeiti Medium.ttc",
]
HAND_FONTS = [
    os.path.expanduser("~/Library/Fonts/Xiaolai-Regular.ttf"),
    "/Library/Fonts/Xiaolai-Regular.ttf",
    os.path.expanduser("~/.local/share/fonts/Xiaolai-Regular.ttf"),
]

# 钉死版本：换版本时 URL 和校验值一起改，保证每个人对照的是同一套字
XIAOLAI_URL = "https://github.com/lxgw/kose-font/releases/download/v3.126/Xiaolai-Regular.ttf"
XIAOLAI_SHA256 = "e2f68daf0e72777a8cf58bc83de1b98634b251e537ddbfca24b0ae50d1802da2"
CACHE_DIR = os.path.join(os.environ.get("XDG_CACHE_HOME") or os.path.expanduser("~/.cache"),
                         "hand-glyph", "fonts")


def first_existing(paths):
    return next((p for p in paths if p and os.path.exists(p)), None)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url, dest):
    """先用标准库下；Python 的证书包常常和系统不一致（代理、没跑 Install Certificates），
    失败了再交给系统的 curl。哪条路下来的都要过 SHA-256，所以换路不降低安全性。"""
    try:
        urllib.request.urlretrieve(url, dest)
        return
    except Exception as first:
        curl = shutil.which("curl")
        if not curl:
            raise first
        print("  标准库下载失败（%s），改用 curl…" % type(first).__name__)
        subprocess.run([curl, "-fsSL", "--retry", "2", "-o", dest, url], check=True)


def reachable(url):
    """只取响应头，看下载地址通不通；返回 (状态, 字节数)。同样先标准库、再 curl。"""
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=8) as resp:
            return resp.status, resp.headers.get("Content-Length")
    except Exception as first:
        curl = shutil.which("curl")
        if not curl:
            raise first
        out = subprocess.run([curl, "-sIL", "--max-time", "8", url], capture_output=True, text=True, check=True).stdout
        status = [l.split()[1] for l in out.splitlines() if l.startswith("HTTP/")]
        length = [l.split(":", 1)[1].strip() for l in out.splitlines() if l.lower().startswith("content-length:")]
        return (status[-1] if status else "?"), (length[-1] if length else "?")


def cached_xiaolai(download=True):
    """缓存里有就用；没有就下载到临时文件，校验通过再挪进缓存 —— 半截文件不会留下来。"""
    path = os.path.join(CACHE_DIR, "Xiaolai-Regular.ttf")
    if os.path.exists(path):
        return path
    if not download:
        return None
    os.makedirs(CACHE_DIR, exist_ok=True)
    print("本机没有小赖，下载一次到 %s（约 22MB，SIL OFL 1.1）…" % CACHE_DIR)
    fd, tmp = tempfile.mkstemp(dir=CACHE_DIR, suffix=".part")
    os.close(fd)
    try:
        fetch(XIAOLAI_URL, tmp)
        got = sha256(tmp)
        if got != XIAOLAI_SHA256:
            raise ValueError("校验不对：%s" % got)
        os.replace(tmp, path)
        return path
    except Exception as e:  # 网络不通、校验失败都退回只出黑体那一排
        print("下载小赖失败（%s）。可以手动装好，或用 --hand 指定。" % e)
        return None
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def main():
    ap = argparse.ArgumentParser(description="骨架叠在黑体 + 小赖上出对照图")
    ap.add_argument("geo")
    ap.add_argument("text")
    ap.add_argument("-o", "--out", default="overlay.png")
    ap.add_argument("--han", help="结构参照字体（默认系统黑体 Light）")
    ap.add_argument("--hand", help="比例参照字体（默认小赖 Xiaolai-Regular）")
    ap.add_argument("--scale", type=int, default=6, help="一个网格单位多少像素")
    ap.add_argument("--no-download", action="store_true", help="本机和缓存都没有小赖时不下载")
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
    hand = a.hand or first_existing(HAND_FONTS) or cached_xiaolai(not a.no_download)
    if han:
        rows.append(("黑体", han))
    else:
        print("没找到系统黑体，用 --han 指定一个简体印刷体")
    if hand:
        rows.append(("小赖", hand))
    else:
        print("没有小赖这一排：本机没装、缓存里也没有。去掉 --no-download 自动下载，或用 --hand 指定")
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
        # 字号取格子的 0.87：黑体和小赖的字面都大致落在 7–57 里
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


# 系统里装好时浏览器按名字找得到；只在缓存里的字体靠 @font-face 的 file:// 地址，
# 有的浏览器会拦本地字体，拦了就退到名字这一层
FAMILIES = {"黑体": "'Heiti SC', 'STHeiti', 'PingFang SC', sans-serif", "小赖": "'Xiaolai', 'Xiaolai SC', cursive"}


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
