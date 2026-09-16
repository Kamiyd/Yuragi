# hand-glyph

一个 Claude skill：**把一句中文变成手写感的 SVG 字。**

> 「写『今天好心情』」→ 一行手写汉字，每次跑都是新写的一遍

不是找一款手写字体来排，是**一笔一笔画出来的**：每个字默认存一份骨架（笔顺、
笔画数、部件位置），需要可控的第二种写法时可追加 `露2`、`露3` 这样的变体；
排的时候逐字重摇写法，再统一过一遍抖动滤镜。

## 安装

把整个 `hand-glyph/` 文件夹放进：

```
~/.claude/skills/hand-glyph/          个人用（所有项目可用）
<项目>/.claude/skills/hand-glyph/     跟着项目走
```

然后直接说「写『XXX』的手写标题」就会用上。

## 为什么不是字体

字体的字是**写得对**的产物 —— 比例是排字师傅优化过的，每个字一样大、一样满。
手写的字是**画得不准**的产物：偏旁站不正、大小不匀、接头没对上。
这套东西做的是后者。

具体分两层：

- **骨架层**（`vary.py`）—— 每一笔多长、横多高、撇多斜，每次写重摇一遍。
  所以「天天」两个字不一样，不用在字库里存第二种写法。
- **线条层**（`hand.py`，91 行）—— 沿法线叠低频正弦、收笔越位、转角收紧切线。
  确定性的：同一份骨架 + 同一个种子 = 同一条路径。

**手感不是画出来的，是过滤出来的。** 骨架按规规矩矩的样子画（横是平的、
竖是直的、折角是尖的），手感由滤镜统一加 —— 这样加进来的每个字都是同一只手，
而不是每次凭感觉画歪，十个字之后十只手。

## 自己跑

只要 Python 3。没有 npm、没有 `pip install`、不参与任何构建。

**不自带字体，字库是空的。** 每套字都是当场攒的：先在编辑器里把这句话用到的
字画出来（见下一节），存成一份自己的 JSON，再拿它排字。

```bash
python3 scripts/handdraw.py write my-font.json "今天好心情" -o title.svg
python3 scripts/handdraw.py write my-font.json "天天开心/好久不见"   # / 断行
python3 scripts/handdraw.py write my-font.json "今天好心情" -s 42     # 固定某一版
python3 scripts/handdraw.py write my-font.json "今天好心情" --no-edit # 只出图，不开编辑器
```

跑两遍拿到的是两版不同的字。满意了用 `-s` 把那一版钉住。

**`write` 排完会自动把编辑器拉起来**（打印 `http://127.0.0.1:8731/` 并开浏览器），
底下那条行预览预填的就是刚排的这一行和这个种子 —— 生成完直接看、直接改。
批量跑或者写在脚本里加 `--no-edit`；端口被占会自动往后找，`-p` 可以指定。

```bash
python3 scripts/handdraw.py gallery my-font.json -o g.html   # 自检画廊（多尺寸 + 亮暗）
python3 scripts/handdraw.py vary    my-font.json -n 6        # 同一个字写 6 遍，看变化够不够
python3 scripts/handdraw.py svg     geo.json -o out/               # 每个字一个 .svg
python3 scripts/handdraw.py json    geo.json                       # 路径 JSON
python3 scripts/handdraw.py ts      geo.json                       # TypeScript 模块
```

## 在浏览器里改

```bash
python3 scripts/handdraw.py edit my-font.json     # 默认 127.0.0.1:8731
python3 scripts/handdraw.py edit my-font.json --dev   # 调 web/src：页面交给 4321 的 Astro
```

界面是 `web/` 那个 Astro + React 应用，构建产物 `web/dist/` 跟着仓库走 —— 拿来就能开，
不用装 node。改了 `web/src` 要 `cd web && npm run build` 重新出一份再提交。
`--dev` 是显式开关，不会自动嗅探 4321（那上面跑着的不一定是这份 `web/`）。

**真相层是命令行给的那份文件**，界面里没有「新建字库 / 导入 / 下载工程文件」——
换一份就换一条命令。右栏「数据」显示正在写回哪个绝对路径，旁边「重新读取」
用来捡回编辑器之外的改动。

文件不存在就自己建一份空库（64 网格，汉字 `sw 2.8` / 拉丁 `sw 3.4`，
手感 0.9），点左栏加号先创建未命名的空白字形；再输入参考字并点击保存，才写入字形标题。

右栏五根滑杆调整套字的手感（线宽 / 抖动 / 越位 / 大小起伏 / 重写幅度），
存进几何 JSON 的字库上，`write` 出图读同一份；底下另有显示尺寸、种子、重摇。

