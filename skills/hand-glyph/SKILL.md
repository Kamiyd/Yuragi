---
name: hand-glyph
description: Draw Chinese characters (and latin words) as hand-written SVG with a clumsy-charm (拙趣) look — wobbly single-weight centre-line strokes, round caps, currentColor, no fills. Use when someone wants a 手写字 / 手写标题 / 手绘汉字 / 拙趣手绘字 / 喜茶风手写字 / hand-lettered heading, a wordmark or title set in a hand made of real strokes rather than a font, or asks to redraw existing text in that style. Not for body copy — the floor is 44px.
---

# 拙趣手绘字

**拙画进骨架，抖交给滤镜。** 骨架别照着字体描成横平竖直、交接严丝合缝的样子 ——
那样滤镜抖得再像，出来也是「一款抖过的字体」。骨架里就写成笨笨的：点和小部件飘着不挨、
部件一大一小、框小而方、折角尖、钩短、字不撑满（规矩见 `reference/glyphs.md`「骨架要拙」）。
主干的交接照样接好 —— 喜茶的字**一处都不出头**，框的角都是封死的；
字库表头写 `"over": 0`，关掉滤镜的收笔越位，不然 T 字交接会支出一小截。
但**每一笔的线是直的**，线的弯和抖统一交给滤镜，别在骨架里画波浪。
拙要按同一套规矩来，不是凭感觉乱歪 —— 十个字各歪各的，就是十只手。

**画骨架，不画轮廓。** 每一笔是一条中心线，粗细交给 `stroke-width`。

**要的气质是拙趣**：像茶饮海报（喜茶那类）里的手绘字 —— 笔画不规矩、字有大有小、同一个字每次写得不一样。
不是一款规整的手写体字体，也不是书法。拙来自骨架的写法（比例、点和部件的疏离、笔形），
滤镜和逐字变化只是再添一点手气。

---

## 默认交付合同（先读这一条）

用户要的是**字**，不是海报。除非用户明确要背景、海报、配图或装饰：

- 交付物是**透明的 SVG，只有字形和排版**。
- 根节点 `fill="none" stroke="currentColor"`，**不写死 `color`**，颜色跟着用它的页面走。
- **不加**背景矩形、月亮、印章、分隔线、阴影、纹理、渐变、半透明。
- 亮底 / 暗底只用于**自检预览**（`compose --preview`、`gallery`、`--candidates` 出的 HTML），
  预览文件要写明是预览，**不能替代、也不能写进**交付物。
- PNG 只在用户要的时候出：SVG 才是主交付物；PNG 必须**显式选颜色**（黑或白），背景仍然透明。
  透明黑字在深色看图器里会像一整块黑，那不是导出失败。
- 显示尺寸下限：汉字 **44px**（一个字的格子），拉丁 **28px**（一行的高度）。

`write` 和 `compose` 直接出符合合同的 SVG；交付前 `lint --svg` 会查。

规格：`viewBox` 64 网格一字一格；字面落在 7–57；线宽 `sw` 汉字 **2.8**、拉丁 **3.4** 是**字库的基础线宽**；
逐笔提按 `w` 0.85–1.15；`linecap` / `linejoin` 都是 `round`。中英合成时副标题的线宽由 `compose`
在合成时补偿，**不改字库里的 `sw`**。

---

## 流程

### 0. 先自检环境

```bash
python3 scripts/handdraw.py doctor
```

出图只要 Python 3 标准库。Pillow、参照字体、编辑器都是可选项，缺了会降级（`doctor` 会说怎么补）。
只能输出文本、跑不了命令时，按 `reference/manual-svg.md` 手写（B 轨，手感约八成）。

### 1. 字库里字都有：直接排

**这套工具不自带字体。** `assets/glyphs.json` 是空模板，字是自己画进去的（下面第 2 步）。

```bash
python3 scripts/handdraw.py write my-font.json "今天好心情" --no-edit -o title.svg
python3 scripts/handdraw.py write my-font.json "今天好心情" --candidates 12 -o seeds.html   # 一次看 12 版
python3 scripts/handdraw.py write my-font.json "今天好心情" -s 42 --no-edit -o title.svg   # 钉住挑中的那版
python3 scripts/handdraw.py compose --han han.json "海上生明月" --latin latin.json "One moon, one moment." -o title.svg
```

- **替用户跑时一律带 `--no-edit`**，不然 `write` 会拉起编辑器、命令挂着不返回。
- 每次跑都是新写的一遍；用 `--candidates` 挑，挑中了 `-s` 钉住。
- 中文一行 + 英文一行用 `compose`：字面框居中、两行线宽自动补偿、透明输出；`--main latin` 让英文做主标题，
  `--preview p.html` 另出亮暗底预览。**不要手工拆两张 SVG 再拼。**
- 缺字时命令会列出缺哪几个，照第 2 步补上。

### 2. 缺字：画新字

