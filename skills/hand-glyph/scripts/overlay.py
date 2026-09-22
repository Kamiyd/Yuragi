"""骨架叠图：把字库里的骨架（红线）叠在参照字体上，一眼看出偏在哪。

    python3 overlay.py geo.json "白日依山尽" -o ov.png
    python3 overlay.py geo.json "白日依山尽" --han /path/黑体.ttc --hand /path/Xiaolai-Regular.ttf

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
        urllib.request.urlretrieve(XIAOLAI_URL, tmp)
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
    a = ap.parse_args()

    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        sys.exit("需要 Pillow：pip install pillow")

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


if __name__ == "__main__":
    main()
