"""排一行字：摆正 -> 逐字大小 -> 落格。规矩见 reference/glyphs.md「排一行字」。

这一层要的是「写偏了」，不是「画偏了」：手气全部来自这里的可控抖动，
不来自字库里某个字画得偏了 —— 所以先按字面框把字拉回格子中央，再叠大小和位移。

汉字一字一格等宽；拉丁每个字母各带 adv，绕基线缩放。两套的支点不一样，
绕错了一行字的下沿会变成波浪。
"""
import math
import re

PUNCT = set("，。？！、～…—·,.?!")     # 标点不参与摆正：它们本来就该缩在一角

TRACK, WORD, BASELINE = 7.0, 26.0, 48.0   # 拉丁：字距 / 词距 / 基线
DEAD, CAP = 1.5, 5.0                      # 摆正：死区 / 拉回量上限
ROT = 1.5                                 # 逐字旋转，度


def rnd(*key):
    """0–1，同一份文案永远抖成同一个样子。

    每轮 FNV 之后必须跟一次雪崩混合 —— 只乘一遍的话，输入是一两个小整数时
    i 加一只把结果推动百分之零点几，一行字的大小会是一条缓坡。
    """
    h = 2166136261
    for k in key:
        h = ((h ^ (int(k) & 0xFFFFFFFF)) * 16777619) & 0xFFFFFFFF
        h ^= h >> 16; h = (h * 0x85EBCA6B) & 0xFFFFFFFF
        h ^= h >> 13; h = (h * 0xC2B2AE35) & 0xFFFFFFFF
        h ^= h >> 16
    return h / 0xFFFFFFFF


def jit(amp, *key):
    return (rnd(*key) * 2 - 1) * amp


def bbox(polys):
    xs = [p[0] for poly, _ in polys for p in poly]
    ys = [p[1] for poly, _ in polys for p in poly]
    return (min(xs), min(ys), max(xs), max(ys)) if xs else (0, 0, 0, 0)


_VARIANT_SUFFIX = re.compile(r"^(.*?)(\d+)$")


def base_name(name):
    """取字形的可见字符；`露2` / `露3` 是同一个字的显式画法变体。"""
    name = str(name)
    match = _VARIANT_SUFFIX.match(name)
    return match.group(1) if match and match.group(1) else name


def _variant_sort_key(name):
    match = _VARIANT_SUFFIX.match(str(name))
    if not match or not match.group(1):
        return (0, 1, str(name))
    return (1, int(match.group(2)), str(name))


def local_seed(seed_map, name):
    """返回某个字的局部种子；没有局部覆盖时返回 None。"""
    if not isinstance(seed_map, dict) or name not in seed_map:
        return None
    try:
        return int(seed_map[name])
    except (TypeError, ValueError):
        return None


def effective_seed(seed_map, name, fallback):
    """局部种子优先，否则沿用当前行的全局种子。"""
    value = local_seed(seed_map, name)
    return value if value is not None else int(fallback)


def hand_seed(base, local=None):
    """给底层笔迹一个稳定的局部分流；没有局部种子时保持旧结果。"""
    return int(base) if local is None else int(base) + int(local) * 1000003


def pick(text, avail):
    """文案 -> 字库里的内部名字。

    字库可以保存 `露`、`露2`、`露3` 这样的多份画法；文案里只写可见字符，
    每次出现按变体顺序循环选择。之后 `vary.py` 还会按出现位置重摇骨架，
    所以同一个字可以出现无限次，既不会缺字，也不会机械复制同一张图。
    """
    variants = {}
    for name in avail:
        variants.setdefault(base_name(name), []).append(name)
    for names in variants.values():
        names.sort(key=_variant_sort_key)

    seen = {}
    picked = []
    for ch in text:
        options = variants.get(ch, [])
        if not options:
            picked.append((None, ch, True))
            continue
        occurrence = seen.get(ch, 0)
        picked.append((options[occurrence % len(options)], ch, True))
        seen[ch] = occurrence + 1
    return picked


def align(polys, cell):
    """摆正：字面中心拉回格心，留死区、拉回量封顶。返回摆正后的字面中心。"""
    x0, y0, x1, y1 = bbox(polys)
    ax, ay = (x0 + x1) / 2, (y0 + y1) / 2
    c = cell / 2
    def pull(a):
        d = c - a
        if abs(d) <= DEAD:
            return a
        d = math.copysign(min(abs(d) - DEAD, CAP), d)
        return a + d
    return pull(ax), pull(ay), (x0, y0, x1, y1)


