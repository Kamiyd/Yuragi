# Python parity reference

这个目录现在只保留 TypeScript 移植的 Python 对照实现，用来生成并核对标准结果。它不再启动网页服务，也不是当前产品的运行时后端。

```bash
python3 tools/parity/fixtures.py  # 生成对照数据
npm run parity                   # 用 TypeScript 逐项比对
```

当前网页是 Astro + React 静态应用；开发、构建和部署都不需要 Python。`SKILL.md` 和 `docs/` 留有旧版 CLI/服务端工作流的历史说明，不代表当前目录结构或使用方法。当前产品入口与部署说明以仓库根目录的 [README](../README.md) 为准。

旧的 sample 字形 JSON 只由 parity 脚本读取，不进入网页默认工程；其来源和许可状态列在仓库根目录的 [素材来源说明](../ASSET_CREDITS.md)。