完整规格在 `reference/glyphs.md`。流程：

1. **渲参照只核结构，不抄样子。** 黑体只用来数笔画、对笔顺、看部件在哪；小赖只看哪笔另起、哪笔不接。
   **比例、笔长、框的大小都别照参照** —— 它们都是规整的字体，照着写就又是印刷体。
   参照只看不描。
   ```bash
   python3 scripts/overlay.py my-font.json "白日依山尽" -o ov.png   # 没 Pillow 自动出 SVG
   ```
2. **一笔一条 path，按真实笔顺。** 不连笔、不拆笔，汉字几乎没有 `Z` 闭合的一笔（「日」是四笔，不是一个方框）。
3. **先摆结构再调细节**：左右结构先定分界线，上下结构先定横向分界 —— 分界别放在正中，
   让两块部件一大一小。然后按 `glyphs.md`「骨架要拙」让点和小部件浮起来、折角写尖、钩写短。
4. **写进 JSON**，新字加在字库**末尾**：
   ```json
   {"vb": 64, "sw": 2.8, "over": 0, "items": {
     "今": [
       {"t": "path", "d": "M32 12 C27 21 21 28 13 34", "amp": 0.65},
       {"t": "path", "d": "M20 46.5 H40 Q42 46.5 41.6 48.9 L34.5 60.5", "amp": 0.65, "w": 1.05}
     ]
   }}
   ```
   汉字**每一笔都写 `"amp": 0.65`**；横用 `L` 写（不用 `H`），基本平、偶尔一点点斜；折角用 `L` 写尖；钩短但要看得出。
   拉丁字母在第一笔写 `adv`，`adv = 字面宽 + 5`（左右各留 2.5）。
5. **看，然后问一句：它会不会被读成另一个字？** `gallery` 看多尺寸，对照 `glyphs.md` 的「读成了」表。
   放大好看、缩小散架 = 结构太密，回第 3 步，不要调滤镜参数救。

要拖骨架改字：见 `reference/editor.md`（独立安装时用 Yuragi 网页版编辑、导出 JSON）。

---

## 命令

| 命令 | 做什么 |
|---|---|
| `handdraw.py doctor [--net]` | 检查 Pillow、参照字体、缓存、编辑器 |
| `handdraw.py write geo.json "文字" --no-edit -o t.svg` | 排一行（`/` 断行），`-s` 钉种子 |
| `handdraw.py write geo.json "文字" --candidates 12 -o seeds.html` | 一页看 n 个种子 |
| `handdraw.py compose --han h.json "中文" --latin l.json "English" -o t.svg` | 中英两行合成透明 SVG |
| `handdraw.py lint geo.json [--text "文字"] [--svg t.svg]` | 按清单查字库和交付物 |
| `overlay.py geo.json "文字" [--format svg]` | 骨架叠在黑体、小赖上（没 Pillow 出 SVG） |
| `handdraw.py gallery / vary / svg / json / ts geo.json` | 自检画廊 / 重写变化 / 单字 SVG / 路径导出 |

可选依赖：`python3 -m pip install -r scripts/requirements.txt`（只有 Pillow，给 `overlay.py` 出 PNG）。
小赖没装时 `overlay.py` 第一次运行会下载固定版本（SIL OFL，约 22MB）到 `~/.cache/hand-glyph/fonts`，
校验 SHA-256，不装进系统；`--no-download` 不联网。

---

## 交付前检查

先跑，再看：

```bash
python3 scripts/handdraw.py lint my-font.json --text "文字" --svg title.svg
```

`lint` 查得了：`amp` / `w` / 字面范围 / 可疑的 `Z` / 拉丁 `adv` 边距 / 缺字 / 44px 线宽，以及交付物里的
背景、写死的颜色、渐变滤镜、丢掉的 `stroke-width`。**查不了、必须人看的：**

- [ ] **会不会被读成另一个字？**（对照 `glyphs.md`「读成了」表）
- [ ] 笔画数、笔顺对着黑体数过一遍了吗？一律简体（见/门/画）？
- [ ] 骨架还像字体吗？点都贴着、框大而撑满、折角是圆角、钩又长又标准 = 还不够拙，回去改。
- [ ] 有没有出头？一处都不该有。骨架里端点正好落在另一笔上，字库表头 `"over": 0`。
- [ ] 骨架的线是直的吗（歪的是方向，不是线；没有手改跑出来的坐标）？
- [ ] 点和小部件浮起来的空，中心线至少 4 个单位吗？（线宽两头吃掉 2.8，再小看着还是挨着）
- [ ] 44px（拉丁 28px）上还认得出来吗？亮暗预览各看过一遍吗？
- [ ] 交付物是不是**只有字**？没有自作主张加背景和装饰？

这一轮踩到的坑，回写进 `reference/glyphs.md`：读错的字进「读成了」表，
更好的画法覆盖旧写法并写明旧的为什么不够，被推翻的规矩直接改掉。
