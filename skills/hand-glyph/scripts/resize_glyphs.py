#!/usr/bin/env python3
"""按目标字面高整体缩放字形 —— 把一句标题里字的大小拉开（glyphs.md「字有大有小」）。

    python3 scripts/resize_glyphs.py in.json out.json 上=22 月=27 海=48 涯=50
    python3 scripts/resize_glyphs.py in.json out.json --heights sizes.json --drift 1.5

每个点了名的字绕自己的字面中心等比缩放到目标字面高，再摆回格心（32, 32）；没点名的字一个字符都不动。
命令字母原样保留（H 还是 H、Q 还是 Q），只改坐标 —— 笔顺、笔画数、w、amp、字在字库里的顺序都不变
（种子按顺序算，顺序一动整套字重抖）。

缩完会列出间距（按线段算的真实最小间距）落在 0.4–4.0 之间的笔画对。**缩小的字，浮开的空不跟着缩**：
本来就该相接的（撇接竖、框角、捺挂在撇上）不用管；该浮着的点和小部件要拉回 4.5 以上 ——
回编辑器拖，或者在自己的生成脚本里挪。
"""
import argparse, json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import dpath
from flatten import path_to_polys


def _pt_seg(p, a, b):
    dx, dy = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dy * dy or 1e-12
    t = max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2))
    return math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)


def _cross(a, b, c, d):
    def o(p, q, r):
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
    return o(a, b, c) * o(a, b, d) < 0 and o(c, d, a) * o(c, d, b) < 0


def stroke_gap(pa, pb):
    """两笔之间真正的最小间距（按线段算）。
    不用 vary.gaps：它只比采样点，一笔 `M… L…` 的直线只有两个端点 —— 横竖交叉的两笔会被报成隔着八九格"""
    sa, sb = list(zip(pa, pa[1:])), list(zip(pb, pb[1:]))
    if any(_cross(a, b, c, d) for a, b in sa for c, d in sb):
        return 0.0
    m = min((_pt_seg(p, c, d) for p in pa for c, d in sb), default=1e9)
    return min([m] + [_pt_seg(p, a, b) for p in pb for a, b in sa])


def stroke_poly(d):
    ps = path_to_polys(d)
    return [pt for poly, _ in ps for pt in poly]


def face(els):
    xs, ys = [], []
    for e in els:
        for poly, _ in path_to_polys(e["d"]):
            xs += [p[0] for p in poly]; ys += [p[1] for p in poly]
    return min(xs), min(ys), max(xs), max(ys)


def scale_d(d, s, c, to):
    segs = dpath.parse(d)
    for seg in segs:
        for pt in seg["p"]:
            pt[0] = to[0] + (pt[0] - c[0]) * s
            pt[1] = to[1] + (pt[1] - c[1]) * s
        if seg["c"] == "A":
            seg["a"][0] *= s; seg["a"][1] *= s
    return dpath.serialize(segs)


def main():
    ap = argparse.ArgumentParser(description="按目标字面高缩放字形，拉开一句标题里字的大小")
    ap.add_argument("src"); ap.add_argument("dst")
    ap.add_argument("sizes", nargs="*", help="字=字面高（64 格），比如 上=22 涯=50")
    ap.add_argument("--heights", help="JSON：{\"上\": 22, \"涯\": 50}")
    ap.add_argument("--drift", type=float, help="顺手把字库表头的错落倍率改掉（标题拉开大小后 1.5 更像手写）")
    a = ap.parse_args()

    target = json.load(open(a.heights, encoding="utf-8")) if a.heights else {}
    for kv in a.sizes:
        k, v = kv.split("=")
        target[k] = float(v)
    if not target:
        sys.exit("没有要缩的字：写成 上=22 涯=50，或者 --heights sizes.json")

    lib = json.load(open(a.src, encoding="utf-8"))
    items = lib["items"] if isinstance(lib.get("items"), dict) else lib
    cell = float(lib.get("vb", 64)) if "items" in lib else 64.0
    miss = [k for k in target if k not in items]
    if miss:
        sys.exit("字库里没有：" + " ".join(miss))

    hs = []
    for name, h in target.items():
        els = items[name]
        x0, y0, x1, y1 = face(els)
        s = h / (y1 - y0)
        c = ((x0 + x1) / 2, (y0 + y1) / 2)
        for e in els:
            e["d"] = scale_d(e["d"], s, c, (cell / 2, cell / 2))
        hs.append(h)
        print("%s  %5.1f×%-5.1f → %5.1f×%-5.1f  ×%.2f" % (name, x1 - x0, y1 - y0, (x1 - x0) * s, h, s))
        nx0, ny0, nx1, ny1 = face(els)
        if nx0 < 7 or ny0 < 7 or nx1 > cell - 7 or ny1 > cell - 7:
            print("    ↑ 字面出了 7–%g：放大过头了，收一点" % (cell - 7))
        polys = [stroke_poly(e["d"]) for e in els]
        close = [(i + 1, j + 1, stroke_gap(polys[i], polys[j]))
                 for i in range(len(polys)) for j in range(i + 1, len(polys))]
        close = [t for t in close if 0.4 < t[2] < 4.0]
        if close:
            print("    间距 0.4–4.0 的笔画对（第几笔，从 1 数）：" + "  ".join("%d–%d %.1f" % t for t in close))

    if a.drift is not None and "items" in lib:
        lib["drift"] = a.drift
    json.dump(lib, open(a.dst, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    if len(hs) > 1:
        print("点名的字：最小 / 最大 = %.2f（标题要拉到 ≈ 0.45 才看得出大小，0.7 读成「差不多大」）"
              % (min(hs) / max(hs)))
    print("写出", os.path.abspath(a.dst))


if __name__ == "__main__":
    main()
