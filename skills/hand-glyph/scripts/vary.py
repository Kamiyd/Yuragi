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
SHORT_T = 0.25   # 自由端沿切线的伸缩不超过这一段长度的这么多：点、钩、短撇两头一缩就没了
                 # （实测 5 长的点按原幅度重写，200 次里消失 4 次）。长于 FREE_T/SHORT_T 的笔画不受影响


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


def _trace_disp(si, segs, disp, cluster_of, attached_pts, jd, seed, amp, k):
    """保留手迹的一笔：关键锚点（两头 + 关节）照常算位移，中间的采样点按弧长插值，
    每一段再加一点整体的弯。返回 (锚点, 弧长, 关键锚点序号)，贴回宿主时要用。"""
    an = _anchors(segs)
    m = len(an)
    if not m:
        return (an, [], [])
    acc = [0.0]
    for n in range(1, m):
        a, b = an[n - 1][1], an[n][1]
        acc.append(acc[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = acc[-1]
    keys, kd = [], {}
    for n, (gi, p) in enumerate(an):
        key = (si, gi)
        if key in cluster_of:
            kd[n] = jd[cluster_of[key]]
        elif n != 0 and n != m - 1:
            continue
        elif key in attached_pts:
            kd[n] = (0.0, 0.0)                  # 稍后贴回宿主，先不动
        elif n == m - 1 and m > 2 and 0 in kd and math.hypot(
                p[0] - an[0][1][0], p[1] - an[0][1][1]) < EPS * k:
            kd[n] = kd[0]                       # 首尾接上的圈：两头一起走，圈不断开
        else:
            # 自由端：切线按一小段弧长外的点取 —— 紧挨着的采样点方向是乱的
            reach = min(4.0 * k, total * 0.5)
            q = p
            if n == 0:
                for j in range(1, m):
                    q = an[j][1]
                    if acc[j] >= reach:
                        break
            else:
                for j in range(m - 2, -1, -1):
                    q = an[j][1]
                    if total - acc[j] >= reach:
                        break
            dx, dy = p[0] - q[0], p[1] - q[1]
            if n == 0:
                dx, dy = -dx, -dy
            L = math.hypot(dx, dy)
            tx, ty = (dx / L, dy / L) if L else (1.0, 0.0)
            t_amp = min(FREE_T * amp * k, SHORT_T * total)
            a_t = jit(t_amp, seed, 17, si, gi)
            a_n = jit(FREE_N * amp * k, seed, 19, si, gi)
            kd[n] = (tx * a_t - ty * a_n, ty * a_t + tx * a_n)
        keys.append(n)

    ki = 0
    for n, (gi, p) in enumerate(an):
        while ki < len(keys) - 2 and n > keys[ki + 1]:
            ki += 1
        na = keys[ki]
        nb = keys[ki + 1] if len(keys) > 1 else na
        da, db = kd[na], kd[nb]
        span = acc[nb] - acc[na]
        u = (acc[n] - acc[na]) / span if span > 0 else 0.0
        pa, pb = an[na][1], an[nb][1]
        cx, cy = pb[0] - pa[0], pb[1] - pa[1]
        L = math.hypot(cx, cy)
        nx, ny = (-cy / L, cx / L) if L else (0.0, 0.0)
        bow = jit(min(CURVE * amp * k, span * 0.15), seed, 31, si, na) * 4.0 * u * (1.0 - u)
        disp[(si, gi)] = (da[0] + (db[0] - da[0]) * u + nx * bow,
                          da[1] + (db[1] - da[1]) * u + ny * bow)

    # 控制点跟着两端的采样点走，不另加弯度：轨迹的小圆角原样留着
    for gi, s in enumerate(segs):
        if len(s["p"]) < 2:
            continue
        d_end = disp.get((si, gi), (0, 0))
        d_prev = disp.get((si, gi - 1), d_end)
        n_ctrl = len(s["p"]) - 1
        for ci in range(n_ctrl):
            u = (ci + 1) / (n_ctrl + 1)
            disp[("c", si, gi, ci)] = (d_prev[0] + (d_end[0] - d_prev[0]) * u,
                                       d_prev[1] + (d_end[1] - d_prev[1]) * u)
    return (an, acc, keys)


def _trace_spread(segs, info, gi, delta):
    """保留手迹的端点贴回宿主：挪动量顺着弧长摊到下一个关键锚点，不在笔尖折一下。"""
    an, acc, keys = info
    idx = {g: n for n, (g, _) in enumerate(an)}
    n0 = idx[gi]
    nk = keys[1] if n0 == keys[0] and len(keys) > 1 else (keys[-2] if len(keys) > 1 else n0)
    span = abs(acc[nk] - acc[n0])
    w = {}
    for n, (g, _) in enumerate(an):
        if (n0 <= n <= nk) or (nk <= n <= n0):
            w[g] = 1.0 - abs(acc[n] - acc[n0]) / span if span > 0 else (1.0 if n == n0 else 0.0)
    for g, s in enumerate(segs):
        if not s["p"]:
            continue
        we = w.get(g, 0.0)
        wp = w.get(g - 1, we)
        n_ctrl = len(s["p"]) - 1
        for ci in range(n_ctrl):
            u = (ci + 1) / (n_ctrl + 1)
            wc = wp + (we - wp) * u
            s["p"][ci][0] += delta[0] * wc; s["p"][ci][1] += delta[1] * wc
        s["p"][-1][0] += delta[0] * we; s["p"][-1][1] += delta[1] * we


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
    # 保留手迹：密密的采样点只是轨迹，不是骨架。只有两头和跟别的笔共用的关节算锚点，
    # 中间的点顺着弧长跟着走 —— 复杂的轨迹形状不散，写法照样重摇。
    trace = {si for si, (i, _) in enumerate(strokes) if preserves_trace(items[i])}
    trace_ends = {si: (_anchors(segs_list[si])[0][0], _anchors(segs_list[si])[-1][0])
                  for si in trace if _anchors(segs_list[si])}
    attach = [a for a in attach
              if a[0] not in trace_ends or a[1] in trace_ends[a[0]]]   # 中段采样点不往别人身上挂
    attached_pts = {(si, gi) for si, gi, _, _ in attach}
    trace_keys = {}                              # si -> (锚点, 弧长, 关键锚点序号)

    bx = jit(BODY * amp * k, seed, 3)          # 整字重心
    by = jit(BODY * amp * k, seed, 5)

    # 关节位移：一个关节一份，挂在它上面的每一笔都跟着走
    jd = {}
    for c in set(cluster_of.values()):
        jd[c] = (jit(JOINT * amp * k, seed, 11, c), jit(JOINT * amp * k, seed, 13, c))

    disp = {}                                   # (si, gi) -> 位移
    for si, segs in enumerate(segs_list):
        if si in trace:
            trace_keys[si] = _trace_disp(si, segs, disp, cluster_of, attached_pts, jd, seed, amp, k)
            continue
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
            t_amp = (FREE_T if free else JOINT * 0.6) * amp * k
            if free and len(an) > 1:
                t_amp = min(t_amp, SHORT_T * L)      # 短笔两头最多各缩四分之一
            a_t = jit(t_amp, seed, 17, si, gi)
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
        if si in trace_keys and seg["p"]:
            old = seg["p"][-1]
            _trace_spread(out_segs[si], trace_keys[si], gi, (p[0] - old[0], p[1] - old[1]))
            continue
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
