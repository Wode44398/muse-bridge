// 文档查看 / 编辑器（DocViewer）的插图 / 附件：粘贴、拖入、「插入 ▸ 图片或附件…」的落盘位置与链接写法。
// P 是外壳（DocViewer.svelte）交出来的状态与动作视图，见那边的 P。
import { api } from '../../../lib/api.js';
import { localList, localWriteB64 } from '../../../lib/localfs.js';
import { nativeLocLocalOnly, nativePathForFile } from '../../../lib/nativeDesktop.js';
import { MD_EXT_RE } from '../../../lib/obsmd.js';
import { IS_SHARE } from '../../../lib/share.js';
import { t } from '../../../lib/i18n.js';

export function createDocAttach(P) {
  // —— 插图 / 附件（编辑器粘贴、拖入、「插入 ▸ 图片或附件…」→ mdeditor/attach.js 调这里）——
  // 存放位置照 Obsidian「当前文件夹下的子文件夹」：<笔记目录>/attachments/（没有就建）。手机本地（SAF）
  // 不能建目录：已有 attachments/ 就放进去，否则放笔记同目录。链接写法照 Obsidian「尽可能短」：名单里
  // 这个名字只指向刚存的文件就写裸名，否则带上 attachments/ 前缀，免得认到别处的同名图。
  const ATTACH_DIR = 'attachments';
  async function saveAttachment(file, name) {
    const st = P.cur.saveTarget;
    if (!st || IS_SHARE) throw new Error(t('此文档不可写'));
    const dir = P.dirOf(st.rel);
    let folder, finalName;
    if (st.origin === 'local') {
      if (file.size > 20 * 1024 * 1024) throw new Error(t('手机本地附件不能超过 20MB'));
      const here = localList(dir);
      const hasSub = here.some((f) => f.isDir && f.name === ATTACH_DIR);
      folder = hasSub ? P.joinRel(dir, ATTACH_DIR) : dir;
      const taken = new Set((hasSub ? localList(folder) : here).map((f) => f.name.toLowerCase()));
      finalName = name;
      const dot = name.lastIndexOf('.'), base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
      for (let i = 1; taken.has(finalName.toLowerCase()); i++) finalName = `${base} (${i})${ext}`;   // SAF 同名直接覆盖，先避让
      const b64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result).replace(/^data:[^,]*,/, ''));
        fr.onerror = () => reject(fr.error || new Error(t('读取文件失败')));
        fr.readAsDataURL(file);
      });
      const r = localWriteB64(P.joinRel(folder, finalName), b64);
      if (!r.ok) throw new Error(r.error);
      finalName = r.name || finalName;
    } else {
      if (nativeLocLocalOnly(st.nativeLocation)) throw new Error(t('这个位置暂不支持插入附件'));
      folder = P.joinRel(dir, ATTACH_DIR);
      const id = 'up' + Math.random().toString(36).slice(2, 12), CHUNK = 1024 * 1024;
      const ws = st.ws ? '&ws=' + encodeURIComponent(st.ws) : '';
      for (let off = 0; ; off += CHUNK) {
        const last = off + CHUNK >= file.size ? 1 : 0;
        const r = await api.post(`/api/files/upload?path=${encodeURIComponent(folder)}&id=${id}&last=${last}&mk=1&name=${encodeURIComponent(name)}${ws}`, file.slice(off, off + CHUNK));
        if (last) { finalName = r?.name || name; break; }
      }
    }
    const rel = P.joinRel(folder, finalName);
    // 补全/嵌入名单里补上新文件：embedUrl 立刻认得 ![[它]]（出链要等保存后才重算）
    const entry = { name: finalName, md: false, path: rel, rel: rel.slice(dir ? dir.length + 1 : 0) };
    let names = [];
    try { names = await P.linkNames(); } catch {}
    const clash = P.findInNames(names, finalName);
    // 手机本地的名单只列笔记同目录，放进 attachments/ 的下次打开就认不出裸名 → 一律带前缀
    const link = (clash && clash.path !== rel) || (st.origin === 'local' && folder !== dir) ? entry.rel : finalName;
    for (const list of [names, P.namesNow]) if (list && !list.some((n) => n.path === rel)) list.push(entry);
    return { link, rel };
  }

  // 拖进来的文件本来就在这个工作空间里（桌面端从文件面板 / 资源管理器拖）：不复制，直接写链接（Obsidian
  // 从侧栏拖笔记/附件同款）。绝对路径→相对路径由服务端换算（壳不把位置根的绝对路径给页面）。
  // 笔记目录子树里的写 [[ ]]（同名唯一写裸名，否则带相对笔记目录的路径；md 去扩展名、不嵌入）；
  // 子树外的 [[ ]] 认不到（名单只扫子树），写标准相对链接 ![](../x.png) / [名](../x.md)。
  async function linkExisting(file) {
    const st = P.cur.saveTarget;
    if (!st || st.origin !== 'cloud' || nativeLocLocalOnly(st.nativeLocation)) return null;
    const abs = nativePathForFile(file);
    if (!abs) return null;
    let rel = null;
    try { rel = (await api.post('/api/files/relpaths', { paths: [abs], ws: st.ws || '' }))?.rels?.[0] || null; } catch {}
    if (!rel) return null;
    const dir = P.dirOf(st.rel), name = rel.split('/').pop();
    const md = MD_EXT_RE.test(name), embed = !md && P.ATTACH_RE.test(name) && !/\.(canvas|base)$/i.test(name);
    if (!dir || rel.startsWith(dir + '/')) {
      const sub = dir ? rel.slice(dir.length + 1) : rel;
      const bare = md ? name.replace(/\.[^.]+$/, '') : name;
      let names = [];
      try { names = await P.linkNames(); } catch {}
      const hit = P.findInNames(names, bare);
      const target = hit && hit.path !== rel ? (md ? sub.replace(/\.[^.]+$/, '') : sub) : bare;
      return { text: (embed ? '!' : '') + '[[' + target + ']]' };
    }
    const up = dir.split('/'), down = rel.split('/');
    let k = 0;
    while (k < up.length && k < down.length - 1 && up[k] === down[k]) k++;
    const relPath = [...Array(up.length - k).fill('..'), ...down.slice(k)].join('/').replace(/ /g, '%20');
    return { text: embed ? `![](${relPath})` : `[${md ? name.replace(/\.[^.]+$/, '') : name}](${relPath})` };
  }


  return {
    get ATTACH_DIR() { return ATTACH_DIR; },
    get linkExisting() { return linkExisting; },
    get saveAttachment() { return saveAttachment; },
  };
}
