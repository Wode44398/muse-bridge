// 统一「保存到本地」入口：<a download>（服务端 Content-Disposition 驱动浏览器下载）。
export async function saveToDisk({ url = '', name = '' } = {}) {
  if (!url) return { ok: false };
  const a = document.createElement('a');
  a.href = url;
  if (name) a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return { ok: true };
}
