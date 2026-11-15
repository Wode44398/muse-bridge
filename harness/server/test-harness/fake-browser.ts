// 假浏览器：测浏览器池（cdp.ts getBrowser，按会话各开一份）的分配 / 复用 / 回收时不起真进程——把 CdpSession 的启动、
// 关闭、判活换成内存里的开关，跑完原样还回去。每次 launch 记一笔（launched），起来就带一个假标签（挂载状态灯会亮）。
// 要验证真浏览器行为（标签、视口、cookie、隔离上下文）的用例别用它，见 browser-sessions.test.ts。
import { CdpSession } from "../cdp.ts";

type Fake = CdpSession & { fakeAlive?: boolean };

export async function withFakeBrowsers<T>(fn: (launched: CdpSession[]) => Promise<T>): Promise<T> {
  const proto = CdpSession.prototype as unknown as Record<string, unknown>;
  const saved = {
    launch: proto.launch,
    close: proto.close,
    alive: Object.getOwnPropertyDescriptor(CdpSession.prototype, "alive")!,
  };
  const launched: CdpSession[] = [];
  proto.launch = async function (this: Fake) {
    launched.push(this);
    this.fakeAlive = true;
    this.tabs = [{ id: `fake-tab-${launched.length}`, url: "about:blank", title: "", active: true }];
  };
  proto.close = async function (this: Fake) {
    this.fakeAlive = false;
    this.tabs = [];
  };
  Object.defineProperty(CdpSession.prototype, "alive", {
    configurable: true,
    get(this: Fake) {
      return this.fakeAlive === true;
    },
  });
  try {
    return await fn(launched);
  } finally {
    proto.launch = saved.launch;
    proto.close = saved.close;
    Object.defineProperty(CdpSession.prototype, "alive", saved.alive);
  }
}
