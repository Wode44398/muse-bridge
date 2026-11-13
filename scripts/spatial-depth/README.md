# 空间壁纸 · 深度图生成

「空间壁纸」（景深视差壁纸）给静态壁纸叠一层深度视差：电脑指针跟随、手机重力（陀螺仪）跟随。
只有内置默认壁纸的深度图由本目录脚本**随包预生成**为静态资源；运行时不跑任何 Python / 模型。
上传壁纸的深度图由用户上传时随附（同时选中原图 + 文件名带 depth 的深度图，后端 `/api/wallpaper/depth`），
没附就没有空间壁纸选项——服务端不再代为生成。想给自己的照片做深度图，可以本机用 `gen_depth.py` 单张跑。

## 资源位置

- 内置壁纸（多洛米蒂）的原图与深度图是原版资源：私有 overlay 的 `web/wallpapers/`（`dolomites.jpg`、`depth/dolomites.png`），
  构建时随其它原版资源打进 `/app/_ov/`，前端经 `ovUrl()` 取。仓库里不放壁纸素材。

## 前端接线

- `web/src/lib/wallpaper.svelte.js` — `SPATIAL_IDS` / `wpDepthUrl()` / `spatial` 状态（明暗系统各存开关+幅度，localStorage 持久）
- `web/src/components/SpatialLayer.svelte` — WebGL 迭代式反向 warp 视差层（替代静态 `<img>`；玻璃 UI 照常折射它）
- `web/src/components/Home.svelte` — `spatialOn` 时渲染 `<SpatialLayer>`
- `web/src/components/Settings.svelte` — 实景舞台里的「空间壁纸」开关 + 「景深运动幅度」滑条（仅静态壁纸显示，flux 等动态壁纸不显示）

## 重新生成（加/换照片类壁纸时）

依赖本机的 Depth Anything V2 安装（路径见 `gen_depth.py` 顶部）。用该仓库的 venv python 跑：

```
<DepthAnything-venv>\python.exe scripts\spatial-depth\gen_bridge_depth.py
```

加新壁纸：把源图与生成的深度图放进私有 overlay 的 `web/wallpapers/`，在 `gen_bridge_depth.py` 的 `SRC` 和
`wallpaper.svelte.js` 的 `SPATIAL_IDS` 各加一条，重跑本脚本。
