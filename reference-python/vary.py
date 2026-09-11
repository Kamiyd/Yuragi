"""骨架层抖动：同一个字，每次写出来都不一样。

`hand.py` 换的是**笔迹**（同一份骨架，线抖得不一样）。这一层换的是**写法** ——
笔画长短、横的高低、撇捺的斜度、重心、钩的挑度，全部重摇。规格不是新定的，
就是 glyphs.md「叠字要换写法，不是换种子」那张表，只是原来要人手工照着改一遍。

    结构（固定）-> vary（每次重摇）-> 硬几何 -> hand.py -> 路径

**不能动的是结构**：笔顺、笔画数、部件的相对位置。动了就是另一个字 ——
「乐」少一截读成「朱」，「业」多一横就不是「业」。所以这一层做的每件事
都是保结构的形变，不是随机扰动。

最要命的一条：**笔画是连着的**。「天」的撇捺挂在下横上，随机拉长下横而撇不动，
字就散架了。所以先把关节找出来：
  - 两笔的端点凑在一起（撇捺在竖的底端交汇）-> 归成一个关节，一起动
  - 一笔的端点落在另一笔的中段上（「牙」的撇从顶横起笔）-> 记下它在宿主上的
    参数位置，宿主变形之后重新贴回去
自由端（不连任何东西的那一头）才是能大幅动的地方 —— 笔画长短和斜度都来自它。

**光靠「生成时小心」不够。** 位移大到看得见（2 个单位起步），就一定会有几次
把该分开的两笔挤到一起，或者把该连的拉开 —— 实测 96 次重写里坏了 34 次。
所以结构不变量要**验出来**：逐对笔画比对变形前后的最小间距，
连着的必须还连着、分开的不许挤到一起。不合格就换个盐重摇、幅度降一档，
全都不合格就退回原样 —— 这个字这次不变，比写坏一个字强得多。

（「始」的台两笔缠成一个 6、「都」阝耳旁挨上左半，都是这条守卫在挡的东西。
glyphs.md 里「两笔的终点也要错开 3–5 个单位」说的就是这种间距。）
"""
import math, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import dpath
from flatten import path_to_polys

# 幅度（64 网格；其它网格按 cell/64 等比）。来自 glyphs.md 那张表。
JOINT = 1.8      # 关节位移：整个字的结构松紧
FREE_T = 3.0     # 自由端沿切线：笔画长短
FREE_N = 1.5     # 自由端沿法线：撇捺的斜度
CURVE = 1.2      # 控制点沿法线：弯度 / 钩的挑度
BODY = 2.0       # 整字重心。注意：走 row.py 排版时这一项大半会被「摆正」吃掉
                 # （摆正就是把字面中心拉回格心）—— 那是对的，一行字里的位置
                 # 抖动该由排版层出（可控），不该由骨架层出。单独渲一个字时它才显形。
EPS = 2.0        # 判定「连在一起」的距离


def rnd(*key):
    """跟 row.py 同一套：FNV 每轮后跟一次雪崩混合，不然一串小整数出来是条缓坡。"""
    h = 2166136261
    for k in key:
        h = ((h ^ (int(k) & 0xFFFFFFFF)) * 16777619) & 0xFFFFFFFF
        h ^= h >> 16; h = (h * 0x85EBCA6B) & 0xFFFFFFFF
        h ^= h >> 13; h = (h * 0xC2B2AE35) & 0xFFFFFFFF
        h ^= h >> 16
    return h / 0xFFFFFFFF


def jit(amp, *key):
    return (rnd(*key) * 2 - 1) * amp


def _anchors(segs):
    """[(gi, 点)] —— 每一段的落点，就是骨架上的锚点。"""
    return [(gi, s["p"][-1]) for gi, s in enumerate(segs) if s["p"]]


def _poly(segs):
    d = dpath.serialize(segs)
    ps = path_to_polys(d)
    return ps[0][0] if ps else []