def han_layout(names, polys_of, cell=64, seed=0, amp_k=1.0, punct=PUNCT,
               seed_for=None, local_for=None, track=0.0):
    """汉字：一字一格。返回每个字的 transform 和实际占位框。

    `polys_of(name, i)` 要给出**这一次出现实际要渲的那份几何** —— 骨架层重摇过
    之后字面框会变，拿字库里那份去摆正就白摆了：摇偏多少，摆正就吃不到多少。
    手气要来自可控的那一层。
    """
    out = []
    # 邻字间距约束参考全局种子的基准尺寸。这样局部重摇一个字时，
    # 不会因为 prev_s 被改写而把后面的字也连带换一版。
    prev_ref_s = None
    for i, name in enumerate(names):
        item_seed = seed_for(name, i) if seed_for else seed
        polys = polys_of(name, i) if name else []
        is_p = (name or "")[:1] in punct
        if polys and not is_p:
            ax, ay, fb = align(polys, cell)
        else:
            x0, y0, x1, y1 = bbox(polys) if polys else (0, 0, cell, cell)
            ax, ay, fb = (x0 + x1) / 2, (y0 + y1) / 2, (x0, y0, x1, y1)

        ref_salt = 0
        while True:                                  # 相邻两个字至少差 3.5%
            ref_s = 1 + jit(0.09 * amp_k, i, seed, 17, ref_salt)
            if prev_ref_s is None or abs(ref_s - prev_ref_s) >= 0.035 * amp_k or ref_salt > 8:
                break
            ref_salt += 1

        if local_for and local_for(name, i):
            # 局部锁定字不能受全局种子或邻字约束牵连；否则全局换种子时，
            # 仅仅为了找一个“不相邻”的盐，锁定字自己的尺寸也会跟着跳。
            s = 1 + jit(0.09 * amp_k, i, item_seed, 17, 0)
        else:
            salt = 0
            while True:
                s = 1 + jit(0.09 * amp_k, i, item_seed, 17, salt)
                if prev_ref_s is None or abs(s - prev_ref_s) >= 0.035 * amp_k or salt > 8:
                    break
                salt += 1
        prev_ref_s = ref_s
        f = jit(0.035 * amp_k, i, item_seed, 91)          # 压扁抻长，面积不变
        sx, sy = s * (1 + f), s * (1 - f)
        rot = jit(ROT * amp_k, i, item_seed, 43)
        cx = (cell + track) * i + cell / 2 + jit(1.1 * amp_k, i, item_seed, 7)
        cy = cell / 2 + jit(1.1 * amp_k, i, item_seed, 29)
        out.append({"name": name, "sx": sx, "sy": sy, "rot": rot,
                    "cx": cx, "cy": cy, "ax": ax, "ay": ay, "face": fb, "s": s,
                    "tf": (f"translate({cx:.2f} {cy:.2f}) rotate({rot:.2f}) "
                           f"scale({sx:.4f} {sy:.4f}) translate({-ax:.2f} {-ay:.2f})")})
    return out


def latin_layout(names, polys_of, advs, seed=0, amp_k=1.0, baseline=BASELINE,
                 track=TRACK, word=WORD, seed_for=None, local_for=None):
    """拉丁：各带 adv，绕基线缩放，排版时按字面底边压到基线上。"""
    out = []
    x = 0.0
    # 与 han_layout 一样，后续字的约束只看全局基准尺寸，隔离局部重摇。
    prev_ref_s = None
    for i, name in enumerate(names):
        item_seed = seed_for(name, i) if seed_for else seed
        if name == " ":
            x += word + track
            continue
        polys = polys_of(name, i) if name else []
        adv = advs.get(name, 28.0)
        x0, y0, x1, y1 = bbox(polys) if polys else (0, 0, adv, baseline)
        descend = name in (",", ".", "y", "g", "p", "q", "j")
        dy = 0.0 if descend else baseline - y1     # 压到基线；带下伸部的不动

        ref_salt = 0
        while True:
            ref_s = 1 + jit(0.09 * amp_k, i, seed, 17, ref_salt)
            if prev_ref_s is None or abs(ref_s - prev_ref_s) >= 0.035 * amp_k or ref_salt > 8:
                break
            ref_salt += 1

        if local_for and local_for(name, i):
            s = 1 + jit(0.09 * amp_k, i, item_seed, 17, 0)
        else:
            salt = 0
            while True:
                s = 1 + jit(0.09 * amp_k, i, item_seed, 17, salt)
                if prev_ref_s is None or abs(s - prev_ref_s) >= 0.035 * amp_k or salt > 8:
                    break
                salt += 1
        prev_ref_s = ref_s
        f = jit(0.035 * amp_k, i, item_seed, 91)
        sx, sy = s * (1 + f), s * (1 - f)
        rot = jit(ROT * amp_k, i, item_seed, 43)
        out.append({"name": name, "source_index": i, "sx": sx, "sy": sy, "rot": rot, "adv": adv,
                    "x": x, "dy": dy, "face": (x0, y0, x1, y1), "s": s,
                    "tf": (f"translate({x + adv*sx/2:.2f} {baseline:.2f}) rotate({rot:.2f}) "
                           f"scale({sx:.4f} {sy:.4f}) "
                           f"translate({-adv/2:.2f} {dy - baseline:.2f})")})
        x += adv * sx + track
    return out, x - track


def bounds(layout, polys_of, cell=64):
    """把每个字的 transform 算一遍，取整行的真实包围盒。

    渲出来看有没有被切是查不干净的 —— 切掉的往往正好是最长那一钩，
    不并排比对根本看不出来。所以 PAD 要量，不能靠看。
    """
    X0 = Y0 = 1e9; X1 = Y1 = -1e9
    for i, g in enumerate(layout):
        source_index = g.get("source_index", i)
        polys = polys_of(g["name"], source_index) if g.get("name") else []
        if not polys:
            continue
        t = math.radians(g["rot"]); ct, st = math.cos(t), math.sin(t)
        ax, ay = (g["ax"], g["ay"]) if "ax" in g else (g["adv"] / 2, g["baseline_dy"])
        for poly, _ in polys:
            for px, py in poly:
                if "ax" in g:
                    ux, uy = (px - g["ax"]) * g["sx"], (py - g["ay"]) * g["sy"]
                    X, Y = g["cx"] + ux * ct - uy * st, g["cy"] + ux * st + uy * ct
                else:
                    ux = (px - g["adv"] / 2) * g["sx"]
                    uy = (py + g["dy"] - BASELINE) * g["sy"]
                    X = g["x"] + g["adv"] * g["sx"] / 2 + ux * ct - uy * st
                    Y = BASELINE + ux * st + uy * ct
                X0 = min(X0, X); X1 = max(X1, X); Y0 = min(Y0, Y); Y1 = max(Y1, Y)
    return (X0, Y0, X1, Y1) if X1 > X0 else (0, 0, cell, cell)
