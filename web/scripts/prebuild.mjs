// 前端构建 / dev 之前的步骤（package.json 的 prebuild / predev）：重新打包 Codex 分页的滑杆运行时（build-work-picker.mjs）。
// 公开导出树不带那个脚本与它的源码，这里什么都不做，沿用已提交的 web/public/chatgpt/work-picker.runtime.js。
import { existsSync } from 'node:fs';

const script = new URL('./build-work-picker.mjs', import.meta.url);
if (existsSync(script)) await (await import(script.href)).buildWorkPicker();