def _at(poly, t):
    """折线上按弧长比例 t 取点。"""
    if len(poly) < 2:
        return poly[0] if poly else (0.0, 0.0)
    seg = [math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1])
           for i in range(len(poly) - 1)]
    L = sum(seg) or 1.0
    want = max(0.0, min(1.0, t)) * L
    acc = 0.0
    for i, s in enumerate(seg):
        if acc + s >= want or i == len(seg) - 1:
            u = (want - acc) / (s or 1.0)
            return (poly[i][0] + (poly[i + 1][0] - poly[i][0]) * u,
                    poly[i][1] + (poly[i + 1][1] - poly[i][1]) * u)
        acc += s
    return poly[-1]


def _param(poly, p):
    """点 p 在折线上的弧长比例，以及它到折线的距离。"""
    if len(poly) < 2:
        return 0.0, 1e9
    best = (1e9, 0.0, 0.0)
    acc = 0.0
    total = 0.0
    segs = []
    for i in range(len(poly) - 1):
        ax, ay = poly[i]; bx, by = poly[i + 1]
        L = math.hypot(bx - ax, by - ay) or 1e-9
        segs.append((ax, ay, bx, by, L)); total += L
    for ax, ay, bx, by, L in segs:
        u = max(0.0, min(1.0, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / (L * L)))
        qx, qy = ax + (bx - ax) * u, ay + (by - ay) * u
        dist = math.hypot(p[0] - qx, p[1] - qy)
        if dist < best[0]:
            best = (dist, acc + L * u, 0)
        acc += L
    return best[1] / (total or 1.0), best[0]


def structure(strokes, eps=EPS):
    """关节表。strokes: [segs]。

    返回 (cluster_of, attach)：
      cluster_of[(si, gi)] = 关节编号（同一个关节上的锚点必须一起动）
      attach = [(si, gi, host_si, t)]  某笔的锚点挂在另一笔的中段上
    """
    anchors = [(si, gi, p) for si, segs in enumerate(strokes) for gi, p in _anchors(segs)]
    parent = {}
    def find(a):
        while parent.get(a, a) != a:
            parent[a] = parent.get(parent[a], parent[a]); a = parent[a]
        return a
    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb
    for k in anchors:
        parent[(k[0], k[1])] = (k[0], k[1])
    for i in range(len(anchors)):
        for j in range(i + 1, len(anchors)):
            si, gi, p = anchors[i]; sj, gj, q = anchors[j]
            if si == sj:
                continue
            if math.hypot(p[0] - q[0], p[1] - q[1]) < eps:
                union((si, gi), (sj, gj))
    groups = {}
    for k in parent:
        groups.setdefault(find(k), []).append(k)
    cluster_of = {}
    cid = 0
    for root, mem in groups.items():
        if len(mem) > 1:                       # 只有真连着的才算关节
            for m in mem:
                cluster_of[m] = cid
            cid += 1

    polys = [_poly(s) for s in strokes]
    attach = []
    for si, gi, p in anchors:
        if (si, gi) in cluster_of:
            continue
        for hj, hp in enumerate(polys):
            if hj == si or len(hp) < 2:
                continue
            t, dist = _param(hp, p)
            if dist < eps and 0.06 < t < 0.94:   # 落在中段，不是两头
                attach.append((si, gi, hj, t))
                break
    return cluster_of, attach


def _sample(poly, n=24):
    """折线抽到 n 个点 —— 逐对求最小间距要的精度到 1–2 个单位就够，全点算太慢。"""
    if len(poly) <= n:
        return poly
    return [poly[round(i * (len(poly) - 1) / (n - 1))] for i in range(n)]


def _gap(a, b):
    """两条折线的最小间距。"""
    m = 1e9
    for p in a:
        for q in b:
            d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2
            if d < m:
                m = d
    return math.sqrt(m)


def gaps(strokes):
    """所有笔画两两之间的间距表 —— 结构不变量就是这张表的定性形态。"""
    sm = [_sample(_poly(s)) for s in strokes]
    out = {}
    for i in range(len(sm)):
        for j in range(i + 1, len(sm)):
            if sm[i] and sm[j]:
                out[(i, j)] = _gap(sm[i], sm[j])
    return out


