"""中英合成：一行中文 + 一行英文 -> 一张透明 SVG。

    python3 handdraw.py compose --han han.json "海上生明月" --latin latin.json "One moon, one moment." -o out.svg
    python3 handdraw.py compose ... --main latin            # 英文做主标题、中文做副标题
    python3 handdraw.py compose ... --preview preview.html  # 另出一张亮暗底的自检预览

两行各自用 write 排（字距、词距、逐字大小都是引擎给的，这里一个不动），再合成：

- 主标题按 --width 的 --main-ratio 定宽，副标题按主标题字面宽的 --sub-ratio 定宽，
  但副标题的行高封顶在主标题的 0.75，短句不会被放得比主标题还大。
- 副标题太长、被缩到主标题一半以下时，线宽补偿会超过 2 倍，笔画发腻。默认自动平衡：
  副标题最宽放到画布的 88%，主标题跟着收窄，两行缩放倍率差不超过 2 倍（--no-balance 关掉）。
- 按**字面框**居中，不按 viewBox；上下留白相等。
- 两行缩放倍率不同，同一个 sw 落到画布上不一样粗。副标题在内存里换一份线宽重排，
  让两行画布上的线宽相等 —— 字库文件不改，基础线宽（汉字 2.8 / 拉丁 3.4）照旧。
- 交付物透明、stroke="currentColor"、根节点不写 color：颜色跟着用它的页面走。
  亮暗底只出现在 --preview 里，那是自检，不是交付物。
"""
import argparse
import io
import os
import random
import re

import handdraw as H
import row as rowmod

PAD = 5.0          # write_lines 在字面框外留的边
HAN_MIN_PX = 44    # 汉字格子的显示下限
LATIN_MIN_PX = 28  # 拉丁一行的显示下限
STROKE_MIN_PX = 1.6
MIN_K_RATIO = 0.5    # 副标题缩放不低于主标题的一半，线宽补偿就不超过约 2 倍
SUB_MAX_WIDTH = 0.88 # 自动平衡时副标题最宽占画布的比例


def line(g, text, seed):
    """排一行（或用 / 断开的几行），返回字面框尺寸和去掉外壳的内容。

    write_lines 把线宽写在内层 <g stroke-width> 上，剥掉外壳不会丢；
    外壳上的 fill / stroke / linecap 由合成后的根节点统一给。
    """
    svg, _ = H.write_lines(g, text, seed)
    w, h = map(float, re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg).groups())
    body = re.sub(r"^<svg[^>]*>|</svg>$", "", svg)
    return {"w": w - 2 * PAD, "h": h - 2 * PAD, "body": body}


def mean_w(g, text):
    """这一行实际用到的字的平均提按 w —— 线宽补偿按画布上的真实平均粗细算。"""
    ws = []
    for ch in text:
        for name, els in g["items"].items():
            if rowmod.base_name(name) == ch:
                ws += [float(e.get("w", 1.0)) for e in els]
                break
    return sum(ws) / len(ws) if ws else 1.0


def missing(g, text):
    have = {rowmod.base_name(n) for n in g["items"]}
    return sorted({ch for ch in text if ch not in "/\n " and ch not in have})


