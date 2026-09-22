"""d 串 <-> 可编辑节点表。编辑器拖的是骨架点，存回去的还得是 d 串。

命令字母本身带信息：横就该写 H、折角半径就该写 Q、真 90° 就该写 A。
所以解析之后要能**原样**写回去，而不是一律摊平成 L —— 摊平了几何就没法读了，
下一个人也看不出哪个折角是有半径的。

只有被拖过的那条 path 才重新序列化，没动过的保持原字符串不变，diff 才干净。
（改动一枚字的一笔，不该让另外三笔的坐标也跟着变格式。）

段的形状：
    {"c":"M","p":[[x,y]]}
    {"c":"L"/"H"/"V","p":[[x,y]]}          # H/V 也存完整坐标，写回时再判断还成不成立
    {"c":"Q","p":[[cx,cy],[x,y]]}
    {"c":"C","p":[[c1x,c1y],[c2x,c2y],[x,y]]}
    {"c":"A","p":[[x,y]],"a":[rx,ry,rot,large,sweep]}
    {"c":"Z","p":[]}

一律绝对坐标。S/T 在解析时展开成 C/Q —— 拖一个「反射出来的控制点」没法理解，
而字库里本来也没用过这两个命令。
"""
import re

TOK = re.compile(r'([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)')


def parse(d):
    toks = [(a or b) for a, b in TOK.findall(d)]
    i = 0
    cur = (0.0, 0.0)
    start = (0.0, 0.0)
    segs = []
    cmd = None
    prev_c2 = prev_q = None

    def num():
        nonlocal i
        v = float(toks[i]); i += 1
        return v

    while i < len(toks):
        if re.match(r'[A-Za-z]', toks[i]):
            cmd = toks[i]; i += 1
        rel = cmd.islower()
        C = cmd.upper()
        ox, oy = cur if rel else (0.0, 0.0)
        if C == 'M':
            cur = start = (num() + ox, num() + oy)
            segs.append({"c": "M", "p": [list(cur)]})
            cmd = 'l' if rel else 'L'
            prev_c2 = prev_q = None
        elif C == 'L':
            cur = (num() + ox, num() + oy)
            segs.append({"c": "L", "p": [list(cur)]}); prev_c2 = prev_q = None
        elif C == 'H':
            cur = (num() + ox, cur[1])
            segs.append({"c": "H", "p": [list(cur)]}); prev_c2 = prev_q = None
        elif C == 'V':
            cur = (cur[0], num() + oy)
            segs.append({"c": "V", "p": [list(cur)]}); prev_c2 = prev_q = None
        elif C in 'CS':
            if C == 'C':
                c1 = (num() + ox, num() + oy)
            else:
                c1 = (2 * cur[0] - prev_c2[0], 2 * cur[1] - prev_c2[1]) if prev_c2 else cur
            c2 = (num() + ox, num() + oy)
            e = (num() + ox, num() + oy)
            segs.append({"c": "C", "p": [list(c1), list(c2), list(e)]})
            prev_c2 = c2; prev_q = None; cur = e
        elif C in 'QT':
            if C == 'Q':
                q = (num() + ox, num() + oy)
            else:
                q = (2 * cur[0] - prev_q[0], 2 * cur[1] - prev_q[1]) if prev_q else cur
            e = (num() + ox, num() + oy)
            segs.append({"c": "Q", "p": [list(q), list(e)]})
            prev_q = q; prev_c2 = None; cur = e
        elif C == 'A':
            rx, ry, rot = num(), num(), num()
            large, sweep = int(num()), int(num())
            e = (num() + ox, num() + oy)
            segs.append({"c": "A", "p": [list(e)], "a": [rx, ry, rot, large, sweep]})
            cur = e; prev_c2 = prev_q = None
        elif C == 'Z':
            segs.append({"c": "Z", "p": []})
            cur = start; prev_c2 = prev_q = None
    return segs


def _n(v, prec=2):
    s = f"{round(float(v), prec):.{prec}f}".rstrip("0").rstrip(".")
    return "0" if s in ("", "-0") else s


def serialize(segs, prec=2):
    """节点表 -> d 串。H/V 拖成不再水平/垂直的时候自动降级成 L。"""
    out = []
    cur = None
    for s in segs:
        c, p = s["c"], s["p"]
        if c == "Z":
            out.append("Z"); continue
        e = p[-1]
        if c == "H" and cur and abs(e[1] - cur[1]) > 10 ** -prec:
            c = "L"
        if c == "V" and cur and abs(e[0] - cur[0]) > 10 ** -prec:
            c = "L"
        if c == "M":
            out.append(f"M{_n(e[0],prec)} {_n(e[1],prec)}")
        elif c == "H":
            out.append(f"H{_n(e[0],prec)}")
        elif c == "V":
            out.append(f"V{_n(e[1],prec)}")
        elif c == "L":
            out.append(f"L{_n(e[0],prec)} {_n(e[1],prec)}")
        elif c == "Q":
            out.append(f"Q{_n(p[0][0],prec)} {_n(p[0][1],prec)} {_n(e[0],prec)} {_n(e[1],prec)}")
        elif c == "C":
            out.append(f"C{_n(p[0][0],prec)} {_n(p[0][1],prec)} "
                       f"{_n(p[1][0],prec)} {_n(p[1][1],prec)} {_n(e[0],prec)} {_n(e[1],prec)}")
        elif c == "A":
            rx, ry, rot, lg, sw = s["a"]
            out.append(f"A{_n(rx,prec)} {_n(ry,prec)} {_n(rot,prec)} {int(lg)} {int(sw)} "
                       f"{_n(e[0],prec)} {_n(e[1],prec)}")
        cur = e
    return " ".join(out)


def translate(segs, dx, dy):
    """整条笔画平移。H/V/A 全都还成立 —— 平移不改变水平/垂直，也不改弧的半径。"""
    for s in segs:
        for pt in s["p"]:
            pt[0] += dx; pt[1] += dy
    return segs
