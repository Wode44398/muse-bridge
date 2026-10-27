// i18n-ignore-file（开发专用 mock，不翻译）
// dev-only 桌面壳 mock：`npm run dev` 下访问 http://127.0.0.1:5173/?fdmock 时，
// 在 window 上装一个内存假文件系统版 BridgeDesktop，让 FilesDesktop（桌面工作空间）
// 能在 preview 浏览器里活体验证（真 IPC 只在 Electron 壳里存在）。必须在 main.js
// 最顶部第一个 import——nativeDesktop.js 在模块加载时就快照 window.BridgeDesktop。
// import.meta.env.DEV 守卫：prod 构建整段死代码消除，线上 bundle 不含任何 mock。
//
// `?fdmock=panel`：装同一套假 IPC，但让 App 走【手机版 FilesPanel】而不是 FilesDesktop。
// 桌面壳里 FilesPanel 也会带着 desktopNative=true 跑（Claude 工作台的「文件」工具、
// Codex 侧边工作区都是这条路），而这条路以前在预览里根本没法验——2026-08-26 最近栏
// 图标被拉伸裁切的 bug 就是从这个缝里漏出去的。
if (import.meta.env.DEV && typeof window !== 'undefined' && new URLSearchParams(location.search).has('fdmock')) {
  if (new URLSearchParams(location.search).get('fdmock') === 'panel') window.__FD_MOCK_PANEL = true;
  // `?fdmock=embed&w=420`：把 FilesDesktop 按【工作台侧栏内嵌形态】挂在一根可指定宽度的右列里
  // （并画出 Claude 顶栏胶囊的占位），专验窄列工具栏分档 / 面包屑折叠 / 暗色主题。
  if (new URLSearchParams(location.search).get('fdmock') === 'embed') window.__FD_MOCK_EMBED = true;
  const now = Date.now();
  const H = 3600e3, D = 24 * H;
  let seq = 0;
  const file = (name, size, age, content = '') => ({ name, isDir: false, size, mtime: now - age, content });
  const dir = (name, children = [], age = 2 * D) => ({ name, isDir: true, size: 0, mtime: now - age, children });

  const primaryTree = dir('', [
    dir('bridge构建', [
      dir('bridge前端设计', [file('工作空间页面demo.html', 48213, 20 * D, '<h1>demo</h1>'), file('说明.md', 1892, 21 * D, '# 设计说明\n\ntoken 实测自 UI Kit')]),
      file('架构笔记.md', 5210, 3 * H, '# 架构\n\n- 主进程持有权限\n- renderer 只用位置 ID'),
      file('todo.txt', 322, 26 * H, '1. 桌面重制\n2. 拖拽导入'),
    ], 3 * H),
    dir('截图', Array.from({ length: 14 }, (_, i) => file(`screenshot-${String(i + 1).padStart(2, '0')}.png`, 220e3 + i * 31e3, i * 7 * H)), 5 * H),
    dir('视频素材', [file('开场动画.mp4', 48e6, 6 * D), file('转场.mov', 22e6, 8 * D)]),
    dir('文档', [file('季度总结.docx', 88e3, 30 * H), file('数据.xlsx', 44e3, 4 * D), file('说明书.pdf', 1.2e6, 9 * D)]),
    dir('node_modules', [file('干扰项.js', 100, 90 * D)], 90 * D),
    file('README.md', 2450, 1 * H, '# The Bridge 工作空间\n\n桌面版验证用假数据。'),
    file('发布清单.md', 980, 5 * H, '- [x] 构建\n- [ ] 验收'),
    file('banner.png', 512e3, 2 * H),
    file('头像.jpg', 96e3, 40 * H),
    file('logo.svg', 8e3, 3 * D, '<svg></svg>'),
    file('客户端.zip', 9.4e6, 50 * H),
    file('安装器.exe', 82e6, 6 * D),
    file('启动.bat', 210, 12 * D, '@echo off'),
    file('config.json', 1290, 30 * 60e3, '{\n  "port": 8787\n}'),
    file('server.log', 4.2e6, 10 * 60e3, 'log line\n'.repeat(20)),
    // 点开头的目录/文件：资源管理器照常显示它们，工作空间也该显示（回归样张）
    dir('.Root', [dir('.gam', [file('save.dat', 40960, 3 * H)], 4 * H), file('.env', 220, 5 * H, 'KEY=1')], 4 * H),
  ], H);
  const downloadsTree = dir('', [
    file('电子书.epub', 3.1e6, 2 * D),
    file('壁纸-4k.png', 6.6e6, 26 * H),
    file('样例数据.csv', 88e3, 3 * D, 'a,b\n1,2'),
    dir('旧安装包', [file('bridge-setup-2026.07.12.exe', 91e6, 12 * D)]),
  ], 2 * H);

  // 整盘位置（真机上用户常把 C:\\ D:\\ E:\\ 整个加进来）：会话目录在库外时，工作台侧栏按绝对路径落到这里
  const driveDTree = dir('', [
    dir('Projects', [
      dir('media', [
        dir('01_订阅性价比', [file('脚本.md', 3200, 5 * H, '# 订阅性价比'), file('封面.png', 380e3, 6 * H)], 5 * H),
        dir('02_国产性价比反常识', [file('提纲.md', 1800, 2 * H, '# 提纲')], 2 * H),
      ], 2 * H),
      dir('claude-bridge', [file('package.json', 900, 3 * D, '{}')], 3 * D),
    ], 2 * H),
    dir('Games', [], 40 * D),
  ], 2 * H);
  // abs：根的绝对路径（真壳的位置列表不带它，FilesDesktop 走 inspect('') 取；mock 照同一口径回）
  const locations = [
    { id: 'primary', name: 'bridge-vault', abs: 'C:\\MockVault', removable: false, tree: primaryTree },
    { id: 'loc-aaaaaaaaaaaaaaaa', name: '下载', abs: 'C:\\Users\\mock\\Downloads', removable: true, tree: downloadsTree },
    { id: 'loc-dddddddddddddddd', name: 'D:\\', abs: 'D:\\', removable: true, tree: driveDTree },
  ];
  const locOf = (id) => {
    const hit = locations.find((l) => l.id === (id || 'primary'));
    if (!hit) throw new Error('工作区位置未获授权');
    return hit;
  };
  const split = (rel) => String(rel || '').split('/').filter(Boolean);
  const absOf = (loc, rel) => (split(rel).length ? loc.abs.replace(/\\$/, '') + '\\' + split(rel).join('\\') : loc.abs);
  function nodeAt(tree, rel) {
    let cur = tree;
    for (const seg of split(rel)) {
      if (!cur?.isDir) return null;
      cur = (cur.children || []).find((c) => c.name === seg) || null;
    }
    return cur;
  }
  function parentAt(tree, rel) {
    const parts = split(rel);
    return { parent: nodeAt(tree, parts.slice(0, -1).join('/')), name: parts[parts.length - 1] || '' };
  }
  const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'];
  const extOf = (n) => (n.split('.').pop() || '').toLowerCase();
  function thumbDataUrl(name, size) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    let h = 0;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    g.fillStyle = `hsl(${h % 360} 70% 78%)`;
    g.fillRect(0, 0, size, size);
    g.fillStyle = `hsl(${(h + 120) % 360} 65% 55%)`;
    g.beginPath(); g.arc(size * 0.62, size * 0.4, size * 0.24, 0, 7); g.fill();
    g.fillStyle = `hsl(${(h + 200) % 360} 60% 45%)`;
    g.beginPath(); g.moveTo(0, size); g.lineTo(size * 0.55, size * 0.45); g.lineTo(size, size); g.closePath(); g.fill();
    return c.toDataURL('image/png');
  }
  // 非图片文件的「系统图标」：Windows 上 createThumbnailFromPath 对没有缩略图提供程序的
  // 类型会失败，主进程回落 app.getFileIcon —— 而 Electron 在 Windows 上 large/normal 都只有
  // **32×32**。mock 以前对这类文件一律返回空 dataUrl，于是最近栏/文件行的图标问题在
  // 预览浏览器里永远复现不出来（真机上却是每个文档都走这条路）。这里如实照做。
  const ICON_PX = 32;
  function iconDataUrl(name) {
    const c = document.createElement('canvas');
    c.width = c.height = ICON_PX;
    const g = c.getContext('2d');
    const s = ICON_PX;
    // 一张 32px 的「文档纸 + 折角 + 几行字」，形状和 Windows 的通用文档图标同构
    g.fillStyle = '#fff'; g.strokeStyle = '#9aa0a6'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(s * 0.19, s * 0.09); g.lineTo(s * 0.62, s * 0.09); g.lineTo(s * 0.81, s * 0.28);
    g.lineTo(s * 0.81, s * 0.91); g.lineTo(s * 0.19, s * 0.91); g.closePath();
    g.fill(); g.stroke();
    g.fillStyle = '#c9ccd1';
    g.beginPath(); g.moveTo(s * 0.62, s * 0.09); g.lineTo(s * 0.81, s * 0.28); g.lineTo(s * 0.62, s * 0.28); g.closePath(); g.fill();
    g.fillStyle = '#b0b4b9';
    for (let i = 0; i < 4; i++) g.fillRect(s * 0.28, s * 0.4 + i * s * 0.13, s * 0.44, s * 0.06);
    return c.toDataURL('image/png');
  }

  const listeners = new Set();
  function emit(locationId, rel) {
    dirSizeSeen.clear();   // 任何变化都让 mock 的大小缓存作废（真壳按路径精确作废）
    const dir2 = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    for (const fn of listeners) { try { fn({ locationId, type: 'rename', path: rel, dir: dir2, at: Date.now() }); } catch {} }
  }
  const toItem = (node, rel) => ({
    name: node.name, isDir: node.isDir, size: node.isDir ? 0 : node.size, mtime: node.mtime,
    ctime: node.mtime, linkType: '', linkTarget: '', rel,
  });
  function walk(tree, base, out) {
    for (const c of tree.children || []) {
      const rel = base ? base + '/' + c.name : c.name;
      out.push(toItem(c, rel));
      if (c.isDir) walk(c, rel, out);
    }
  }
  const uniqueName = (parent, want) => {
    const names = new Set((parent.children || []).map((c) => c.name));
    if (!names.has(want)) return want;
    const dot = want.lastIndexOf('.');
    const stem = dot > 0 ? want.slice(0, dot) : want, ext = dot > 0 ? want.slice(dot) : '';
    for (let i = 2; ; i++) if (!names.has(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`;
  };
  const delay = (v) => new Promise((r) => setTimeout(() => r(v), 18 + Math.random() * 40));
  const dirSizeListeners = new Set();
  const dirJobs = {};
  const dirSizeSeen = new Set();
  let mockClip = { paths: [], cut: false, ours: false };
  const deepClone = (node) => ({ ...node, children: node.children?.map(deepClone) });

  window.BridgeDesktop = Object.freeze({
    platform: 'win32',
    app: { version: async () => 'fdmock', showInFolder: async () => ({}), openExternal: async () => ({}) },
    workspace: {
      async list(rel = '', locationId = 'primary') {
        const loc = locOf(locationId);
        const node = nodeAt(loc.tree, rel);
        if (!node?.isDir) throw new Error('目录不存在');
        const items = (node.children || []).map((c) => toItem(c, rel ? rel + '/' + c.name : c.name));
        items.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'zh-CN'));
        return delay({ path: split(rel).join('/'), locationId: loc.id, items, truncated: false, native: true });
      },
      async locations() { return delay(locations.map(({ tree: _t, abs: _a, ...l }) => ({ ...l, lastOpenedAt: 0 }))); },
      async addLocation() {
        const id = 'loc-' + String(++seq).padStart(16, 'b');
        const name = `新位置 ${seq}`;
        locations.push({ id, name, abs: 'C:\\Mock\\' + name, removable: true, tree: dir('', [file('说明.txt', 120, H, '来自 mock')]) });
        return delay({ canceled: false, location: { id, name, removable: true } });
      },
      async removeLocation(id) {
        const i = locations.findIndex((l) => l.id === id && l.removable);
        if (i >= 0) locations.splice(i, 1);
        return delay({ ok: true });
      },
      async mkdir(rel, name, locationId = 'primary') {
        const loc = locOf(locationId);
        const node = nodeAt(loc.tree, rel);
        if (!node?.isDir) throw new Error('目录不存在');
        if ((node.children || []).some((c) => c.name === name)) throw new Error('同名文件或文件夹已存在');
        node.children.push(dir(name, [], 0));
        emit(loc.id, rel ? rel + '/' + name : name);
        return delay({ ok: true, name });
      },
      async createFile(rel, name, content = '', locationId = 'primary') {
        const loc = locOf(locationId);
        const node = nodeAt(loc.tree, rel);
        if (!node?.isDir) throw new Error('目录不存在');
        if ((node.children || []).some((c) => c.name === name)) throw new Error('同名文件或文件夹已存在');
        node.children.push(file(name, new Blob([String(content)]).size, 0, String(content)));
        emit(loc.id, rel ? rel + '/' + name : name);
        return delay({ ok: true, name });
      },
      // 系统「创建存档」向导：mock 里没有窗口，停 0.8s 当作用户点了「创建」，同目录落一个 <名>.zip；
      // window.__fdmockWizard = 'cancel' 模拟点取消（回空 archive）
      async compressWizard({ rels = [], locationId = 'primary' } = {}) {
        const loc = locOf(locationId);
        const first = rels[0] || '';
        const parentRel = first.includes('/') ? first.slice(0, first.lastIndexOf('/')) : '';
        const parent = nodeAt(loc.tree, parentRel);
        await new Promise((r) => setTimeout(r, 800));
        if (window.__fdmockWizard === 'cancel') return { ok: true, archive: '' };
        if (window.__fdmockWizard === 'fail') return { ok: false, error: 'mock：向导起不来' };   // 看退回内置选项那条路
        const stem = rels.length === 1 ? first.split('/').pop().replace(/\.[^.]+$/, '') : (parentRel.split('/').pop() || loc.name);
        const name = uniqueName(parent, stem + '.zip');
        parent.children.push(file(name, 4096, 0));
        emit(loc.id, parentRel ? parentRel + '/' + name : name);
        return { ok: true, archive: absOf(loc, parentRel ? parentRel + '/' + name : name) };
      },
      async rename(rel, name, locationId = 'primary') {
        const loc = locOf(locationId);
        const { parent, name: old } = parentAt(loc.tree, rel);
        const node = (parent?.children || []).find((c) => c.name === old);
        if (!node) throw new Error('文件不存在');
        if (parent.children.some((c) => c.name === name && c !== node)) throw new Error('同名文件或文件夹已存在');
        node.name = name; node.mtime = Date.now();
        emit(loc.id, rel);
        return delay({ ok: true, name });
      },
      async trash(rel, locationId = 'primary') {
        const loc = locOf(locationId);
        const { parent, name } = parentAt(loc.tree, rel);
        const i = (parent?.children || []).findIndex((c) => c.name === name);
        if (i < 0) throw new Error('文件不存在');
        parent.children.splice(i, 1);
        emit(loc.id, rel);
        return delay({ ok: true, trashed: true });
      },
      async move(rel, dest, locationId = 'primary') { return this.__transfer(rel, dest, locationId, true); },
      async copy(rel, dest, locationId = 'primary') { return this.__transfer(rel, dest, locationId, false); },
      async __transfer(rel, dest, locationId, isMove) {
        const loc = locOf(locationId);
        const destNode = nodeAt(loc.tree, dest);
        if (!destNode?.isDir) throw new Error('目标不是文件夹');
        if (dest === rel || String(dest).startsWith(rel + '/')) throw new Error('不能把文件夹放进自身');
        const { parent, name } = parentAt(loc.tree, rel);
        const node = (parent?.children || []).find((c) => c.name === name);
        if (!node) throw new Error('文件不存在');
        const target = deepClone(node);
        target.name = uniqueName(destNode, node.name);
        destNode.children.push(target);
        if (isMove) parent.children.splice(parent.children.indexOf(node), 1);
        emit(loc.id, rel);
        emit(loc.id, dest ? dest + '/' + target.name : target.name);
        return delay({ ok: true, name: target.name });
      },
      async open() { console.info('[fdmock] open 默认应用'); return delay({ ok: true }); },
      async openWith() { console.info('[fdmock] 打开方式对话框'); return delay({ ok: true }); },
      async reveal(rel) { console.info('[fdmock] Explorer 定位', rel); return delay({ ok: true }); },
      async inspect(rel, locationId = 'primary') {
        const loc = locOf(locationId);
        const node = nodeAt(loc.tree, rel);
        if (!node) throw new Error('文件不存在');
        return delay({
          ...toItem(node, rel), absolutePath: absOf(loc, rel), realPath: absOf(loc, rel), readable: true, writable: !node.name.includes('log'),
          longPath: false, acl: 'C:\\MockVault NT AUTHORITY\\SYSTEM:(OI)(CI)(F)\n           BUILTIN\\Administrators:(OI)(CI)(F)',
        });
      },
      async thumbnail(rel, size = 64, locationId = 'primary') {
        const loc = locOf(locationId);
        const node = nodeAt(loc.tree, rel);
        if (!node || node.isDir) return { dataUrl: '', width: 0, height: 0 };
        // 图片=真缩略图（按请求尺寸）；其余=32×32 系统图标（同真机回落路径）
        if (!IMG_EXTS.includes(extOf(node.name))) return delay({ dataUrl: iconDataUrl(node.name), width: ICON_PX, height: ICON_PX });
        return delay({ dataUrl: thumbDataUrl(node.name, Math.min(256, size)), width: size, height: size });
      },
      async writeText(rel, content, locationId = 'primary') {
        const loc = locOf(locationId);
        const node = nodeAt(loc.tree, rel);
        if (!node || node.isDir) throw new Error('文件不存在');
        node.content = String(content); node.size = new Blob([node.content]).size; node.mtime = Date.now();
        emit(loc.id, rel);
        return delay({ ok: true });
      },
      async search(query, locationId = 'primary') {
        const loc = locOf(locationId);
        const all = [];
        walk(loc.tree, '', all);
        const needle = String(query).toLowerCase();
        const items = all.filter((x) => x.rel.toLowerCase().includes(needle)).slice(0, 200)
          .map((x) => ({ ...x, parent: x.rel.includes('/') ? x.rel.slice(0, x.rel.lastIndexOf('/')) : '' }));
        items.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.rel.localeCompare(b.rel, 'zh-CN'));
        return delay({ items, native: true, indexed: true, truncated: items.length >= 200 });
      },
      async importFiles(rel = '', locationId = 'primary') {
        const loc = locOf(locationId);
        const node = nodeAt(loc.tree, rel);
        const names = [];
        for (let i = 0; i < 2; i++) {
          const name = uniqueName(node, `导入的文件 ${i + 1}.txt`);
          node.children.push(file(name, 1024, 0, 'mock import'));
          names.push(name);
          emit(loc.id, rel ? rel + '/' + name : name);
        }
        return delay({ canceled: false, items: names });
      },
      async importDirectory(rel = '', locationId = 'primary') {
        const loc = locOf(locationId);
        const node = nodeAt(loc.tree, rel);
        const name = uniqueName(node, '导入的文件夹');
        node.children.push(dir(name, [file('里面的文件.txt', 64, 0, 'x')], 0));
        emit(loc.id, rel ? rel + '/' + name : name);
        return delay({ canceled: false, items: [name] });
      },
      async importPaths(rel, paths, locationId = 'primary') {
        const loc = locOf(locationId);
        const node = nodeAt(loc.tree, rel);
        const items = [];
        for (const p of paths || []) {
          const base = String(p).split(/[\\/]/).pop() || 'file';
          const name = uniqueName(node, base);
          node.children.push(file(name, 2048, 0, 'dropped'));
          items.push(name);
          emit(loc.id, rel ? rel + '/' + name : name);
        }
        return delay({ ok: true, items, errors: [] });
      },
      async recent(locationId = 'primary', limit = 50) {
        const loc = locOf(locationId);
        const all = [];
        walk(loc.tree, '', all);
        const items = all.filter((x) => !x.isDir).sort((a, b) => b.mtime - a.mtime).slice(0, limit)
          .map((x) => ({ ...x, parent: x.rel.includes('/') ? x.rel.slice(0, x.rel.lastIndexOf('/')) : '' }));
        return delay({ items, native: true });
      },
      pathForFile: (f) => 'C:\\MockDrop\\' + (f?.name || 'file.bin'),
      async saveAs(rel) { return delay({ canceled: false, path: 'C:\\Users\\mock\\Desktop\\' + split(rel).pop() }); },
      fileUrl(rel = '', locationId = 'primary') {
        try {
          const node = nodeAt(locOf(locationId).tree, rel);
          if (node && !node.isDir) {
            if (IMG_EXTS.includes(extOf(node.name))) return thumbDataUrl(node.name, 640);
            return 'data:text/plain;charset=utf-8,' + encodeURIComponent(node.content || ('mock: ' + node.name));
          }
        } catch {}
        return 'data:text/plain,missing';
      },
      onChanged(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      // 文件夹大小：同真壳的流式协议——缓存命中当场回，其余逐个 onDirSize 推；「截图」先推一帧进度再定稿。
      async dirSizes(payload = {}) {
        const job = (dirJobs[payload.client] = (dirJobs[payload.client] || 0) + 1);
        const loc = locOf(payload.locationId);
        const results = {};
        const pending = [];
        for (const rel of payload.rels || []) {
          const node = nodeAt(loc.tree, rel);
          if (!node?.isDir) continue;
          const all = [];
          walk(node, '', all);
          const sum = { size: all.reduce((n, x) => n + (x.isDir ? 0 : x.size), 0), files: all.filter((x) => !x.isDir).length, partial: false };
          if (dirSizeSeen.has(loc.id + '|' + rel) && !payload.fresh) results[rel] = sum;
          else pending.push([rel, sum]);
        }
        (async () => {
          for (const [rel, sum] of pending) {
            if (dirJobs[payload.client] !== job) return;
            const send = (evt) => { for (const fn of dirSizeListeners) { try { fn({ client: payload.client, scope: payload.scope, key: rel, ...evt }); } catch {} } };
            if (sum.files > 10) { await new Promise((r) => setTimeout(r, 500)); send({ size: Math.round(sum.size / 3), files: Math.round(sum.files / 3), partial: true, done: false }); }
            await new Promise((r) => setTimeout(r, 350));
            if (dirJobs[payload.client] !== job) return;
            dirSizeSeen.add(loc.id + '|' + rel);
            send({ ...sum, done: true });
          }
        })();
        return delay({ results });
      },
      onDirSize(fn) { dirSizeListeners.add(fn); return () => dirSizeListeners.delete(fn); },
    },
    // 系统剪贴板（文件）：写入/粘贴同真壳协议。控制台 `__fdmockClip.external(['C:\\x\\外部.txt'], cut)` 模拟资源管理器复制。
    clipboard: {
      async writeFiles(payload = {}) {
        const loc = locOf(payload.locationId);
        const paths = (payload.rels || []).map((rel) => ({ loc: loc.id, rel }));
        mockClip = { paths, cut: Boolean(payload.cut), ours: true };
        return delay({ ok: true, count: paths.length, cut: mockClip.cut });
      },
      async pasteWorkspace(payload = {}) {
        if (!mockClip.paths.length) return delay({ handled: false, reason: 'empty' });
        if (mockClip.ours && payload.skipOurs) return delay({ handled: false, reason: 'ours', cut: mockClip.cut });
        const loc = locOf(payload.locationId);
        const destNode = nodeAt(loc.tree, payload.rel);
        const items = [];
        for (const p of mockClip.paths) {
          if (p.external) {
            const name = uniqueName(destNode, p.external.split(/[\\/]/).pop());
            destNode.children.push(file(name, 4096, 0, 'from explorer'));
            items.push(name); emit(loc.id, payload.rel ? payload.rel + '/' + name : name);
            continue;
          }
          const r = await window.BridgeDesktop.workspace[mockClip.cut ? 'move' : 'copy'](p.rel, payload.rel || '', p.loc);
          items.push(r.name);
        }
        const cut = mockClip.cut;
        if (cut) mockClip = { paths: [], cut: false, ours: false };
        return delay({ handled: true, cut, items, errors: [] });
      },
      async clearOwn() { if (mockClip.ours) mockClip = { paths: [], cut: false, ours: false }; return delay({ ok: true }); },
    },
  });
  window.__fdmockClip = {
    external(paths, cut = false) { mockClip = { paths: paths.map((external) => ({ external })), cut, ours: false }; },
    text() { mockClip = { paths: [], cut: false, ours: false }; },
    get state() { return JSON.parse(JSON.stringify(mockClip)); },
  };

  // 跳过登录门直接钉到工作空间页（boot 逻辑可能晚到，补一脚）。
  const pin = async () => {
    const { ui } = await import('./state.svelte.js');
    ui.booted = true;
    ui.screen = 'files';
  };
  queueMicrotask(pin);
  setTimeout(pin, 500);
  setTimeout(pin, 1500);
}
