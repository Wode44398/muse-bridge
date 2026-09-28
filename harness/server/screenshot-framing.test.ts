// U5（MiMo 反馈）：Browser(screenshot) 的取景与等待。
//
// 修前：截图只能截整个视口，而且立刻取帧——切页、点完按钮马上截，拍到的是旧页或动画的半截（MiMo 的 B 会话
// 「切页后截图拍到旧页」就是这个）；想看一个元素只能截整屏再自己找。
// 修后：默认先等有限长的动画与字体（≤ 3 秒）；waitMs:0 立刻截；selector / ref / clip 只截一块（元素不在视口里先滚进来）。
//
// 真起本机 Chrome/Edge（Windows 以外或没装浏览器就跳过）。像素用仓库根的 sharp 解码。
import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { getSharedBrowser } from "./cdp.ts";
import { findBrowser } from "./headless.ts";
import { imageDimensions } from "./image-assets.ts";
import { Sandbox } from "./sandbox.ts";
import { browserTool } from "./tools/browser.ts";
import type { ToolContext } from "./tools/types.ts";

const skip = process.platform !== "win32" || !findBrowser() ? "需要 Windows + 本机 Chrome/Edge" : false;

const ctx: ToolContext = {
  sandbox: new Sandbox(os.tmpdir(), "workspace"),
  readFileState: new Map(),
  setTodos: () => {},
  limits: { bashTimeoutMs: 5_000, bashMaxTimeoutMs: 5_000 },
  agentSeesImages: true,
};

type Raw = { data: Buffer; info: { width: number; height: number; channels: number } };
type SharpLike = (b: Buffer) => { raw(): { toBuffer(o: { resolveWithObject: true }): Promise<Raw> } };
const SHARP = "sharp"; // 模块名走变量：sharp 的 exports 没挂类型，别让 tsc 去解析它
// 取 (x, y) 处的像素；不给坐标取正中
async function pixel(png: Buffer, x?: number, y?: number): Promise<[number, number, number]> {
  const sharp = ((await import(SHARP)) as { default: SharpLike }).default;
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const i = ((y ?? Math.floor(info.height / 2)) * info.width + (x ?? Math.floor(info.width / 2))) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
}

const PAGE =
  "data:text/html," +
  encodeURIComponent(`<!doctype html><title>u5</title><style>
    body{margin:0;height:3000px}
    #box{position:absolute;left:40px;top:30px;width:120px;height:80px;background:rgb(255,0,0)}
    #box.go{animation:paint 800ms linear forwards}
    #box.slow{animation:paint 4000ms linear forwards}
    @keyframes paint{to{background:rgb(0,0,255)}}
    #far{position:absolute;top:2400px;left:10px;width:50px;height:40px;background:rgb(0,128,0)}
    #b{position:absolute;left:300px;top:40px;width:90px;height:30px}
  </style><div id=box></div><div id=far></div><button id=b>Go</button>`);

async function shoot(args: Record<string, unknown>) {
  const r = await browserTool.run({ action: "screenshot", ...args }, ctx);
  const img = r.feedback?.find((b) => b.t === "image") as { data: string } | undefined;
  const png = img ? Buffer.from(img.data, "base64") : null;
  return { r, png, dims: png ? imageDimensions(png) : null, text: r.content.map((b) => ("text" in b ? b.text : "")).join("\n") };
}

test("U5 截图只截一块：selector / ref / clip；视口外的元素先滚进来；找不到的元素说清楚", { skip, timeout: 120_000 }, async () => {
  const s = await getSharedBrowser();
  try {
    await s.navigate(PAGE, 200);
    const box = await shoot({ selector: "#box" });
    assert.equal(box.r.ok, true, box.text);
    assert.deepEqual(box.dims, { width: 120, height: 80 }, "只截 #box（修前是整个视口）");
    assert.match(box.text, /element "#box", 120×80 px image/);

    const clip = await shoot({ clip: { x: 40, y: 30, width: 60, height: 40 } });
    assert.deepEqual(clip.dims, { width: 60, height: 40 });
    assert.deepEqual(await pixel(clip.png!), [255, 0, 0], "clip 落在 #box 上");

    const far = await shoot({ selector: "#far" });
    assert.deepEqual(far.dims, { width: 50, height: 40 });
    assert.deepEqual(await pixel(far.png!), [0, 128, 0], "视口外的元素滚进来再截");

    await s.axSnapshot();
    let ref = 0;
    for (let i = 1; i <= 20 && !ref; i++) {
      try {
        if (s.refInfo(i).role === "button") ref = i;
      } catch {
        break;
      }
    }
    assert.ok(ref, "ReadPage 给按钮分了 ref");
    const btn = await shoot({ ref });
    assert.deepEqual(btn.dims, { width: 90, height: 30 });

    const none = await shoot({ selector: "#nope" });
    assert.equal(none.r.ok, false);
    assert.match(none.text, /no element matches selector "#nope"/);
    const both = await shoot({ selector: "#box", clip: { x: 0, y: 0, width: 10, height: 10 } });
    assert.equal(both.r.ok, false);
  } finally {
    await s.close();
  }
});

test("U5 截图默认等动画跑完；waitMs:0 立刻截（就要半截那一帧）", { skip, timeout: 120_000 }, async () => {
  const s = await getSharedBrowser();
  try {
    await s.navigate(PAGE, 200);
    // 整个视口截（不依赖取景），看 #box 里的一点 (100, 70)
    await s.eval("document.getElementById('box').classList.add('go')"); // 800ms 从红变蓝
    const settled = await shoot({});
    const [r, , b] = await pixel(settled.png!, 100, 70);
    assert.ok(b > 240 && r < 15, `等动画跑完才截：应是终态的蓝，实际 rgb(${r},…,${b})（修前立刻截，是半截的红）`);
    assert.match(settled.text, /Waited \d+ ms for animations/);

    await s.eval("const e = document.getElementById('box'); e.classList.remove('go'); void e.offsetWidth; e.classList.add('slow')"); // 4 秒
    const now = await shoot({ waitMs: 0 });
    const [r2, , b2] = await pixel(now.png!, 100, 70);
    assert.ok(r2 > b2, `waitMs:0 不等：应还是偏红的半截，实际 rgb(${r2},…,${b2})`);
    assert.match(now.text, /Captured immediately \(waitMs:0\)/);
  } finally {
    await s.close();
  }
});
