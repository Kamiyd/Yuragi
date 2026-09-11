"""手绘感线条生成器：这是「同一支笔」的物理载体。

**这份文件在 hand-drawn 和 hand-glyph 两个 skill 里必须逐字节相同。**
两边的手感一致就靠它 —— 改了一边不改另一边，图标和字就不再是同一只手了。
校验：`md5 <两处路径>`，哈希不一样就是漂了。

做法：图形先按「骨架折线」定义，再统一过一遍手抖滤镜 ——
沿法线叠低频正弦噪声（手画的线不直）、两头各探出一点点（收笔越位）、
用 Catmull-Rom 转成平滑贝塞尔。转角处把点重复一次来收紧切线，
不然所有折角都会被磨圆成一坨。
"""
import math

def _cr(pts, closed=False):
    p = list(pts)
    if closed: p = p + [p[0]]
    d = [f"M{p[0][0]:.2f} {p[0][1]:.2f}"]
    ext = [p[0]] + p + [p[-1]]
    for i in range(len(p) - 1):
        p0, p1, p2, p3 = ext[i], ext[i+1], ext[i+2], ext[i+3]
        c1 = (p1[0] + (p2[0]-p0[0])/6, p1[1] + (p2[1]-p0[1])/6)
        c2 = (p2[0] - (p3[0]-p1[0])/6, p2[1] - (p3[1]-p1[1])/6)
        d.append(f"C{c1[0]:.2f} {c1[1]:.2f} {c2[0]:.2f} {c2[1]:.2f} {p2[0]:.2f} {p2[1]:.2f}")
    if closed: d.append("Z")
    return "".join(d)

def _resample(pts, step=1.1, sharp=()):
    """按弧长重采样；sharp 里的顶点索引会被保留并重复，转角才立得住"""
    out = []
    for i in range(len(pts) - 1):
        a, b = pts[i], pts[i+1]
        L = math.hypot(b[0]-a[0], b[1]-a[1])
        n = max(1, int(round(L / step)))
        for k in range(n):
            t = k / n
            out.append((a[0] + (b[0]-a[0])*t, a[1] + (b[1]-a[1])*t, i in sharp and k == 0))
    out.append((pts[-1][0], pts[-1][1], (len(pts)-1) in sharp))
    return out

def hand(pts, seed=0, amp=0.34, closed=False, sharp=(), over=0.55, step=1.1):
    """骨架折线 -> 手绘路径"""
    s = _resample(list(pts) + ([pts[0]] if closed else []), step, sharp)
    ph = [(seed*1.7 + k*2.399) % (2*math.pi) for k in range(3)]
    n = len(s)
    res = []
    for i, (x, y, is_sharp) in enumerate(s):
        u = i / max(1, n-1)
        # 法线方向
        j = min(i+1, n-1); k = max(i-1, 0)
        dx, dy = s[j][0]-s[k][0], s[j][1]-s[k][1]
        L = math.hypot(dx, dy) or 1
        nx, ny = -dy/L, dx/L
        w = (amp*0.62*math.sin(2*math.pi*1.3*u + ph[0])
             + amp*0.42*math.sin(2*math.pi*2.7*u + ph[1])
             + amp*0.22*math.sin(2*math.pi*4.1*u + ph[2]))
        if is_sharp: w *= 0.25          # 转角上别抖，抖了就散了
        res.append((x + nx*w, y + ny*w))
    if not closed and over:
        # 两头各探出去一点：手画收不住笔
        def push(a, b, d):
            L = math.hypot(b[0]-a[0], b[1]-a[1]) or 1
            return (a[0] - (b[0]-a[0])/L*d, a[1] - (b[1]-a[1])/L*d)
        res = [push(res[0], res[1], over*0.6)] + res + [push(res[-1], res[-2], over)]
    # 重复的转角点会让 Catmull-Rom 的切线收紧
    final = []
    for i, p in enumerate(res):
        final.append(p)
        idx = i - (1 if (not closed and over) else 0)
        if 0 <= idx < len(s) and s[idx][2]: final.append(p)
    return _cr(final, closed)

def ellipse(cx, cy, rx, ry, seed=0, amp=0.30, start=-70, sweep=372, tilt=0, n=34, tail=0.0):
    """手画的圈：半径一路呼吸，可以让收笔越过起笔再甩进圈里"""
    t = math.radians(tilt); ct, st = math.cos(t), math.sin(t)
    ph = [(seed*2.1 + k*1.913) % (2*math.pi) for k in range(3)]
    pts = []
    for i in range(n+1):
        u = i/n
        a = math.radians(start + sweep*u)
        m = 1 + (amp*0.030*math.sin(a+ph[0]) + amp*0.021*math.sin(2*a+ph[1])
                 + amp*0.012*math.sin(3*a+ph[2])) / 0.30 * 1.0
        if tail and u > 1-tail:
            m *= 1 - 0.20*((u-(1-tail))/tail)**1.6
        x, y = rx*m*math.cos(a), ry*m*math.sin(a)
        pts.append((cx + x*ct - y*st, cy + x*st + y*ct))
    return _cr(pts)

def line(p0, p1, seed=0, bow=0.35, amp=0.28, over=0.55):
    """两点之间的一笔：中段带弓，两头越位"""
    dx, dy = p1[0]-p0[0], p1[1]-p0[1]
    L = math.hypot(dx, dy) or 1
    nx, ny = -dy/L, dx/L
    pts = [(p0[0]+dx*u + nx*bow*math.sin(math.pi*u), p0[1]+dy*u + ny*bow*math.sin(math.pi*u))
           for u in [i/8 for i in range(9)]]
    return hand(pts, seed=seed, amp=amp, over=over, step=1.2)
