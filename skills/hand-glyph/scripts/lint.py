"""按检查清单自动查：字库查骨架规格，交付物查输出合同。

    python3 handdraw.py lint my-font.json                   # 查字库
    python3 handdraw.py lint my-font.json --text "白日依山尽" # 顺带查缺字
    python3 handdraw.py lint --svg title.svg                # 查交付物
    python3 handdraw.py lint my-font.json --svg title.svg   # 两样一起

✗ 是错误（退出码 1），⚠ 是提醒。查不了的还得人看：会不会读成别的字、笔顺对不对。
"""
import argparse
import io
import re
import xml.etree.ElementTree as ET

import handdraw as H
import row as rowmod
from flatten import path_to_polys

HAN_AMP = 0.65
W_RANGE = (0.85, 1.15)
FACE = (7, 57)          # 汉字字面范围，允许出 2 个单位
FACE_SLACK = 2
MIN_FACE = 40           # 字面最长边低于它 = 没撑住格子
SIDE = (1.0, 4.5)       # 拉丁左右边距，目标 2.5
STROKE_MIN_PX = 1.6
HAN_MIN_PX = 44


class Report:
    def __init__(self):
        self.errors = 0
        self.warns = 0

    def err(self, where, msg):
        self.errors += 1
        print("  ✗ %s：%s" % (where, msg))

    def warn(self, where, msg):
        self.warns += 1
        print("  ⚠ %s：%s" % (where, msg))


def bbox(els):
    xs, ys = [], []
    for el in els:
        if el.get("t", "path") != "path":
            continue
        for pts, _ in path_to_polys(el["d"]):
            xs += [p[0] for p in pts]
            ys += [p[1] for p in pts]
    return (min(xs), min(ys), max(xs), max(ys)) if xs else None


def lint_library(path, text, r):
    g = H.load_raw(path)
    vb, sw = float(g["vb"]), float(g["sw"])
    print("字库 %s（%s，%d 个字形，sw %g）" % (path, "拉丁" if H.layout_mode(g) == "latin" else "汉字",
                                          len(g["items"]), sw))
    for name, els in g["items"].items():
        latin = bool(els) and "adv" in els[0]
        where = "「%s」" % name
        if not els:
            r.err(where, "空字形")
            continue
        for i, el in enumerate(els, 1):
            d = el.get("d", "")
            w = float(el.get("w", 1.0))
            if not W_RANGE[0] <= w <= W_RANGE[1]:
                r.err(where, "第 %d 笔 w=%g，超出 %g–%g" % (i, w, *W_RANGE))
            if sw * w * HAN_MIN_PX / vb < STROKE_MIN_PX and not latin:
                r.warn(where, "第 %d 笔在 44px 上只有 %.2fpx 粗" % (i, sw * w * HAN_MIN_PX / vb))
            if latin:
                continue
            if el.get("amp") != HAN_AMP:
                r.err(where, "第 %d 笔 amp=%s，汉字每一笔都要写 0.65" % (i, el.get("amp", "（没写）")))
            if re.search(r"[Zz]", d):
                r.warn(where, "第 %d 笔带 Z 闭合 —— 汉字几乎没有闭合的一笔，多半是把几笔连成了一条" % i)
        box = bbox(els)
        if not box:
            continue
        x0, y0, x1, y1 = box
        if latin:
            adv = float(els[0]["adv"])
            left, right = x0, adv - x1
            if not SIDE[0] <= left <= SIDE[1] or not SIDE[0] <= right <= SIDE[1]:
                r.warn(where, "左右边距 %.1f / %.1f，目标各 2.5（adv = 字面宽 + 5）" % (left, right))
        else:
            lo, hi = FACE[0] - FACE_SLACK, FACE[1] + FACE_SLACK
            if x0 < lo or y0 < lo or x1 > hi or y1 > hi:
                r.warn(where, "字面 %.0f–%.0f × %.0f–%.0f 出了 7–57" % (x0, x1, y0, y1))
            if max(x1 - x0, y1 - y0) < MIN_FACE:
                r.warn(where, "字面最长边只有 %.0f，没撑住格子" % max(x1 - x0, y1 - y0))
    if H.layout_mode(g) == "latin" and any(els and "adv" not in els[0] for els in g["items"].values()):
        r.err("字库", "拉丁字库里有字形没写 adv（写在第一笔上）")
    if text:
        have = {rowmod.base_name(n) for n in g["items"]}
        miss = sorted({ch for ch in text if ch not in "/\n " and ch not in have})
        if miss:
            r.err("文案", "缺字 %s" % " ".join(miss))


FORBIDDEN = {"rect": "背景或装饰矩形", "image": "位图", "linearGradient": "渐变", "radialGradient": "渐变",
             "filter": "滤镜/阴影", "pattern": "纹理", "text": "文字（字形应该是路径）",
             "circle": "装饰图形", "ellipse": "装饰图形", "polygon": "装饰图形"}
PAINT_OK = {None, "none", "currentColor"}


def lint_svg(path, r):
    print("交付物 %s" % path)
    root = ET.parse(path).getroot()
    tag = lambda el: el.tag.split("}")[-1]
    parent = {c: p for p in root.iter() for c in p}
    if root.get("color") or "color" in (root.get("style") or ""):
        r.err("根节点", "写死了 color —— 颜色应该跟着页面走（currentColor）")
    for el in root.iter():
        t = tag(el)
        if t in FORBIDDEN:
            r.err("<%s>" % t, "交付物里不该有%s；自检背景只放在预览里" % FORBIDDEN[t])
        for attr in ("stroke", "fill"):
            if el.get(attr) not in PAINT_OK:
                r.err("<%s %s>" % (t, attr), "%s=\"%s\"，只能是 none 或 currentColor" % (attr, el.get(attr)))
        style = el.get("style") or ""
        if re.search(r"(fill|stroke|color|background)\s*:", style):
            r.err("<%s style>" % t, "style 里写了颜色或背景：%s" % style)
        if el.get("filter") or el.get("opacity") not in (None, "1"):
            r.warn("<%s>" % t, "带了 filter / opacity，交付物默认不要")
        if t == "path" and el.get("fill") != "currentColor":
            node, found = el, None
            while node is not None and found is None:
                found = node.get("stroke-width")
                node = parent.get(node)
            if found is None:
                r.err("<path>", "没有继承到 stroke-width，会掉回 SVG 默认的 1（合成时剥外壳丢了？）")
                break
    if tag(root) == "svg" and root.find(".//{http://www.w3.org/2000/svg}style") is not None:
        r.warn("<style>", "交付物带了样式表，确认里面没有颜色和背景")


def main(argv):
    ap = argparse.ArgumentParser(prog="handdraw.py lint", description="按检查清单自动查字库和交付物")
    ap.add_argument("geo", nargs="?")
    ap.add_argument("--text", help="顺带查这句话缺不缺字")
    ap.add_argument("--svg", help="查交付物 SVG 是否符合输出合同")
    a = ap.parse_args(argv)
    if not a.geo and not a.svg:
        ap.error("给一个字库 JSON，或者 --svg 一张交付物")
    r = Report()
    if a.geo:
        lint_library(a.geo, a.text, r)
    if a.svg:
        lint_svg(a.svg, r)
    print("%s：%d 个错误，%d 个提醒。读不读成别的字、笔顺对不对，还得人看。"
          % ("有问题" if r.errors else "通过", r.errors, r.warns))
    return 1 if r.errors else 0