def main(argv):
    ap = argparse.ArgumentParser(prog="handdraw.py compose", description="中文一行 + 英文一行合成透明 SVG")
    ap.add_argument("--han", nargs=2, metavar=("GEO", "TEXT"), help="中文字库和文案")
    ap.add_argument("--latin", nargs=2, metavar=("GEO", "TEXT"), help="拉丁字库和文案")
    ap.add_argument("--main", choices=["han", "latin"], default="han", help="哪一行做主标题（放上面），默认中文")
    ap.add_argument("--width", type=float, default=1200, help="画布宽，px")
    ap.add_argument("--main-ratio", type=float, default=0.7, help="主标题字面宽占画布宽的比例")
    ap.add_argument("--sub-ratio", type=float, default=1.0, help="副标题字面宽 / 主标题字面宽")
    ap.add_argument("--gap", type=float, help="两行字面之间的距离，px；默认主标题行高的 0.35")
    ap.add_argument("--no-balance", action="store_true", help="不自动平衡两行的缩放倍率")
    ap.add_argument("-s", "--seed", type=int, help="种子；不给就随机，跑完会打印")
    ap.add_argument("--preview", help="另出一张亮暗底的自检预览 HTML")
    ap.add_argument("-o", "--out", default="compose.svg")
    a = ap.parse_args(argv)

    if not a.han and not a.latin:
        ap.error("至少给 --han 或 --latin 其中一行")
    seed = a.seed if a.seed is not None else random.randrange(1, 10 ** 6)

    rows = {}
    for kind, spec in (("han", a.han), ("latin", a.latin)):
        if not spec:
            continue
        g = H.load_raw(spec[0])
        if H.layout_mode(g) != kind:
            print("提醒：%s 看起来是%s字库，却放在 --%s 上" % (spec[0], "拉丁" if kind == "han" else "汉字", kind))
        miss = missing(g, spec[1])
        if miss:
            print("字库 %s 里没有：%s —— 先画好再合成。" % (spec[0], " ".join(miss)))
            return 1
        rows[kind] = {"g": g, "text": spec[1], **line(g, spec[1], seed)}

    order = [a.main] + [k for k in ("han", "latin") if k != a.main and k in rows]
    order = [k for k in order if k in rows]
    main_row = rows[order[0]]
    main_row["k"] = a.width * a.main_ratio / main_row["w"]
    if len(order) == 2:
        sub = rows[order[1]]
        k_by_width = main_row["w"] * main_row["k"] * a.sub_ratio / sub["w"]
        k_by_height = 0.75 * main_row["h"] * main_row["k"] / sub["h"]
        sub["k"] = min(k_by_width, k_by_height)
        if not a.no_balance and sub["k"] < MIN_K_RATIO * main_row["k"]:
            sub["k"] = min(a.width * SUB_MAX_WIDTH / sub["w"], k_by_height, MIN_K_RATIO * main_row["k"])
            main_row["k"] = min(main_row["k"], sub["k"] / MIN_K_RATIO)
            print("自动平衡：副标题放宽到 %.0f%% 画布宽，主标题收到 %.0f%%，两行线宽补偿不超过 2 倍。"
                  % (100 * sub["w"] * sub["k"] / a.width, 100 * main_row["w"] * main_row["k"] / a.width))
        # 线宽补偿：让副标题画布上的线宽 = 主标题画布上的线宽
        target = main_row["g"]["sw"] * mean_w(main_row["g"], main_row["text"]) * main_row["k"]
        sw = target / (mean_w(sub["g"], sub["text"]) * sub["k"])
        ratio = sw / sub["g"]["sw"]
        if abs(ratio - 1) > 1e-9:
            sub.update(line(dict(sub["g"], sw=sw), sub["text"], seed))
        sub["sw_used"] = sw
        if ratio > 2:
            print("提醒：副标题被缩到主标题的 %.0f%%，线宽补偿到 %.1f 倍，笔画会显得偏重。"
                  "考虑缩短副标题，或调大 --sub-ratio。" % (100 * sub["k"] / main_row["k"], ratio))

    gap = a.gap if a.gap is not None else 0.35 * main_row["h"] * main_row["k"]
    block = sum(rows[k]["h"] * rows[k]["k"] for k in order) + gap * (len(order) - 1)
    margin = max(24.0, 0.18 * block)
    W, Hh = a.width, block + 2 * margin

    parts, y = [], margin
    for k in order:
        r = rows[k]
        x = (W - r["w"] * r["k"]) / 2
        # 内容坐标里字面框从 (PAD, PAD) 开始
        parts.append('<g transform="translate(%.2f %.2f) scale(%.4f) translate(%g %g)">%s</g>'
                     % (x, y, r["k"], -PAD, -PAD, r["body"]))
        y += r["h"] * r["k"] + gap

    svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="%g" height="%.0f" viewBox="0 0 %g %.2f" '
           'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">%s</svg>\n'
           % (W, Hh, W, Hh, "".join(parts)))
    io.open(a.out, "w", encoding="utf-8").write(svg)
    print("写出", os.path.abspath(a.out))
    print("  种子 %d（-s %d 钉住这一版）。透明、currentColor，这就是交付物。" % (seed, seed))

    # 尺寸自检：按 SVG 的原始尺寸算；页面上再缩小，门槛跟着等比变
    for k in order:
        r = rows[k]
        if k == "han":
            px = r["g"]["vb"] * r["k"]
            if px < HAN_MIN_PX:
                print("  ✗ 中文一格只有 %.0fpx，低于 %dpx 的下限。加大 --width 或缩短文案。" % (px, HAN_MIN_PX))
            else:
                print("  中文一格 %.0fpx；这张图显示宽度别小于 %.0fpx。" % (px, W * HAN_MIN_PX / px))
        else:
            px = r["h"] * r["k"]
            if px < LATIN_MIN_PX:
                print("  ✗ 英文一行只有 %.0fpx 高，低于 %dpx 的下限。" % (px, LATIN_MIN_PX))
        stroke = r.get("sw_used", r["g"]["sw"]) * r["k"]
        if stroke < STROKE_MIN_PX:
            print("  ✗ %s画布上的线宽只有 %.1fpx，低于 %.1fpx。" % ("中文" if k == "han" else "英文", stroke, STROKE_MIN_PX))

    if a.preview:
        preview(svg, a.preview)
    return 0


def preview(svg, out):
    """亮暗底各放一张 —— 自检用，文件名和标题都写明是预览。"""
    html = f"""<!doctype html><meta charset="utf-8"><title>预览（不是交付物）</title>
<style>body{{margin:0;font:12px -apple-system,"PingFang SC",sans-serif}}
section{{padding:28px}}p{{margin:0 0 12px;opacity:.6}}svg{{max-width:100%;height:auto}}
.light{{background:#fff;color:#09090B}}.dark{{background:#141414;color:#EDEDEA}}</style>
<section class="light"><p>预览 · 亮底（交付物本身是透明的）</p>{svg}</section>
<section class="dark"><p>预览 · 暗底（同一个文件，颜色来自 currentColor）</p>{svg}</section>"""
    io.open(out, "w", encoding="utf-8").write(html)
    print("预览", os.path.abspath(out))
