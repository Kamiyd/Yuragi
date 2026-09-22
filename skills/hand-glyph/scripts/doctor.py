"""环境自检：动笔前跑一次，看哪些能用、缺什么、怎么补。

    python3 handdraw.py doctor          # 本机检查，不联网
    python3 handdraw.py doctor --net    # 顺带试一下小赖的下载地址（只取响应头）

write / svg / gallery / vary / compose / lint 只要 Python 3 标准库；
下面这些是可选项，缺了会降级，不会挡住出图。
"""
import argparse
import os
import sys

import overlay

HERE = os.path.dirname(os.path.abspath(__file__))


def main(argv):
    ap = argparse.ArgumentParser(prog="handdraw.py doctor")
    ap.add_argument("--net", action="store_true", help="试一下小赖的下载地址")
    a = ap.parse_args(argv)
    ok = lambda s: print("  ✓ " + s)
    no = lambda s: print("  ✗ " + s)
    tip = lambda s: print("    → " + s)

    print("出图（必需）")
    if sys.version_info >= (3, 8):
        ok("Python %d.%d：write / svg / gallery / vary / compose / lint 都能用" % sys.version_info[:2])
    else:
        no("Python %d.%d 太旧" % sys.version_info[:2]); tip("需要 3.8+")

    print("参照叠图 overlay.py（可选）")
    try:
        import PIL  # noqa: F401
        ok("Pillow %s：可以出 PNG" % PIL.__version__)
    except ImportError:
        no("没装 Pillow：overlay.py 会自动改出 SVG（浏览器打开，用系统里装好的字体渲染）")
        tip("要 PNG：python3 -m pip install -r %s" % os.path.join(HERE, "requirements.txt"))
    han = overlay.first_existing(overlay.HAN_FONTS)
    (ok if han else no)("结构参照（黑体）：%s" % (han or "没找到"))
    if not han:
        tip("用 --han 指定一个简体印刷体")
    installed = overlay.first_existing(overlay.HAND_FONTS)
    cached = overlay.cached_xiaolai(download=False)
    if installed:
        ok("比例参照（小赖）：已安装 %s" % installed)
    elif cached:
        ok("比例参照（小赖）：缓存 %s" % cached)
        tip("SVG 模式要系统里装好的字体才渲得出来；要 SVG 叠图就把它装进系统字体")
    else:
        no("比例参照（小赖）：本机和缓存都没有")
        tip("第一次跑 overlay.py 会下载约 22MB 到 %s（SIL OFL）；不联网就 --no-download" % overlay.CACHE_DIR)
    try:
        os.makedirs(overlay.CACHE_DIR, exist_ok=True)
        probe = os.path.join(overlay.CACHE_DIR, ".write-test")
        open(probe, "w").close(); os.remove(probe)
        ok("缓存目录可写：%s" % overlay.CACHE_DIR)
    except OSError as e:
        no("缓存目录写不了：%s" % e)
    if a.net:
        try:
            status, length = overlay.reachable(overlay.XIAOLAI_URL)
            ok("小赖下载地址可达（%s，%s 字节）" % (status, length))
        except Exception as e:
            no("小赖下载地址连不上：%s" % e)

    print("拖骨架编辑（可选）")
    dist = os.path.realpath(os.path.join(HERE, "..", "web", "dist", "index.html"))
    if os.path.exists(dist):
        ok("edit 可用：%s" % os.path.dirname(dist))
    else:
        no("edit 不可用：独立安装的 skill 不带 web/dist")
        tip("用 Yuragi 网页版编辑：打开工程 JSON → 拖骨架 → 下载工程文件，再回来 write / compose")
    return 0
