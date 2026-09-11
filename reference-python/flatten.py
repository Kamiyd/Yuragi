"""把 SVG 的 path / rect / circle / ellipse 摊成折线，好交给手抖滤镜。"""
import math, re

def _arc(x0, y0, rx, ry, rot, large, sweep, x, y, n=18):
    if rx == 0 or ry == 0: return [(x, y)]
    phi = math.radians(rot)
    dx2, dy2 = (x0-x)/2, (y0-y)/2
    x1 =  math.cos(phi)*dx2 + math.sin(phi)*dy2
    y1 = -math.sin(phi)*dx2 + math.cos(phi)*dy2
    rx, ry = abs(rx), abs(ry)
    lam = x1*x1/(rx*rx) + y1*y1/(ry*ry)
    if lam > 1: rx *= math.sqrt(lam); ry *= math.sqrt(lam)
    num = rx*rx*ry*ry - rx*rx*y1*y1 - ry*ry*x1*x1
    den = rx*rx*y1*y1 + ry*ry*x1*x1
    c = math.sqrt(max(0.0, num/den)) * (-1 if large == sweep else 1)
    cx1, cy1 = c*rx*y1/ry, -c*ry*x1/rx
    cx = math.cos(phi)*cx1 - math.sin(phi)*cy1 + (x0+x)/2
    cy = math.sin(phi)*cx1 + math.cos(phi)*cy1 + (y0+y)/2
    ang = lambda ux, uy: math.atan2(uy, ux)
    t1 = ang((x1-cx1)/rx, (y1-cy1)/ry)
    t2 = ang((-x1-cx1)/rx, (-y1-cy1)/ry)
    dt = t2 - t1
    if not sweep and dt > 0: dt -= 2*math.pi
    if sweep and dt < 0: dt += 2*math.pi
    out = []
    for i in range(1, n+1):
        t = t1 + dt*i/n
        ex, ey = rx*math.cos(t), ry*math.sin(t)
        out.append((math.cos(phi)*ex - math.sin(phi)*ey + cx,
                    math.sin(phi)*ex + math.cos(phi)*ey + cy))
    return out

def _bez(p, n):
    """p = 控制点列表（3 或 4 个），返回采样点（不含起点）"""
    out = []
    for i in range(1, n+1):
        t = i/n; q = list(p)
        while len(q) > 1:
            q = [((1-t)*a[0]+t*b[0], (1-t)*a[1]+t*b[1]) for a, b in zip(q, q[1:])]
        out.append(q[0])
    return out

TOK = re.compile(r'([MmLlHhVvCcSsQqTtAaZz])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)')

def path_to_polys(d, curve_n=12):
    toks = [(a or b) for a, b in TOK.findall(d)]
    i = 0; cur = (0.0, 0.0); start = (0.0, 0.0)
    polys = []; poly = []; cmd = None; prev_c2 = None; prev_q = None
    def num():
        nonlocal i
        v = float(toks[i]); i += 1; return v
    while i < len(toks):
        t = toks[i]
        if re.match(r'[A-Za-z]', t): cmd = t; i += 1
        rel = cmd.islower(); C = cmd.upper()
        ox, oy = cur if rel else (0.0, 0.0)
        if C == 'M':
            if len(poly) > 1: polys.append((poly, False))
            x, y = num()+ox, num()+oy
            cur = start = (x, y); poly = [cur]; cmd = 'l' if rel else 'L'
            prev_c2 = prev_q = None
        elif C == 'L':
            cur = (num()+ox, num()+oy); poly.append(cur); prev_c2 = prev_q = None
        elif C == 'H':
            cur = (num()+ox, cur[1]); poly.append(cur); prev_c2 = prev_q = None
        elif C == 'V':
            cur = (cur[0], num()+oy); poly.append(cur); prev_c2 = prev_q = None
        elif C in 'CS':
            if C == 'C': c1 = (num()+ox, num()+oy)
            else: c1 = (2*cur[0]-prev_c2[0], 2*cur[1]-prev_c2[1]) if prev_c2 else cur
            c2 = (num()+ox, num()+oy); e = (num()+ox, num()+oy)
            poly += _bez([cur, c1, c2, e], curve_n); prev_c2 = c2; prev_q = None; cur = e
        elif C in 'QT':
            if C == 'Q': q = (num()+ox, num()+oy)
            else: q = (2*cur[0]-prev_q[0], 2*cur[1]-prev_q[1]) if prev_q else cur
            e = (num()+ox, num()+oy)
            poly += _bez([cur, q, e], max(6, curve_n//2)); prev_q = q; prev_c2 = None; cur = e
        elif C == 'A':
            rx, ry, rot = num(), num(), num()
            large, sweep = int(num()), int(num())
            e = (num()+ox, num()+oy)
            poly += _arc(cur[0], cur[1], rx, ry, rot, large, sweep, e[0], e[1])
            cur = e; prev_c2 = prev_q = None
        elif C == 'Z':
            if len(poly) > 1: polys.append((poly, True))
            poly = [start]; cur = start; prev_c2 = prev_q = None
    if len(poly) > 1: polys.append((poly, False))
    return polys

def rect_to_poly(x, y, w, h, rx=0.0, n=8):
    r = min(rx, w/2, h/2)
    if r <= 0:
        return [((x,y),(x+w,y),(x+w,y+h),(x,y+h)), True]
    p = []
    for cx, cy, a0 in ((x+w-r, y+r, -90), (x+w-r, y+h-r, 0), (x+r, y+h-r, 90), (x+r, y+r, 180)):
        for k in range(n+1):
            a = math.radians(a0 + 90*k/n)
            p.append((cx + r*math.cos(a), cy + r*math.sin(a)))
    return [p, True]

def circle_to_poly(cx, cy, r, n=40, ry=None):
    ry = r if ry is None else ry
    return [[(cx + r*math.cos(2*math.pi*i/n), cy + ry*math.sin(2*math.pi*i/n)) for i in range(n)], True]

def corners(poly, closed, deg=32):
    """折线上转得急的顶点 —— 手抖滤镜要在这些点上收着，不然折角磨没了"""
    out = set(); n = len(poly)
    for i in range(n):
        if not closed and (i == 0 or i == n-1): continue
        a, b, c = poly[(i-1) % n], poly[i], poly[(i+1) % n]
        v1 = (b[0]-a[0], b[1]-a[1]); v2 = (c[0]-b[0], c[1]-b[1])
        l1 = math.hypot(*v1) or 1; l2 = math.hypot(*v2) or 1
        cosang = max(-1, min(1, (v1[0]*v2[0]+v1[1]*v2[1])/(l1*l2)))
        if math.degrees(math.acos(cosang)) > deg: out.add(i)
    return out

def dedupe(poly, eps=0.06):
    out = [poly[0]]
    for p in poly[1:]:
        if math.hypot(p[0]-out[-1][0], p[1]-out[-1][1]) > eps: out.append(p)
    return out
