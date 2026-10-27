// bridge「月桥」图标：生成各平台产物到 out 目录（按目标仓库的相对路径摆放），人工核对后再拷进去。
// 用法：node scripts/brand/build-assets.cjs [输出目录，默认 scripts/brand/out]
// 几何与配色的单一真相在 mark.cjs；16–32px 的像素对齐版在 small.cjs。
// 产物去向：android/…/res（本仓库）、web/public（本仓库）、site/assets（本仓库）、
//          client/installer/assets/bridge-client.ico（桌面客户端工程，在 Vault 的 bridge build 仓库）。
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const { G, IVORY, BG, INK, archD, lineD, reflD, markSVG, tileSVG, f, pt } = require('./mark.cjs');
const { smallSVG } = require('./small.cjs');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, 'out'));
const w = (rel, data) => { const p = path.join(OUT, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, data); return p; };
const png = (svg, size) => sharp(Buffer.from(svg), { density: 72 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer();
const hex = (c, a = 1) => '#' + Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase() + c.replace('#', '').toUpperCase();

// ---------------------------------------------------------------- Android
const reflEndY = f(G.wy + G.R + G.refl / 2);
const androidHeader = (comment) => `<?xml version="1.0" encoding="utf-8"?>\n${comment}\n`;
const androidFg = androidHeader(`<!-- 自适应图标·前景层：bridge「月桥」标记——一道拱、一条水面线、一道渐隐的倒影；
     拱与倒影合成一个完整的圆：你在外面看到的，就是家里那台机器上真实发生的。
     与官网 / 桌面 / 网页图标同一套几何（母版脚本见官网仓库 scripts/brand/）。
     安全区：前景在各家桌面被裁到中心直径 66dp 的圆内（108 画布上以 (54,54) 为心、半径 33）。
     水面线端点 (23,55)/(85,55) 距中心 31，加圆头 1.1 仍 < 33；拱顶外沿距中心 21.7。 -->`)
+ `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">

    <!-- 拱：半圆，平头落在水面上 -->
    <path
        android:pathData="${archD()}"
        android:strokeColor="${hex(IVORY)}"
        android:strokeWidth="${G.arch}" />

    <!-- 水面：比拱宽，两端伸出去，读作「路继续通向两岸」 -->
    <path
        android:pathData="${lineD()}"
        android:strokeColor="${hex(IVORY)}"
        android:strokeWidth="${G.line}"
        android:strokeLineCap="round" />

    <!-- 倒影：同半径的下半圆，离水面留一道缝，自上而下渐隐 -->
    <path
        android:pathData="${reflD()}"
        android:strokeWidth="${G.refl}"
        android:strokeLineCap="round">
        <aapt:attr name="android:strokeColor">
            <gradient
                android:type="linear"
                android:startX="0" android:startY="${G.wy}"
                android:endX="0" android:endY="${reflEndY}">
                <item android:offset="0" android:color="${hex(IVORY, G.r0)}" />
                <item android:offset="1" android:color="${hex(IVORY, G.r1)}" />
            </gradient>
        </aapt:attr>
    </path>
</vector>
`;
const androidBg = androidHeader(`<!-- 自适应图标·背景层：满 108dp 铺底，系统按各家桌面形状遮罩。暖墨色自上而下由亮到暗；
     渐变只拉满可见窗口 (18..90)，让裁切后的明暗与桌面端 / 网页瓦片图标一致。
     与 app 启动底色 #0A0A0A 同族，冷启动不跳色。 -->`)
+ `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="0" android:startY="18"
                android:endX="0" android:endY="90">
                <item android:offset="0" android:color="${hex(BG[0])}" />
                <item android:offset="1" android:color="${hex(BG[1])}" />
            </gradient>
        </aapt:attr>
    </path>
</vector>
`;
const androidMono = androidHeader(`<!-- 自适应图标·单色层（Android 13+ 主题图标）：系统只取 alpha 当遮罩、自己上色。
     形状与前景层一致；倒影不用渐变（单色图标会丢掉渐变），改成统一 ${G.flat} 的透明度。 -->`)
+ `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path
        android:pathData="${archD()}"
        android:strokeColor="#FFFFFFFF"
        android:strokeWidth="${G.arch}" />
    <path
        android:pathData="${lineD()}"
        android:strokeColor="#FFFFFFFF"
        android:strokeWidth="${G.line}"
        android:strokeLineCap="round" />
    <path
        android:pathData="${reflD()}"
        android:strokeColor="#FFFFFFFF"
        android:strokeAlpha="${G.flat}"
        android:strokeWidth="${G.refl}"
        android:strokeLineCap="round" />
</vector>
`;
// 旧桌面（minSdk 24–25，无自适应图标）：自带圆角底，标记缩小一圈留内边距。
const androidLegacy = androidHeader(`<!-- Android 7.x（没有自适应图标）的回落图标：自带圆角暖墨底，标记按 0.8 缩小留内边距。
     几何与自适应图标前景层一致。 -->`)
+ `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">

    <path android:pathData="M26,4 h56 a22,22 0 0 1 22,22 v56 a22,22 0 0 1 -22,22 h-56 a22,22 0 0 1 -22,-22 v-56 a22,22 0 0 1 22,-22 z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="0" android:startY="4"
                android:endX="0" android:endY="104">
                <item android:offset="0" android:color="${hex(BG[0])}" />
                <item android:offset="1" android:color="${hex(BG[1])}" />
            </gradient>
        </aapt:attr>
    </path>

    <group android:scaleX="0.8" android:scaleY="0.8" android:pivotX="54" android:pivotY="54">
        <path
            android:pathData="${archD()}"
            android:strokeColor="${hex(IVORY)}"
            android:strokeWidth="${G.arch}" />
        <path
            android:pathData="${lineD()}"
            android:strokeColor="${hex(IVORY)}"
            android:strokeWidth="${G.line}"
            android:strokeLineCap="round" />
        <path
            android:pathData="${reflD()}"
            android:strokeColor="${hex(IVORY)}"
            android:strokeAlpha="${G.flat}"
            android:strokeWidth="${G.refl}"
            android:strokeLineCap="round" />
    </group>
</vector>
`;
// 通知栏小图标（24dp，纯白 + alpha；系统只认 alpha）。24 网格上重新摆：笔画按小尺寸加粗。
const S = { cx: 12, wy: 12.5, R: 6.2, arch: 2.4, line: 1.2, half: 10, refl: 1.3, gap: 16 };
const sArch = `M${f(S.cx - S.R)},${S.wy} A${S.R},${S.R} 0 0 1 ${f(S.cx + S.R)},${S.wy}`;
const sLine = `M${S.cx - S.half},${S.wy} H${S.cx + S.half}`;
const sa = S.gap * Math.PI / 180;
const sRefl = `M${f(S.cx + S.R * Math.cos(sa))},${f(S.wy + S.R * Math.sin(sa))} A${S.R},${S.R} 0 0 1 ${f(S.cx - S.R * Math.cos(sa))},${f(S.wy + S.R * Math.sin(sa))}`;
const androidStat = androidHeader(`<!-- 通知栏小图标：bridge 月桥标记的 24dp 单色版。状态栏只取 alpha，所以纯白绘制；
     倒影用 0.5 透明度保留层次。取代原先借用的系统聊天气泡 stat_notify_chat。 -->`)
+ `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path android:pathData="${sArch}" android:strokeColor="#FFFFFFFF" android:strokeWidth="${S.arch}" />
    <path android:pathData="${sLine}" android:strokeColor="#FFFFFFFF" android:strokeWidth="${S.line}" android:strokeLineCap="round" />
    <path android:pathData="${sRefl}" android:strokeColor="#FFFFFFFF" android:strokeAlpha="0.5" android:strokeWidth="${S.refl}" android:strokeLineCap="round" />
</vector>
`;
const statSVG = (size, color = '#fff') => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24"><g fill="none" stroke="${color}"><path d="${sArch}" stroke-width="${S.arch}"/><path d="${sLine}" stroke-width="${S.line}" stroke-linecap="round"/><path d="${sRefl}" stroke-width="${S.refl}" stroke-linecap="round" stroke-opacity=".5"/></g></svg>`;

// ---------------------------------------------------------------- ICO
function ico(entries) {            // entries: [{size, buf}] PNG payloads
  const n = entries.length, head = Buffer.alloc(6 + 16 * n);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(n, 4);
  let off = head.length;
  entries.forEach((e, i) => {
    const o = 6 + 16 * i;
    head.writeUInt8(e.size >= 256 ? 0 : e.size, o); head.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    head.writeUInt8(0, o + 2); head.writeUInt8(0, o + 3);
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(e.buf.length, o + 8); head.writeUInt32LE(off, o + 12);
    off += e.buf.length;
  });
  return Buffer.concat([head, ...entries.map(e => e.buf)]);
}

// ---------------------------------------------------------------- 标记 SVG（给网页/官网用）
// currentColor 版：官网导航与页脚用，跟随文字色。
const markCurrent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="20 30 68 50" role="img" aria-label="bridge">
  <defs><linearGradient id="bm-r" x1="0" y1="${G.wy}" x2="0" y2="${reflEndY}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="currentColor" stop-opacity="${G.r0}"/><stop offset="1" stop-color="currentColor" stop-opacity="${G.r1}"/></linearGradient></defs>
  <g fill="none" stroke="currentColor"><path d="${archD()}" stroke-width="${G.arch}"/><path d="${lineD()}" stroke-width="${G.line}" stroke-linecap="round"/><path d="${reflD()}" stroke="url(#bm-r)" stroke-width="${G.refl}" stroke-linecap="round"/></g>
</svg>
`;

(async () => {
  // Android
  const RES = 'android/app/src/main/res';
  w(`${RES}/drawable/ic_launcher_foreground.xml`, androidFg);
  w(`${RES}/drawable/ic_launcher_background.xml`, androidBg);
  w(`${RES}/drawable/ic_launcher_monochrome.xml`, androidMono);
  w(`${RES}/mipmap/ic_launcher.xml`, androidLegacy);
  w(`${RES}/drawable/ic_stat_bridge.xml`, androidStat);

  // Master SVGs
  w('brand/bridge-mark.svg', markCurrent);
  w('brand/bridge-icon.svg', tileSVG(1024, { scale: .9 }));
  w('brand/bridge-icon-bleed.svg', tileSVG(1024, { scale: .86, bleed: true }));

  // Web app (PWA): any = 圆角瓦片透明角；maskable = 满铺，标记缩进安全圆（半径 40%）
  const WEB = 'web/public';
  w(`${WEB}/icons/icon-192.png`, await png(tileSVG(192, { scale: .9 }), 192));
  w(`${WEB}/icons/icon-512.png`, await png(tileSVG(512, { scale: .9 }), 512));
  w(`${WEB}/icons/icon-maskable-192.png`, await png(tileSVG(192, { scale: .8, bleed: true }), 192));
  w(`${WEB}/icons/icon-maskable-512.png`, await png(tileSVG(512, { scale: .8, bleed: true }), 512));
  w(`${WEB}/icons/apple-touch-icon.png`, await png(tileSVG(180, { scale: .88, bleed: true }), 180));
  w(`${WEB}/icons/icon-master.svg`, tileSVG(512, { scale: .9 }));
  w(`${WEB}/favicon.svg`, smallSVG(32).replace('width="32" height="32" ', ''));
  w(`${WEB}/icons/favicon-32.png`, await png(smallSVG(32), 32));

  // Desktop ICO：16–32 用手工对齐版，40 起用母版（标记缩 0.9 留气口）
  const entries = [];
  for (const s of [16, 20, 24, 32]) entries.push({ size: s, buf: await png(smallSVG(s), s) });
  for (const s of [40, 48, 64, 96, 128, 256]) entries.push({ size: s, buf: await png(tileSVG(s, { scale: .9 }), s) });
  w('client/installer/assets/bridge-client.ico', ico(entries));

  // Site
  const SITE = 'site/assets';
  w(`${SITE}/favicon.svg`, smallSVG(32).replace('width="32" height="32" ', ''));
  w(`${SITE}/favicon-32.png`, await png(smallSVG(32), 32));
  w(`${SITE}/icon-180.png`, await png(tileSVG(180, { scale: .88, bleed: true }), 180));
  w(`${SITE}/icon-512.png`, await png(tileSVG(512, { scale: .9 }), 512));
  w(`${SITE}/logo.svg`, markCurrent);

  // 预览：通知小图标
  w('preview/stat-96.png', await png(statSVG(96), 96));
  console.log('done');
})();
