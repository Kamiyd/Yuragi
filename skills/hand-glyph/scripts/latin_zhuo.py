"""英文字库：规整骨架 → 拙趣版（中拙）。

    python3 handdraw.py latin-zhuo latin.json -o latin-zhuo.json
    python3 handdraw.py latin-zhuo latin.json -o out.json --amount 0.6 --drift 1.5

英文字母**先照规整的写法画**（四条参考线、正圆、`adv = 字面宽 + 5`，见
reference/glyphs.md「拉丁小写」），再用这个脚本整体变拙，不要在骨架里手工画歪：
手画的「拙」十个字母十个样，这里是同一只手、同一个量。

每个字母做三件事，量都由字母本身决定（同一个字母每次跑结果一样）：

  1. 整体变形：x 高 ±30%、歪 2–4°（左右都有）；宽度每个字母都随机放宽或收窄（-20%–+18%），
     圆头字母（o e a c d g p q s b u）多收一些（收窄 0–24%）
  2. 曲线的控制点各挪 ±1.2 —— 弧线微微不匀、有点笨，**端点不动**，碗接竖照样接得准
  3. 重新按字面量左边距 2.5 和 `adv`

再把表头的 `drift`（错落）写成 2：字母的基线上下浮、字母间的空忽近忽远；
`jit`（逐字大小起伏）写成 1.3：上面的变形按字母定，同一个字母每次都一样，
排版层的起伏让它每次出现再大一点或小一点（0.9 时约 ±8%，1.3 约 ±12%）。
试过的几档：只做变形（不挪控制点）太规整；把圆写成不规整折线（「全拙」）又太拙、方方的。
"""
import argparse
import io
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import dpath
from flatten import path_to_polys
from row import rnd

BASE = 48.0            # 基线：变形绕基线做，字母底边不离线
HEIGHT = 0.30          # x 高最多差这么多。±14% / ±22% 排出来还是差不多高；±38% 小写 s 跟大写 S 一样高，读错
TILT = (2.0, 4.0)      # 歪斜角度范围（度）
NARROW_ROUND = (0.00, 0.24)   # 圆头字母收窄
WIDTH_OTHER = (-0.20, 0.18)   # 其它字母：宽度倍率 1 + 这个区间（有的窄、有的宽）
WOBBLE = 1.2           # 曲线控制点挪动幅度（64 网格）
ROUND = set("oeacdgpqsbuOCGQ")
SKIP = set(".,!?:;'\"-")        # 标点不变形


def zhuo_letter(ch, els, amount=1.0):
    """一个字母 -> 拙趣版（原地改 els，返回 els）。"""
    if ch in SKIP or not els:
        return els
    key = ord(ch[0])
    sy = 1 + (rnd(key, 1) * 2 - 1) * HEIGHT * amount
    if ch[0] in ROUND:
        sx = 1 - (NARROW_ROUND[0] + rnd(key, 2) * (NARROW_ROUND[1] - NARROW_ROUND[0])) * amount
    else:
        sx = 1 + (WIDTH_OTHER[0] + rnd(key, 2) * (WIDTH_OTHER[1] - WIDTH_OTHER[0])) * amount
    deg = (TILT[0] + rnd(key, 3) * (TILT[1] - TILT[0])) * amount * (1 if rnd(key, 4) < 0.5 else -1)

    xs = [p[0] for e in els if e.get("t", "path") == "path" for poly, _ in path_to_polys(e["d"]) for p in poly]
    if not xs:
        return els
    cx = (min(xs) + max(xs)) / 2
    t = math.radians(deg)
    ct, st = math.cos(t), math.sin(t)

    def move(q):
        x = (q[0] - cx) * sx
        y = (q[1] - BASE) * sy
        return [cx + x * ct - y * st, BASE + x * st + y * ct]

    for ei, e in enumerate(els):
        if e.get("t", "path") != "path":
            continue
        segs = dpath.parse(e["d"])
        for gi, s in enumerate(segs):
            if s["c"] == "C":
                for k in range(2):               # 只挪控制点，端点不动
                    s["p"][k][0] += (rnd(key, ei, gi, k, 1) * 2 - 1) * WOBBLE * amount
                    s["p"][k][1] += (rnd(key, ei, gi, k, 2) * 2 - 1) * WOBBLE * amount
            s["p"] = [move(q) for q in s["p"]]
        e["d"] = dpath.serialize(segs)

    xs = [p[0] for e in els if e.get("t", "path") == "path" for poly, _ in path_to_polys(e["d"]) for p in poly]
    shift = 2.5 - min(xs)
    for e in els:
        if e.get("t", "path") == "path":
            segs = dpath.parse(e["d"])
            dpath.translate(segs, shift, 0)
            e["d"] = dpath.serialize(segs)
    els[0]["adv"] = round(max(xs) - min(xs) + 5, 1)
    return els


def main(argv):
    ap = argparse.ArgumentParser(prog="handdraw.py latin-zhuo", description="英文字库：规整骨架 → 拙趣版")
    ap.add_argument("geo", help="规整的英文字库（照「拉丁小写」规矩画的）")
    ap.add_argument("-o", "--out", required=True, help="输出的拙趣版字库")
    ap.add_argument("--amount", type=float, default=1.0, help="变拙的量，1 = 标定档；0.5 更收着")
    ap.add_argument("--drift", type=float, default=2.0, help="表头的错落倍率，默认 2")
    ap.add_argument("--jit", type=float, default=1.3, help="表头的逐字大小起伏，默认 1.3")
    a = ap.parse_args(argv)
    if os.path.abspath(a.geo) == os.path.abspath(a.out):
        ap.error("别覆盖原字库：规整版要留着，拙趣版是从它生成的")
    g = json.load(io.open(a.geo, encoding="utf-8"))
    if isinstance(g, dict) and g.get("latinZhuo"):
        ap.error("这份字库已经变拙过了（latinZhuo=%s）：再跑一遍会拙两次。拿规整版来生成。" % g["latinZhuo"])
    items = g.get("items", g)
    for name, els in items.items():
        zhuo_letter(name, els, a.amount)
    if "items" in g:
        g["drift"] = a.drift
        g["jit"] = a.jit
        g["latinZhuo"] = a.amount          # 记一笔：编辑器和这个命令都靠它防止拙两次
    io.open(a.out, "w", encoding="utf-8").write(json.dumps(g, ensure_ascii=False, indent=1) + "\n")
    print("写出", os.path.abspath(a.out), "（%d 个字形，拙 %.2g，错落 %.2g，大小起伏 %.2g）"
          % (len(items), a.amount, a.drift, a.jit))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
