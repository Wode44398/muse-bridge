# dimensio for Edge / Chrome

让 dimensio 连上你自己的 Edge 或 Chrome（两个都装也行）：用你已登录的网站、Cookie 和扩展，在「dimensio」标签组里看页面、点击、输入。

## 安装（一次）

1. Edge 地址栏打开 `edge://extensions`（Chrome 是 `chrome://extensions`），打开「开发人员模式」。
2. 「加载解压缩的扩展」，选这个文件夹（`harness/edge-extension`）。
3. 点工具栏上的 dimensio 图标：显示「已连接 dimensio」就好了（本机的 dimensio 要在运行）。

扩展 ID 固定为 `clnfofamdiidpmecdcnalogcmfpnelce`（manifest 里写死了 `key`），dimensio 只接受这个 ID 的连接。
以后这个文件夹里的文件更新了，扩展连上 dimensio 时会发现版本号对不上，自己重载一次。

## 用起来是什么样

- **授权 = 标签组。** dimensio 只能操作「dimensio」标签组里的标签：它自己开的标签会进组；你想让它看某个页面，就把那个标签拖进组（或在弹窗里点「把这个标签交给 dimensio」）；拖出组 / 关掉就收回。
- **组标题就是状态：** `dimensio`（已连接，灰）、`dimensio · 操作中`（红）、`dimensio · 未连接`、`dimensio · 已暂停`。
- **页面上：** 它在操作时，视口四边亮起一圈朱色的光，底部出现「dimensio 正在操作此页 · 停止」；它的指针是墨色箭头带一个「dimensio」小签，先走到目标再点。agent 自己截图时这一层会先藏起来，截图里没有。
- **叫停：** 页面上的「停止」、弹窗里的「停止 dimensio」、或 Edge 顶部「正在调试此浏览器」提示条上的「取消」，都会停掉正在用浏览器的那一轮对话并断开。弹窗右上角的开关关掉 = 完全不连。
- 浏览器自己的页面（`edge://`、扩展商店）不能被附着。

## 机制

```
dimensio 的 Browser/ReadPage/Eval/Network 工具
   └─ cdp.ts（Edge 模式：频道就是一个 WebSocket 形状的对象）
        └─ edge-link.ts  ws://127.0.0.1:8799/edge-link（只认本扩展的 Origin）
             └─ background.js  chrome.debugger.sendCommand → 标签页
                               chrome.tabs / tabGroups → 模拟 Target 域（新建 / 关闭 / 切换 / 发现标签）
                               overlay.js → 氛围灯、指针、停止按钮
```

在 dimensio 里，agent 用 `Browser(action:"edge", browser:"edge"|"chrome")` 切到你的 Edge 或 Chrome（两个都连着时必须指定；扩展连接时带 `?browser=` 自报种类，dimensio 每种浏览器各留一条链路、互不顶替），`Browser(action:"close")` 断开（标签留给你）。
Edge 模式下不做视口模拟（`resize` / `dprprobe` 会拒绝）——那是你正在看的窗口。

连接地址默认 `ws://127.0.0.1:8799/edge-link`，弹窗的「连接设置」里能改端口（只允许本机地址）。

## 测试

- `server/edge-link.test.ts`：链路协议（Origin 闸、握手、频道、RPC、氛围灯、断开、顶替），随 `npm test` 跑。
- `server/edge-tool.smoke.ts`：手动冒烟，真 Edge + 真扩展走 Browser 工具全路径（文件头有用法）。
