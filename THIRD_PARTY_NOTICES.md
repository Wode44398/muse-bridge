# Third-party notices

Claude Bridge is licensed under the Apache License, Version 2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).
That license covers this project's own code only. The files and packages listed below are distributed under
their own licenses, reproduced in full where the license requires it.

## Not included: Claude Agent SDK and Claude Code

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) and the Claude Code CLI are proprietary software of
Anthropic, PBC, used under Anthropic's own terms. They are not part of this repository and are not covered by its
license. The SDK is installed from npm with the other dependencies; the Claude Code runtime is either taken from
an existing Claude Code installation on the machine or downloaded from the official npm registry the first time
the server starts.

## Fonts

| Shipped as | Source | License | Full text |
|---|---|---|---|
| `harness/web/src/assets/fonts/dimensio-sans-var.woff2` | Inter. Copyright 2020 The Inter Project Authors | SIL Open Font License 1.1 | [harness/web/src/assets/fonts/OFL-Inter.txt](harness/web/src/assets/fonts/OFL-Inter.txt) |
| `harness/web/src/assets/fonts/dimensio-mono-var.woff2` | JetBrains Mono. Copyright 2020 The JetBrains Mono Project Authors | SIL Open Font License 1.1 | [harness/web/src/assets/fonts/OFL-JetBrainsMono.txt](harness/web/src/assets/fonts/OFL-JetBrainsMono.txt) |
| `harness/web/src/assets/fonts/dimensio-serif-600.woff2` | Subset instance (weight 600) of Noto Serif SC. Copyright 2017-2023 Adobe, with Reserved Font Name "Source" | SIL Open Font License 1.1 | [harness/web/src/assets/fonts/OFL-NotoSerifSC.txt](harness/web/src/assets/fonts/OFL-NotoSerifSC.txt) |

## Icons and logos

- **Lucide** — most icons in `harness/web/src/lib/icons.ts`. Copyright (c) Lucide Icons and Contributors, ISC License.
  Icons that Lucide derived from Feather are Copyright (c) 2013-present Cole Bemis, MIT License.
  Full text: [web/public/licenses/LICENSE-Lucide.txt](web/public/licenses/LICENSE-Lucide.txt).
- **LobeHub icons** (`@lobehub/icons-static-svg` 1.96.0) — the model-provider logos in `web/src/lib/providerLogos.js`.
  Copyright (c) 2023 LobeHub, MIT License.
  Full text: [web/public/licenses/LICENSE-lobe-icons.txt](web/public/licenses/LICENSE-lobe-icons.txt).

## Other bundled assets

- **Flux wallpaper** (`web/public/wallpaper/`, WebAssembly build of the fluid simulation). Copyright (c) 2025 DNETGURU,
  MIT License. Full text: [web/public/wallpaper/LICENSE](web/public/wallpaper/LICENSE).
- The app's brand fonts, mascot and marks, glass layers and renderers, activity animations, the Dolomites wallpaper
  and the Codex page are the original visual resources, see "Distribution visual assets" below. The web app has
  only this one visual set; there is no substitute set.

## Bundled code

- **QR Code generator library** by Project Nayuki — `src/runtime/qr.mjs` (the server's QR encoder for pairing codes
  and the command-line `pair` output) is a trimmed port of its encoding core (error-correction tables, Reed–Solomon,
  block interleaving, function patterns, zigzag placement, mask penalties). Copyright (c) Project Nayuki, MIT License,
  <https://www.nayuki.io/page/qr-code-generator-library>. The full license text is kept in the header of that file.

## npm dependencies

Runtime and build dependencies are installed from npm under their own licenses (mostly MIT, BSD-2-Clause,
BSD-3-Clause, Apache-2.0 and ISC). Where a package is dual-licensed, this project uses jszip under MIT and DOMPurify
under Apache-2.0. `sharp` loads libvips as a dynamic library under the LGPL-3.0; its license text ships inside the
`@img/sharp-*` packages.

## Trademarks

Claude and Claude Code are trademarks of Anthropic, PBC. ChatGPT, Codex and OpenAI are trademarks of OpenAI.
Gemini, Google and Vertex AI are trademarks of Google LLC. Other product names and logos are trademarks of their
respective owners. They appear here only to identify the corresponding services. This project is not affiliated
with, endorsed by, or sponsored by Anthropic, OpenAI or Google.

---

中文摘要：本项目代码以 Apache-2.0 授权，只覆盖本项目自己的代码。随附的第三方内容：dimensio 用的字体 Inter、
JetBrains Mono、Noto Serif SC（均为 OFL 1.1）与图标 Lucide（ISC，源自 Feather 的为 MIT）；模型服务商标志取自
LobeHub icons（MIT）；Flux 壁纸（MIT）；界面的原版视觉资源只有一套，保留原有权属（见下方 Distribution visual assets）；服务端二维码编码器 src/runtime/qr.mjs 移植自 Project Nayuki 的 QR Code generator
library（MIT，许可全文见该文件头）。Claude Agent SDK 与 Claude Code 是 Anthropic 的专有软件，不在本仓库内、不受本项目
许可覆盖。商标归各自权利人，仅用于标识对应服务；本项目与 Anthropic、OpenAI、Google 无隶属或背书关系。

## Distribution visual assets

Packaged releases also contain the full frontend visual snapshot under `frontend-assets/` and desktop `visuals/`: fonts, activity animations, glass textures and renderers, wallpaper and the Codex page. These third-party resources retain their original ownership and are not relicensed under the project Apache-2.0 license. `scripts/public/visual-assets.json` records the exact shipped file hashes and source snapshot. It is a build inventory, not a license grant.
