// dimensio 前端（@hx）的接口接到 bridge：基址 /api/harness（每次求值走 apiUrl()，换线路自动跟上）+ bridge 的鉴权头。
// 放在模块顶层、导入即生效：dimensio 分页（HarnessPage）和设置里的 dimensio 一节（SecDimensio）都 import 它——
// 以前写在 HarnessPage 组件里，分页没挂载过就从主页打开设置，那一节的请求打到错的地址（404）。
import { configureApi } from '@hx/lib/api.ts';
import { apiUrl } from './server.js';
import { authHeaders } from './api.js';

configureApi({
  base: () => apiUrl('/api/harness'),
  headers: () => authHeaders(),
});
