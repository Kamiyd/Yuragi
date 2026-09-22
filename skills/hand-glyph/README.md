# hand-glyph

手写字 agent skill：先画字形骨架，再用手绘滤镜写出 SVG。用法和规范见 [SKILL.md](SKILL.md)，
画字细则见 [reference/glyphs.md](reference/glyphs.md)。

```
SKILL.md          skill 入口
scripts/          handdraw.py（write / compose / lint / doctor / svg / gallery / vary）、
                  overlay.py（参照叠图）、算法模块；requirements.txt（可选依赖）
reference/        glyphs.md（骨架规范）、params.md（滤镜参数）、editor.md（编辑）、manual-svg.md（手写 SVG）
assets/           glyphs.json（空字库模板，新建工程的默认预设）
```

这份 Python 实现也是 Yuragi 网页版的对照基准：

```bash
npm run parity:fixtures   # 用这里的脚本生成对照数据
npm run parity            # 检查 TypeScript 输出是否逐字节一致
```

改了 `scripts/` 里的算法，网页版要跟着改，两边都跑一遍对照再提交。
产品说明和运行方式见仓库根目录的 [README](../../README.md)。
