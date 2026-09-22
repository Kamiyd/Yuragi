# hand-glyph

**拙趣感手绘字** agent skill：让 Claude Code、Codex 等 AI 助手写出茶饮海报（比如喜茶）里那种拙趣的手绘字 ——
笔画微微发抖、字有大有小、同一个字每次写得都不一样，而不是套一款固定字形的手写体字体。

助手先画干净的字形骨架，再交给和 [Yuragi](../../README.md) 网页版同一套的手绘算法把「拙」写出来。
适合标题、字标、展示用的短句。输出是透明背景、跟随页面颜色（`currentColor`）的 SVG。

## 安装

一条命令（需要 Node.js，只在安装时用到）：

```bash
npx skills add Kamiyd/Yuragi@hand-glyph -g
```

- 装到 `~/.agents/skills/hand-glyph`，Codex 等支持通用 skill 目录的助手直接读取，Claude Code 会自动链接过去。
- 去掉 `-g` 只装到当前项目。以后更新：`npx skills update`。

不想用 Node，也可以手动装：只需要这一个文件夹，不用整个 Yuragi 仓库。

```bash
git clone --depth 1 https://github.com/Kamiyd/Yuragi.git
mkdir -p ~/.claude/skills && cp -R Yuragi/skills/hand-glyph ~/.claude/skills/   # Claude Code
mkdir -p ~/.codex/skills && cp -R Yuragi/skills/hand-glyph ~/.codex/skills/     # Codex；其他助手换成各自的 skills 目录
```

## 运行要求

- **Python 3.8+**，出图只用标准库，不用装别的。
- 可选：Pillow（参照叠图出 PNG）。`python3 -m pip install -r scripts/requirements.txt`
- 参照字体「小赖」（SIL OFL）没装的话，第一次画新字时自动下载约 22MB 到 `~/.cache/hand-glyph/fonts`；
  不想联网就加 `--no-download`。

装好后可以先检查一下环境：

```bash
python3 ~/.agents/skills/hand-glyph/scripts/handdraw.py doctor   # 手动安装的换成你拷去的路径
```

## 怎么用

装好后直接跟助手说，例如：

> 用手写字写一个标题：「海上生明月」，下面配英文 One moon, one moment.

也可以点名「用 hand-glyph」。助手会读 [SKILL.md](SKILL.md) 自己完成：

- **这套工具不自带字库。** 缺的字由助手按规范一笔一笔画骨架（对照系统黑体和小赖），第一次写新字会慢一些；
  画好的字库 JSON 留着，下次同样的字直接排。
- 交付物默认只有字：透明背景，不加底色、装饰和阴影。要海报或配图请明说。
- 显示尺寸别太小：汉字一格不低于 44px，英文一行不低于 28px。

想自己动手拖骨架改字，用 [Yuragi 网页版](../../README.md)，工程 JSON 和这里的字库是同一种格式，
详见 [reference/editor.md](reference/editor.md)。

## 目录

```
SKILL.md          skill 入口（助手读的说明）
scripts/          handdraw.py（write / compose / lint / doctor / svg / gallery / vary）、
                  overlay.py（参照叠图）、算法模块；requirements.txt（可选依赖）
reference/        glyphs.md（骨架规范）、params.md（滤镜参数）、editor.md（编辑）、manual-svg.md（手写 SVG）
assets/           glyphs.json（空字库模板，新建工程的默认预设）
```

## 维护

这份 Python 实现也是 Yuragi 网页版的对照基准：

```bash
npm run parity:fixtures   # 用这里的脚本生成对照数据
npm run parity            # 检查 TypeScript 输出是否逐字节一致
```

改了 `scripts/` 里的算法，网页版要跟着改，两边都跑一遍对照再提交。
产品说明和运行方式见仓库根目录的 [README](../../README.md)。
