// M10（D8）：前后端协议版本号 + 能力位。
//
// 修前：/api/info 不报协议号，前端也不报自己的——离线 apk 装着很久以前的前端、服务端改了事件流形态（M9 就要改），
// 两边谁也不知道对方是哪一版，只能静默出错；前端认「旧后端」靠每次启动挨个探三个端点（其中一个是整页会话列表）。
// 修后：服务端在 /api/info 报 version / minClient / capabilities；前端据此判「我太老了（请更新 App）」「服务端太老了」，
// 有能力位就不再探端点；事件流请求在查询串里报前端的协议号（不用自定义头——跨源预检会失败）。
import assert from "node:assert/strict";
import test from "node:test";
import { CAPABILITIES, MIN_CLIENT, PROTOCOL, protocolInfo } from "./protocol.ts";
import { CLIENT_PROTOCOL, compat, FEATURE_CAPS, featuresFromCaps, MIN_SERVER, withProto } from "../web/src/lib/protocol.ts";

test("M10 服务端报协议号、还服务的最老前端、能力位；这一版的前端与这一版的服务端互相认", () => {
  const info = protocolInfo();
  assert.deepEqual(info, { version: PROTOCOL, minClient: MIN_CLIENT, capabilities: [...CAPABILITIES] });
  assert.ok(PROTOCOL >= 1 && MIN_CLIENT <= PROTOCOL);
  assert.ok(CLIENT_PROTOCOL >= MIN_CLIENT, "同一次提交里的前端必须被同一次提交里的服务端支持");
  assert.ok(PROTOCOL >= MIN_SERVER, "同一次提交里的服务端必须满足同一次提交里的前端");
  for (const cap of FEATURE_CAPS) assert.ok((CAPABILITIES as readonly string[]).includes(cap), `前端按能力位「${cap}」决定功能，服务端却没报`);

  const c = compat({ protocol: info });
  assert.deepEqual(c, { server: PROTOCOL, clientTooOld: false, serverTooOld: false, caps: [...CAPABILITIES] });
  assert.deepEqual(featuresFromCaps(c.caps!), { sessions: true, files: true, projects: true }, "有能力位就不必再探端点");
});

test("M10 兼容判断：M10 之前的后端回退到探测；服务端不再服务这么老的前端 / 服务端比前端要求的还老，都明说", () => {
  // M10 之前的后端：/api/info 里没有 protocol → 协议号 0、没有能力位（调用方回退到逐个探端点）
  assert.deepEqual(compat({ workspace: "/w", tools: [] }), { server: 0, clientTooOld: false, serverTooOld: MIN_SERVER > 0, caps: null });
  assert.deepEqual(compat(null), { server: 0, clientTooOld: false, serverTooOld: MIN_SERVER > 0, caps: null });
  // 形状不对的字段当没报
  assert.deepEqual(compat({ protocol: { version: "2", minClient: -1, capabilities: "sessions" } }), { server: 0, clientTooOld: false, serverTooOld: MIN_SERVER > 0, caps: null });
  // 服务端抬了 minClient（不兼容改动之后不再服务旧前端）→ 这份前端太老
  const future = { protocol: { version: CLIENT_PROTOCOL + 1, minClient: CLIENT_PROTOCOL + 1, capabilities: ["sessions", 7] } };
  assert.deepEqual(compat(future), { server: CLIENT_PROTOCOL + 1, clientTooOld: true, serverTooOld: false, caps: ["sessions"] });
  // 前端要求更新的服务端
  assert.equal(compat({ protocol: protocolInfo() }, CLIENT_PROTOCOL, PROTOCOL + 1).serverTooOld, true);
});

test("M10 事件流请求在查询串里报前端的协议号（不用自定义头：离线 apk 跨源访问 bridge，预检只放行 Content-Type / Authorization）", () => {
  assert.equal(withProto("/api/run"), `/api/run?proto=${CLIENT_PROTOCOL}`);
  assert.equal(withProto("/api/browser/stream?native=1"), `/api/browser/stream?native=1&proto=${CLIENT_PROTOCOL}`);
  assert.equal(withProto("/api/events", 3), "/api/events?proto=3");
});
