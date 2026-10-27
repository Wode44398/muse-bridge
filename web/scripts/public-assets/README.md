# 公开版自带的字体与图形素材

开源后，界面里所有字体、图标、动画、玻璃图层都是可以随源码公开分发的：开源字体（OFL）、开源图标（Lucide，ISC）
或这里的脚本自己画的。生成结果已提交，平时不用重跑；要改素材时改脚本再生成。

| 脚本 | 产出 | 来源 / 许可 |
|---|---|---|
| `build_fonts.py` | `web/src/assets/font/`：Bridge Sans（Inter 原样）、Bridge Serif（Lora 两个母版插值成可变字重并改名）、Bridge Icons（Lucide 放在界面原有的私有区码位上）、Bridge Symbols（Lucide 连字图标，Vertex 分页用）；许可文本写到 `web/public/licenses/`（随产物发布） | Inter / Lora：SIL OFL 1.1；Lucide：ISC（源自 Feather 的图标另为 MIT） |
| `gen_symbols.py` | `web/src/lib/sfSymbols.js`（设置页符号表）、`web/src/lib/menuIconPaths.js`（加号菜单小图标） | Lucide，描边转填充 |
| `gen_glass.py` | `web/src/assets/ios27/`、`web/src/assets/figma-glass/`：控件玻璃图层（3 倍图，尺寸与 CSS 九宫格切片对应）、平滑圆角遮罩 | 自绘 |
| `gen_marks.py` | `web/public/assets/mascot/`（主页小人）、`web/public/assets/icons/workspace.png`（文件夹）；给 `--lobe` 时重写 Claude 标志 `claude-菊花-静态.svg` | 小人、文件夹自绘；Claude 标志取 LobeHub icons（MIT，许可在 `web/public/licenses/LICENSE-lobe-icons.txt`） |

运行时的 Claude 运行标记（`StarMark.svelte`）、Effort 顶档光带（`EffortPanel.svelte` 的 `.ef-charge`）与新对话空态底纹
（`LandingTexture.svelte`）是纯 CSS / SVG，不需要生成。静止的 Claude 标志在 `web/src/lib/claudeMark.js`（LobeHub，MIT）。

## 怎么跑

Python 3.10+，依赖：`pip install fonttools brotli cairosvg contourpy numpy pillow`。

```
python build_fonts.py --lucide <lucide 包目录> --lora <含 Lora-Regular/Bold.ttf 与 Lora-OFL.txt 的目录> --inter <Inter 4 拉丁子集 woff2>
python gen_symbols.py --lucide <lucide 包目录> [--sizes <各符号参考尺寸 json>]
python gen_glass.py
python gen_marks.py [--lobe <@lobehub/icons-static-svg 包>/icons/claude-color.svg]
```

`<lucide 包目录>` 是 npm 包 `lucide`（例如 `npm i lucide@1.8.0` 后的 `node_modules/lucide`）。

## 私有 overlay

维护者自己的部署可以在运行时把这些换成别的素材（同名文件、同一套码位 / 变量），公开构建不变。
机制见 `src/runtime/overlay-web.mjs`（服务端）与 `web/src/lib/overlay.svelte.js`（前端）。
维护者自己出 apk 时 overlay 在构建期打进包里（`web/scripts/overlay-bundle.mjs`），离线壳不从服务器取 overlay 代码。
