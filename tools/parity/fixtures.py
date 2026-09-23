#!/usr/bin/env python3
"""用 Python 那一份实现生成「标准结果」，给 TypeScript 移植当对照。

跑法：python3 tools/parity/fixtures.py  ->  tools/parity/fixtures.json
然后 npm run parity 用 TS 重算一遍，逐条比对。

比的不是「差不多」：d 串、SVG、transform 全是字符串精确比对，
浮点中间量按 1e-12 比。有一条不一样就是移植漂了。
"""
import io, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.realpath(os.path.join(HERE, "..", ".."))
PY = os.path.join(ROOT, "skills", "hand-glyph", "scripts")
sys.path.insert(0, PY)

import dpath, flatten, hand as handmod, row as rowmod, vary as varymod, latin_zhuo
import handdraw as H
import edit

DATA = os.path.join(ROOT, "src", "data")
LIBS = ["han-sample.json", "latin-compact.json", "latin-round.json",
        "han-latin-sample.json", "cursor-brush.json"]


def load_raw(name):
    return json.load(io.open(os.path.join(DATA, name), encoding="utf-8"))


def geo_payload(name):
    edit.PATH = os.path.join(DATA, name)
    edit.ROW = None
    return edit.load_geo()


def fixture():
    out = {}

    # 1. 确定性随机：种子公式是整条流水线的根
    rnd = []
    for a in range(0, 24):
        for b in (0, 1, 7, 17, 43, 91, 977, 100000, 2 ** 31, 2 ** 31 + 5):
            rnd.append({"key": [a, b], "value": rowmod.rnd(a, b)})
    for key in ([0], [1, 2, 3], [5, 17, 3, 8], [-3, 7], [12345678901, 3],
                [97 * 5 + 3, 23, 1, 2], [2 ** 32 - 1], [2 ** 32], [0, 0, 0, 0, 0]):
        rnd.append({"key": key, "value": rowmod.rnd(*key)})
    out["rnd"] = rnd

    out["hand_seed"] = [{"base": b, "local": l,
                         "value": rowmod.hand_seed(b, l)}
                        for b in (0, 3, 97, 1000) for l in (None, 0, 7, -5)]

    # 2. d 串往返 + 摊平
    dpath_cases, flatten_cases, hand_cases, corner_cases = [], [], [], []
    for lib in LIBS:
        raw = H.normalize.__globals__  # noqa: F841  (只是确保模块已加载)
        data = load_raw(lib)
        items = data.get("items", data)
        for name, els in items.items():
            for k, el in enumerate(els):
                if el.get("t", "path") != "path":
                    continue
                d = el["d"]
                segs = dpath.parse(d)
                dpath_cases.append({"lib": lib, "name": name, "i": k, "d": d,
                                    "segs": segs, "out": dpath.serialize(segs)})
                polys = flatten.path_to_polys(d)
                flatten_cases.append({"lib": lib, "name": name, "i": k, "d": d,
                                      "polys": [[[list(p) for p in poly], bool(c)] for poly, c in polys]})
                for poly, closed in polys:
                    sharp = sorted(flatten.corners(poly, closed, 32))
                    corner_cases.append({"lib": lib, "name": name, "i": k,
                                         "closed": bool(closed), "sharp": sharp})
                    deduped = flatten.dedupe(poly, 0.45 * 64 / 24)
                    for seed, amp, over, step in ((1, 0.34, 0.5, 1.35),
                                                  (7, 0.9, 0.28, 2.4),
                                                  (13, 0.14, 0.0, 3.6)):
                        hand_cases.append({
                            "lib": lib, "name": name, "i": k, "seed": seed,
                            "amp": amp, "over": over, "step": step, "closed": bool(closed),
                            "pts": [list(p) for p in deduped], "sharp": sharp,
                            "d": handmod.hand(deduped, seed=seed, amp=amp, closed=closed,
                                              sharp=tuple(sharp), over=over, step=step)})
    out["dpath"] = dpath_cases
    out["flatten"] = flatten_cases[:400]
    out["corners"] = corner_cases[:400]
    out["hand"] = hand_cases[:600]

    # 3. 单字渲染（= /api/render）
    render_cases = []
    for lib in LIBS:
        payload = geo_payload(lib)
        glyphs = payload["glyphs"]
        for idx, (name, els) in enumerate(glyphs["items"].items()):
            local = rowmod.local_seed(glyphs["glyphSeeds"], name)
            render_cases.append({
                "lib": lib, "name": name, "idx": idx, "local": local,
                "paths": edit.render(glyphs["vb"], idx, els, glyphs["amp"], glyphs["over"], local)})
    out["render"] = render_cases

    # 4. 骨架层重写
    vary_cases = []
    for lib in LIBS:
        data = load_raw(lib)
        items = data.get("items", data)
        vb = float(data.get("vb", 64))
        for name, els in items.items():
            for seed in (0, 1, 131, 4242, 987654):
                varied = varymod.vary(els, seed, cell=vb, amp=float(data.get("vary", 1.0)))
                vary_cases.append({"lib": lib, "name": name, "seed": seed,
                                   "out": [e.get("d") for e in varied]})
    out["vary"] = vary_cases

    # 4c. 英文变拙：规整字母 -> 拙趣版（编辑器的「英文变拙」按钮跟 latin-zhuo 命令必须一模一样）
    import copy
    lz_cases = []
    for lib in ("latin-compact.json", "latin-round.json", "latin-open.json", "han-latin-sample.json"):
        data = load_raw(lib)
        items = data.get("items", data)
        for name, els in items.items():
            if not els or "adv" not in els[0]:
                continue
            for amount in (1.0, 0.6):
                res = latin_zhuo.zhuo_letter(name, copy.deepcopy(els), amount)
                lz_cases.append({"lib": lib, "name": name, "amount": amount,
                                 "out": [e.get("d") for e in res], "adv": res[0].get("adv")})
    out["latin_zhuo"] = lz_cases

    # 5. 结构不变量
    structure_cases = []
    for lib in LIBS:
        data = load_raw(lib)
        items = data.get("items", data)
        vb = float(data.get("vb", 64))
        for name, els in items.items():
            strokes = [dpath.parse(e["d"]) for e in els if e.get("t", "path") == "path"]
            if not strokes:
                continue
            cluster, attach = varymod.structure(strokes, varymod.EPS * vb / 64.0)
            structure_cases.append({
                "lib": lib, "name": name,
                "cluster": sorted([[list(k), v] for k, v in cluster.items()]),
                "attach": [list(a) for a in attach],
                "gaps": sorted([[list(k), v] for k, v in varymod.gaps(strokes).items()])})
    out["structure"] = structure_cases

    # 6. 排一行（= /api/row）
    row_cases = []
    texts = {
        "han-sample.json": ["我和", "我和我", "和和和", "我是", "我和2"],
        "latin-compact.json": ["Hand", "glyphs", "make", "Hand glyph"],
        "latin-round.json": ["Hand", "glyph.", "smack"],
        "han-latin-sample.json": ["我和", "Hand", "手写", "我和 Hand"],
        "cursor-brush.json": [""],
    }
    for lib in LIBS:
        payload = geo_payload(lib)
        glyphs = payload["glyphs"]
        mode = "latin" if any(els and els[0].get("adv") is not None
                              for els in glyphs["items"].values()) else "han"
        for text in texts[lib]:
            if not text:
                continue
            for seed in (1, 42, 2718):
                for do_vary in (True, False):
                    row = edit.render_row(text, seed, glyphs["jit"], mode,
                                          glyphs["amp"], glyphs["over"], do_vary,
                                          glyphs["vary"], glyphs["glyphSeeds"], glyphs,
                                          glyphs["track"], glyphs["word"])
                    row_cases.append({"lib": lib, "text": text, "seed": seed, "mode": mode,
                                      "vary": do_vary, "result": row})
    out["row"] = row_cases

    # 6b. 边界：缺字、标点、字距/词距、局部种子、手感倍率
    edge_cases = []
    payload = geo_payload("han-sample.json")
    glyphs = payload["glyphs"]
    latin = geo_payload("latin-round.json")["glyphs"]
    for case in (
        {"g": glyphs, "lib": "han-sample.json", "text": "我X和", "seed": 5, "mode": "han"},
        {"g": glyphs, "lib": "han-sample.json", "text": "我，和。", "seed": 5, "mode": "han"},
        {"g": glyphs, "lib": "han-sample.json", "text": "和和和和和", "seed": 3, "mode": "han"},
        {"g": glyphs, "lib": "han-sample.json", "text": "我和我", "seed": 3, "mode": "han",
         "track": 6.5, "ampk": 0.4},
        {"g": glyphs, "lib": "han-sample.json", "text": "我和我", "seed": 3, "mode": "han",
         "track": -3, "amp": 1.6, "over": 0.2, "varyk": 1.8},
        {"g": glyphs, "lib": "han-sample.json", "text": "我和", "seed": 3, "mode": "han",
         "glyph_seeds": {"我": 12, "和": 3}},
        {"g": glyphs, "lib": "han-sample.json", "text": "", "seed": 1, "mode": "han"},
        {"g": latin, "lib": "latin-round.json", "text": "Hand glyph.", "seed": 9, "mode": "latin"},
        {"g": latin, "lib": "latin-round.json", "text": "Hand glyph.", "seed": 9, "mode": "latin",
         "track": 12, "word": 40},
        {"g": latin, "lib": "latin-round.json", "text": "ss", "seed": 9, "mode": "latin",
         "glyph_seeds": {"s": 4}},
        {"g": latin, "lib": "latin-round.json", "text": "Hand", "seed": 9, "mode": "han"},
        # 按字宽排（fit）：字有大有小，字距跟着字宽走
        {"g": dict(glyphs, fit=12), "lib": "han-sample.json", "text": "杨枝甘露茶", "seed": 3,
         "mode": "han", "fit": 12},
        {"g": dict(glyphs, fit=6.5), "lib": "han-sample.json", "text": "我和 我，", "seed": 11,
         "mode": "han", "fit": 6.5, "track": 3, "ampk": 1.6},
        # 错落（drift）：字上下浮、小字往上靠或往下坐、字距忽近忽远
        {"g": dict(glyphs, fit=12, drift=1), "lib": "han-sample.json", "text": "杨枝甘露茶", "seed": 5,
         "mode": "han", "fit": 12, "drift": 1},
        {"g": dict(glyphs, drift=1.4), "lib": "han-sample.json", "text": "我和，我", "seed": 2,
         "mode": "han", "drift": 1.4},
        {"g": dict(latin, drift=1), "lib": "latin-round.json", "text": "Hand glyph.", "seed": 9,
         "mode": "latin", "drift": 1},
    ):
        g = case["g"]
        row = edit.render_row(
            case["text"], case["seed"], case.get("ampk", g["jit"]), case["mode"],
            case.get("amp", g["amp"]), case.get("over", g["over"]),
            case.get("vary", True), case.get("varyk", g["vary"]),
            case.get("glyph_seeds", g["glyphSeeds"]), g,
            case.get("track", g["track"]), case.get("word", g["word"]))
        edge_cases.append({k: v for k, v in case.items() if k != "g"} | {"result": row})
    out["row_edge"] = edge_cases

    # 6c. 自动换行：预览按渲染后的实际宽高折行，多行共用一个 viewBox
    wrap_cases = []
    for lib, extra in (("han-sample.json", {}), ("latin-compact.json", {}),
                       ("han-sample.json", {"fit": 12, "drift": 1})):
        glyphs = dict(geo_payload(lib)["glyphs"], **extra)
        names = list(glyphs["items"])
        mode = "latin" if lib.startswith("latin") else "han"
        text = "我和我和我和我" if lib == "han-sample.json" else "".join(names[:7])
        for max_width in (90.0, 160.0, 320.0):
            row = edit.render_row(text, 42, glyphs["jit"], mode,
                                  glyphs["amp"], glyphs["over"], True, glyphs["vary"],
                                  glyphs["glyphSeeds"], glyphs, glyphs["track"],
                                  glyphs["word"], max_width, 44.0)
            wrap_cases.append({"lib": lib, "text": text, "mode": mode, **extra,
                               "maxWidth": max_width, "result": row})
    out["row_wrap"] = wrap_cases

    # 7. write（多行、含 / 断行）
    write_cases = []
    for lib, text, fit in (("han-sample.json", "我和/和我", None), ("han-sample.json", "我和", None),
                           ("latin-compact.json", "Hand/glyphs", None),
                           ("han-sample.json", "杨枝甘露/特调茶", 12),
                           ("han-sample.json", "杨枝甘露/特调茶/我和", "drift"),
                           ("latin-compact.json", "Hand/glyphs", "drift")):
        data = load_raw(lib)
        if fit == "drift":
            data = dict(data, fit=12, drift=1)
        elif fit is not None:
            data = dict(data, fit=fit, track=2)
        normalized = H.normalize(data)
        raw = dict({p: normalized[p] for p in H.PARAMS},
                   vb=normalized["vb"], sw=normalized["sw"],
                   fit=normalized["fit"], track=normalized["track"], drift=normalized["drift"],
                   seed=normalized.get("seed"),
                   glyphSeeds=normalized.get("glyphSeeds", {}),
                   items=normalized["raw"])
        for seed in (7, 99):
            svg, ratio = H.write_lines(raw, text, seed, True)
            write_cases.append({"lib": lib, "text": text, "seed": seed, "fit": fit,
                                "svg": svg, "ratio": ratio})
    out["write"] = write_cases

    # 8. 字库读写往返：保存出的文件必须字节一致
    save_cases = []
    for lib in LIBS:
        payload = geo_payload(lib)
        edit.PATH = os.path.join(HERE, "_tmp_save.json")
        edit.save_geo(payload["glyphs"])
        text = io.open(edit.PATH, encoding="utf-8").read()
        os.remove(edit.PATH)
        save_cases.append({"lib": lib, "text": text, "payload": payload})
    out["save"] = save_cases

    # 9. svg_markup / 数字格式化
    out["fmt"] = [{"value": v, "g": "%g" % v,
                   "f1": "%.1f" % v, "f2": "%.2f" % v, "f4": "%.4f" % v,
                   "r1": round(v, 1), "r2": round(v, 2), "r3": round(v, 3)}
                  for v in (0, -0.0, 0.5, 1.5, 2.5, -2.5, 0.125, 0.375, 2.675, 64.0,
                            2.8, 2.576, 0.05, -0.05, 1e-5, 123456789.0, 0.000123456,
                            1 / 3, 2 / 3, -1 / 3, 99.995, 0.045, 44.44444449)]
    return out


if __name__ == "__main__":
    data = fixture()
    path = os.path.join(HERE, "fixtures.json")
    io.open(path, "w", encoding="utf-8").write(json.dumps(data, ensure_ascii=False))
    counts = {k: len(v) for k, v in data.items()}
    print("写出", path)
    print("  ", counts)
