"""种子候选画廊：同一句话排 n 个种子，一页看完再挑。

    python3 handdraw.py write my-font.json "白日依山尽" --candidates 12 -o seeds.html
    python3 handdraw.py write my-font.json "白日依山尽" --candidates 12 -s 100   # 从 100 起连着排

每一版标出种子、逐字大小的最小相邻差、字面尺寸。挑中了就 `write ... -s 种子` 钉住。
"""
import io
import math
import os
import re

import handdraw as H


def sizes(svg):
    """每个字的缩放（sx·sy 开方），按排版顺序。"""
    return [math.sqrt(float(a) * float(b)) for a, b in re.findall(r"scale\(([\d.]+) ([\d.]+)\)", svg)]


def cmd_candidates(g, text, n, start, out):
    cards = []
    for seed in range(start, start + n):
        svg, _ = H.write_lines(g, text, seed)
        s = sizes(svg)
        diffs = [abs(b - a) * 100 for a, b in zip(s, s[1:])]
        low = min(diffs) if diffs else None
        w, h = map(float, re.search(r'viewBox="0 0 ([\d.]+) ([\d.]+)"', svg).groups())
        note = "—" if low is None else ("%.1f%%" % low)
        flag = ' class="thin"' if low is not None and low < 3.5 else ""
        cards.append(f'<figure><div class="art">{svg}</div><figcaption><b>-s {seed}</b>'
                     f'<span{flag}>相邻最小差 {note}</span><span>大小 {min(s):.2f}–{max(s):.2f}</span>'
                     f'<span>{w:.0f}×{h:.0f}</span></figcaption></figure>' if s else "")
    html = f"""<!doctype html><meta charset="utf-8"><title>种子候选：{text}</title>
<style>body{{margin:0;padding:24px;background:#F5F5F4;color:#141414;font:12px/1.5 -apple-system,"PingFang SC",sans-serif}}
h1{{font-size:15px;margin:0 0 4px}}p{{margin:0 0 16px;color:#8a8a85}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}}
figure{{margin:0;background:#fff;border:1px solid #EDEDEA;border-radius:10px;padding:14px}}
.art svg{{width:100%;height:auto;max-height:120px;color:#09090B}}
figcaption{{display:flex;gap:10px;flex-wrap:wrap;margin-top:8px;color:#8a8a85}}
figcaption b{{color:#141414}}.thin{{color:#B4552B}}</style>
<h1>{text} · {n} 个种子</h1>
<p>挑一版，用 <code>write ... -s 种子</code> 钉住。相邻最小差低于 3.5% 标红：两个字看着一样大。这一页是预览，不是交付物。</p>
<div class="grid">{"".join(cards)}</div>"""
    out = out or "seeds.html"
    io.open(out, "w", encoding="utf-8").write(html)
    print("候选", os.path.abspath(out), "（种子 %d–%d）" % (start, start + n - 1))
    return 0
