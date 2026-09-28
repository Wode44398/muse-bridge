// Claude 编辑文件的实时信号：SSE {type:'fs', path} → 打开中的文档查看器自动跟盘。
// path 是服务端绝对路径；前端只有 (ws, rel)，所以匹配走「rel 后缀 + ws 前缀」：
// 归一化（反斜杠→斜杠、小写折叠，Windows 大小写不敏感）后，事件路径以 /rel 结尾即命中；
// 有 ws 时再要求前缀落在 ws 下，避免同名文件误刷。

export const fsChange = $state({ seq: 0, path: '' });

export function noteFsChange(path) {
  const p = String(path || '');
  if (!p) return;
  fsChange.path = p;
  fsChange.seq++;
}

const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function fsMatches(evPath, { ws = '', rel = '' } = {}) {
  const ev = norm(evPath), r = norm(rel);
  if (!ev || !r) return false;
  if (ev !== r && !ev.endsWith('/' + r)) return false;
  const w = norm(ws);
  if (w && !(ev === w + '/' + r || ev.startsWith(w + '/'))) return false;
  return true;
}
