// 「手机操控」命令通道端点（设计文档 §2.1）。手机前台服务长轮询取命令、回传结果；
// PC/Claude/前端查在线状态；手机推异步事件（急停）。逻辑都在 runtime/phone-control.mjs，
// 这里只接线（仿 chat.mjs 注册 /api/phone-result 的方式）。鉴权沿用 identify（Bearer/cookie/token）。

import {
  handleControlNext, handleControlResult, handleControlStatus, handleControlEvent, handleControlPreheat,
} from '../runtime/phone-control.mjs';

export function registerPhoneControlRoutes(router, { identify }) {
  router.on('GET', '/api/phone-control/next', (req, res) => handleControlNext(req, res, { identify }));
  router.on('POST', '/api/phone-control/result', (req, res) => handleControlResult(req, res, { identify }));
  router.on('GET', '/api/phone-control/status', (req, res) => handleControlStatus(req, res, { identify }));
  router.on('POST', '/api/phone-control/event', (req, res) => handleControlEvent(req, res, { identify }));
  router.on('POST', '/api/phone-control/preheat', (req, res) => handleControlPreheat(req, res, { identify }));
}