def intact(before, after, eps=EPS):
    """结构还在不在。连着的必须还连着，分开的不许挤到一起、也不许缩掉四成。"""
    for k, d0 in before.items():
        d1 = after.get(k, d0)
        if d0 < eps:
            if d1 >= eps:
                return False            # 关节被拉开了
        else:
            if d1 < eps or d1 < d0 * 0.6:
                return False            # 本来分开的两笔挤到一起了
    return True


def preserves_trace(element):
    if element.get("traceMode") == "original":
        return True
    # Compatibility with the first trace implementation: zero added jitter,
    # and the distinctive M (L Q)+ L series of tiny rounded corners.
    if element.get("t", "path") != "path" or element.get("amp") != 0:
        return False
    segments = dpath.parse(element.get("d", ""))
    commands = [segment["c"] for segment in segments]
    return (len(commands) >= 4 and commands[0] == "M" and commands[-1] == "L"
            and len(commands[1:-1]) % 2 == 0
            and all(command == ("L" if index % 2 == 0 else "Q")
                    for index, command in enumerate(commands[1:-1])))


def vary(items, seed, cell=64, amp=1.0, tries=6):
    """一个字的硬几何 -> 另一份写法。结构不动，写法全换。

    非 path 的元素（rect / circle）原样带过 —— 汉字里用不到，但几何格式允许。
    """
    base = [dict(e) for e in items]
    # Keep the whole glyph coherent: varying only its other strokes would
    # detach them from the preserved trace at their shared joints.
    if any(preserves_trace(element) for element in items):
        return base
    strokes0 = [dpath.parse(e["d"]) for e in items if e.get("t", "path") == "path"]
    if not strokes0:
        return base
    g0 = gaps(strokes0)
    for t in range(tries):
        out = _vary_once(items, seed * 1000 + t, cell, amp * (1.0 - 0.15 * t))
        s1 = [dpath.parse(e["d"]) for e in out if e.get("t", "path") == "path"]
        if intact(g0, gaps(s1), EPS * cell / 64.0):
            return out
    return base            # 摇不出合格的写法：这个字这次就不变