行预览默认按字库顺序展示所有画法（从 `write` 进入编辑器时则沿用刚排的那句话）。
画布下方的单字输入框用于当前字的参考底图，旁边可选择黑体、宋体或楷体；输入法组字期间允许暂存拼音或多个字符，点击保存时只取第一个字符并收回为单字。左栏加号先创建未命名的空白字形，输入参考字并点击保存后才写入标题，同字自动用 `v2`、`v3` 标记，不再弹出重复字形选择。排句子时会自动轮换这些画法，重复出现次数不限。
全局种子决定整句的可复现版本；选中字形后，右栏「单字种子」可以单独重摇或锁定它，
只影响这个字，局部种子会随字库保存。点击「跟随全局」会暂时取消局部覆盖，
再次关闭跟随时会恢复上一次的单字种子。

右栏的全局手感、全局/单字种子、逐笔参数、颜色与不透明度、排版设置和导出选项都会自动写回 JSON；重新打开编辑器仍会沿用这些配置。

**拖的是抖动前的骨架点，看到的是抖动后的线。** 黑体、宋体、楷体都可作为参考底图，
默认黑体，垫在 64 网格底下对着描，
画布下方可以输入一个参考字，底下一条行预览带逐字大小的相邻差值表。
存盘直接写回同一份几何 JSON —— 没拖过的笔画一个字符都不变。

渲染和路径读写全在 Python 那一侧，浏览器只发骨架点、只收回 path：
没有第二份滤镜实现，预览不可能跟 `handdraw.py` 出的不是同一条线。

## 新版编辑器（Astro + React）

新版界面放在 `web/`：沿用 Sombra 的克制三栏结构（左边字库、中间画布、右边检查器），
用 Astro 做页面壳、React 承载编辑器，用 Radix UI 的 Select / Collapsible / Dialog /
DropdownMenu / Tooltip 做交互原语；滑杆使用同样的可拖拽胶囊式实现，数值可以直接编辑。

渲染仍然只走 Python，几何 JSON 仍然是唯一真相，不在浏览器里复制一份 `hand.py`。

```bash
# 终端 1：启动 Python 数据与渲染 API（8731）
python3 scripts/handdraw.py edit han-sample.json

# 终端 2：开发新版界面（4321；8731 会自动跟随它）
cd web && npm install && npm run dev

# 构建后，默认的 Python 编辑器会优先托管 web/dist
cd web && npm run build
python3 scripts/handdraw.py edit han-sample.json
```

开发版通过 Vite proxy 把 `/api/*` 转给 `127.0.0.1:8731`；开发服务运行时，
`8731` 也会把页面和前端资源转给 `4321`，所以两个地址始终使用同一份源码和 HMR。
如果 `4321` 没启动，`8731` 会回退到 `web/dist`（再回退到旧版 `editor.html`），
生产构建仍可由现有 Python 服务直接托管。

## 目录

```
SKILL.md                 主文档：流程、规格、检查清单
reference/glyphs.md      完整规范：骨架、笔顺、转折半径、排一行、叠字、易读错的字
reference/params.md      滤镜参数表（只在想改整体手感时读）
scripts/handdraw.py      入口：write / edit / vary / gallery / svg / json / ts
scripts/hand.py          抖动滤镜 —— 这支笔本身，91 行
scripts/vary.py          骨架层重写：同一个字每次写出来都不一样（保结构）
scripts/row.py           排一行字：摆正 / 逐字大小 / 相邻差值 / 边界断言
scripts/flatten.py       SVG 图元 -> 折线
scripts/dpath.py         d 串 <-> 可编辑节点表（编辑器用，命令字母原样保留）
scripts/edit.py + editor.html   浏览器编辑器
assets/glyphs.json       空字库模板（单一扁平字库，64 网格 / 线重 2.8）
```

## 产物规格

`viewBox 0 0 64 64`（一字一格）· `fill="none"` · `stroke="currentColor"` ·
`stroke-width 2.8` · `round` cap + join。

颜色跟着父元素走，亮暗主题**不需要两份 SVG**。

## 一条硬限制

**尺寸下限 44px。** 汉字的笔画密度摆在那儿 —— 「情」有 11 笔挤在同一个格子里，
30px 起复杂字开始糊，20px 只剩一团。用在正文尺寸上就别用这支笔。

## 没有 Python 也能用

`SKILL.md` 里有一条纯手写 SVG 的兜底路径（六条路径习语），手感约 80%。
