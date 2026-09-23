# 编辑器

## 独立安装时：用 Yuragi 网页版

独立安装的 skill 不带 `web/dist`，`edit` 用不了（`handdraw.py doctor` 会提示）。
要拖骨架改字，用 Yuragi 网页版（[github.com/Kamiyd/Yuragi](https://github.com/Kamiyd/Yuragi)，
`npm ci && npm run dev` 在本地起）：

1. 打开工程 JSON（和这里的几何 JSON 是同一种格式）
2. 拖骨架点改字，行预览里看排进一行的样子
3. 下载工程文件，覆盖回原来的 JSON
4. 回到命令行 `lint` → `write` / `compose`

改完一定跑 `handdraw.py lint`：连成一条的闭合路径、出格的点、漏写的 `amp` 都会被拦。

## 仓库里的 `edit`（带 web/dist 时）

```bash
python3 scripts/handdraw.py edit my-font.json      # 默认 127.0.0.1:8731，-p 换端口
```

文件不存在就自己建一份空库（64 网格，`sw 2.8`，
手感 `amp/jit/vary` 都预设 0.9，越位 `over` 预设 0 —— 拙趣字不出头），点左栏加号先创建未命名的空白字形；输入参考字并保存后才写入字形标题。

**拖的是抖动前的骨架点，看到的是抖动后的线。** 黑体、宋体、楷体都可作为参考底图，
默认黑体；画布下方的单字输入框可输入当前字的参考字，输入法组字期间允许暂存拼音或多个字符，保存时只取第一个字符，
底下一条行预览带逐字大小的相邻差值表。

右栏「整套字的手感」五根滑杆 = 几何 JSON 的字库级字段（`sw` / `amp` / `over` /
`jit` / `vary`，见 `reference/params.md`）—— 拖它们改的是这套字本身，要保存；
下面的显示尺寸、种子、重写开关只是这一次怎么看，不进文件。

渲染和路径读写**全在 Python 那一侧**，浏览器只发骨架点、只收回 path ——
所以不存在「预览跟 `handdraw.py` 出的不是同一条线」。

存盘直接写回同一份几何 JSON，**没拖过的笔画一个字符都不变**。

**真相层是命令行给的那份文件**，所以界面里没有「新建字库 / 导入 / 下载工程文件」——
要换一份就换一条命令。右栏「数据」显示的就是正在写回哪个绝对路径，旁边的
「重新读取」用来捡回编辑器之外的改动（`write` 会写回种子和行文案，手工改 JSON 也常见）。

界面是 `web/` 那个 Astro + React 应用，**构建产物 `web/dist/` 跟着仓库走** ——
拿来就能开，不需要装 node。改了 `web/src` 要重新 build 再提交：

```bash
cd web && npm install && npm run build
python3 scripts/handdraw.py edit my-font.json --dev    # 调前端：页面交给 4321 的 Astro
```

`--dev` 是**显式开关**，不是自动嗅探 —— 4321 上跑着的不一定是这份 `web/`。

**它是用来改错的结构的，不是用来攒变体的。** 一个字存一份正确的骨架就够了 ——
「乐」被读成「朱」那类问题必须在这儿改；而「同一个字的第二种写法」不用管，
那是骨架层每次重摇的事（`handdraw.py vary` 可以看变化够不够）。
