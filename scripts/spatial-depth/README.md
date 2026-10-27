# 空间壁纸 · 深度图生成

「空间壁纸」（景深视差壁纸）给静态壁纸叠一层深度视差：电脑指针跟随、手机重力（陀螺仪）跟随。
只有内置默认壁纸的深度图由本目录脚本**随包预生成**为静态资源；运行时不跑任何 Python / 模型。
上传壁纸的深度图由用户上传时随附（同时选中原图 + 文件名带 depth 的深度图，后端 `/api/wallpaper/depth`），
没附就没有空间壁纸选项——服务端不再代为生成。想给自己的照片做深度图，可以本机用 `gen_depth.py` 单张跑。

## 资源位置

- 深度图：`web/public/assets/wallpapers/depth/<id>.png`（白=近、黑=远）
  - 这是 **dev/源** public 目录；`npm run build` 会拷进 `public/app`，apk 也打包它。
  - **别**往 `public/app/...` 手放（那是 build 输出，`emptyOutDir` 每次构建清空）。

## 前端接线

- `web/src/lib/wallpaper.svelte.js` — `SPATIAL_IDS` / `wpDepthUrl()` / `spatial` 状态（明暗系统各存开关+幅度，localStorage 持久）
- `web/src/components/SpatialLayer.svelte` — WebGL 迭代式反向 warp 视差层（替代静态 `<img>`；玻璃 UI 照常折射它）
- `web/src/components/Home.svelte` — `spatialOn` 时渲染 `<SpatialLayer>`
- `web/src/components/Settings.svelte` — 实景舞台里的「空间壁纸」开关 + 「景深运动幅度」滑条（仅静态壁纸显示，flux 等动态壁纸不显示）

## 内置「层峦」壁纸（自有素材）

`gen-ridges.mjs` 用固定种子程序化生成壁纸本体和深度图（白=近、黑=远），两者按同一组图层轮廓线渲染、分界完全重合，
不用深度模型。重跑字节级一致：

```
node scripts/spatial-depth/gen-ridges.mjs            # 写 web/public/assets/wallpapers/ridges.jpg + depth/ridges.png
node scripts/spatial-depth/gen-ridges.mjs --demo     # 另写 web/demo/particle-reveal/ 的 bg.jpg + depth.png
node scripts/spatial-depth/gen-ridges.mjs --preview <目录>   # 小尺寸试渲染，调参用
```

2026-10-22 起替换来源不明的多洛米蒂照片（home-bg.jpg / depth/dolomites.png，已删除；公开仓的素材闸门按内容哈希拦着它们）。

## 重新生成（加/换照片类壁纸时）

依赖本机的 Depth Anything V2 安装（路径见 `gen_depth.py` 顶部）。用该仓库的 venv python 跑：

```
<DepthAnything-venv>\python.exe scripts\spatial-depth\gen_bridge_depth.py
```

加新壁纸：把源图放进 `web/public/...`，在 `gen_bridge_depth.py` 的 `SRC` 和
`wallpaper.svelte.js` 的 `SPATIAL_IDS` 各加一条，重跑本脚本。