def _vary_once(items, seed, cell=64, amp=1.0):
    k = cell / 64.0
    strokes, other = [], []
    for i, el in enumerate(items):
        if el.get("t", "path") == "path":
            strokes.append((i, dpath.parse(el["d"])))
        else:
            other.append(i)
    if not strokes:
        return [dict(e) for e in items]

    segs_list = [s for _, s in strokes]
    cluster_of, attach = structure(segs_list, EPS * k)
    attached_pts = {(si, gi) for si, gi, _, _ in attach}

    bx = jit(BODY * amp * k, seed, 3)          # 整字重心
    by = jit(BODY * amp * k, seed, 5)

    # 关节位移：一个关节一份，挂在它上面的每一笔都跟着走
    jd = {}
    for c in set(cluster_of.values()):
        jd[c] = (jit(JOINT * amp * k, seed, 11, c), jit(JOINT * amp * k, seed, 13, c))

    disp = {}                                   # (si, gi) -> 位移
    for si, segs in enumerate(segs_list):
        poly = _poly(segs)
        an = _anchors(segs)
        for n, (gi, p) in enumerate(an):
            key = (si, gi)
            if key in cluster_of:
                disp[key] = jd[cluster_of[key]]
                continue
            if key in attached_pts:
                disp[key] = (0.0, 0.0)          # 稍后贴回宿主，先不动
                continue
            # 自由端：沿切线改长短、沿法线改斜度。中段的锚点按小幅度跟着动
            free = (n == 0 or n == len(an) - 1)
            if len(an) > 1:
                q = an[n - 1][1] if n > 0 else an[1][1]
                dx, dy = p[0] - q[0], p[1] - q[1]
                if n == 0:
                    dx, dy = -dx, -dy
            else:
                dx, dy = 1.0, 0.0
            L = math.hypot(dx, dy) or 1.0
            tx, ty = dx / L, dy / L
            a_t = jit((FREE_T if free else JOINT * 0.6) * amp * k, seed, 17, si, gi)
            a_n = jit((FREE_N if free else JOINT * 0.4) * amp * k, seed, 19, si, gi)
            disp[key] = (tx * a_t - ty * a_n, ty * a_t + tx * a_n)

        # 控制点跟着两端的锚点走，再单独加一点弯度
        for gi, s in enumerate(segs):
            if len(s["p"]) < 2:
                continue
            d_end = disp.get((si, gi), (0, 0))
            prev_gi = gi - 1
            d_prev = disp.get((si, prev_gi), d_end)
            n_ctrl = len(s["p"]) - 1
            for ci in range(n_ctrl):
                u = (ci + 1) / (n_ctrl + 1)
                base = (d_prev[0] + (d_end[0] - d_prev[0]) * u,
                        d_prev[1] + (d_end[1] - d_prev[1]) * u)
                a, b = s["p"][ci], s["p"][-1]
                dx, dy = b[0] - a[0], b[1] - a[1]
                L = math.hypot(dx, dy) or 1.0
                nx, ny = -dy / L, dx / L
                c = jit(CURVE * amp * k, seed, 23, si, gi, ci)
                disp[("c", si, gi, ci)] = (base[0] + nx * c, base[1] + ny * c)

    # 落位
    out_segs = []
    for si, segs in enumerate(segs_list):
        new = []
        for gi, s in enumerate(segs):
            t = {"c": s["c"], "p": [list(q) for q in s["p"]]}
            if "a" in s:
                r = 1 + jit(0.12 * amp, seed, 29, si, gi)       # 折角半径也呼吸
                t["a"] = [s["a"][0] * r, s["a"][1] * r] + list(s["a"][2:])
            for ci in range(len(t["p"]) - 1):
                d = disp.get(("c", si, gi, ci), (0, 0))
                t["p"][ci][0] += d[0] + bx; t["p"][ci][1] += d[1] + by
            if t["p"]:
                d = disp.get((si, gi), (0, 0))
                t["p"][-1][0] += d[0] + bx; t["p"][-1][1] += d[1] + by
            new.append(t)
        out_segs.append(new)

    # 挂在别人中段上的点：宿主变形完了，按原来的参数位置重新贴回去
    for si, gi, hj, t in attach:
        host = _poly(out_segs[hj])
        if not host:
            continue
        p = _at(host, t)
        seg = out_segs[si][gi]
        if seg["p"]:
            old = seg["p"][-1]
            dx, dy = p[0] - old[0], p[1] - old[1]
            seg["p"][-1] = [p[0], p[1]]
            for ci in range(len(seg["p"]) - 1):     # 控制点跟着这一段一起挪
                seg["p"][ci][0] += dx * 0.5; seg["p"][ci][1] += dy * 0.5

    # 别摇出格子：字面留 4 个单位的边
    lo, hi = 4.0 * k, cell - 4.0 * k
    xs = [q[0] for sg in out_segs for s in sg for q in s["p"]]
    ys = [q[1] for sg in out_segs for s in sg for q in s["p"]]
    if xs:
        ox = min(0.0, lo - min(xs)) + min(0.0, hi - max(xs))
        oy = min(0.0, lo - min(ys)) + min(0.0, hi - max(ys))
        ox = max(lo - min(xs), 0.0) + min(hi - max(xs), 0.0)
        oy = max(lo - min(ys), 0.0) + min(hi - max(ys), 0.0)
        for sg in out_segs:
            for s in sg:
                for q in s["p"]:
                    q[0] += ox; q[1] += oy

    out = [dict(e) for e in items]
    for n, (i, _) in enumerate(strokes):
        e = dict(items[i]); e["d"] = dpath.serialize(out_segs[n]); out[i] = e
    return out
