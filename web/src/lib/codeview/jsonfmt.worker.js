// JSON 格式化 Worker：大文件的 JSON.parse + stringify 挪出主线程（见 jsonfmt.js formatJsonAsync）
self.onmessage = (e) => {
  let out = null;
  try { out = JSON.stringify(JSON.parse(e.data), null, 2); } catch {}
  self.postMessage(out);
};
