import { test } from "node:test";
import assert from "node:assert/strict";
import { CdpSession } from "./cdp.ts";

// 视口的两条真相：谁把它变成像素，以及谁被告知。
//  - headless（自家 Chrome）：CDP 设备指标模拟就是实现。
//  - 桌面壳（真 WebContentsView）：实现是壳按 contain 缩放摆位 + zoomFactor；
//    这里再下一层模拟只会打架（override 比控件大 → 画面钉在左上角被裁，
//    override 撞 zoom → CSS 视口翻倍），所以只记录 + 广播。
function stub(desktop: boolean): { session: CdpSession; sent: string[]; seen: { width: number; height: number }[] } {
  const session = new CdpSession();
  const sent: string[] = [];
  (session as unknown as { send: (m: string) => Promise<unknown> }).send = async (method: string) => {
    sent.push(method);
    return {};
  };
  if (desktop) (session as unknown as { desktopBroker: string }).desktopBroker = "http://127.0.0.1:1/secret";
  const seen: { width: number; height: number }[] = [];
  session.subscribeViewport((v) => seen.push(v));
  return { session, sent, seen };
}

test("headless viewport switch emulates device metrics", async () => {
  const { session, sent, seen } = stub(false);
  await session.setViewport(375, 812, true);
  assert.deepEqual(sent, ["Emulation.setDeviceMetricsOverride"]);
  assert.deepEqual(session.viewport, { width: 375, height: 812 });
  assert.deepEqual(seen, [{ width: 375, height: 812 }]);
});

test("desktop-shell viewport switch records and broadcasts without emulation", async () => {
  const { session, sent, seen } = stub(true);
  await session.setViewport(1280, 900);
  assert.deepEqual(sent, [], "真 WebContentsView 上加设备指标模拟 = 画面被裁");
  assert.deepEqual(session.viewport, { width: 1280, height: 900 });
  assert.deepEqual(seen, [{ width: 1280, height: 900 }], "面板靠广播重新缩放摆位");
});

test("viewport subscribers can unsubscribe", async () => {
  const { session, seen } = stub(true);
  const off = session.subscribeViewport(() => {
    throw new Error("退订后不该再被调用");
  });
  off();
  await session.setViewport(768, 1024);
  assert.equal(seen.length, 1);
});
