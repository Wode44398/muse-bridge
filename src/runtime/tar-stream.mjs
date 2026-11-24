// 流式读 tar（npm 包、Codex 发行包都是 gzip 过的 ustar / pax）。只用 Node 内置：运行组件下载器不许引第三方依赖。
//
// walkTar(stream, onEntry, { stop, drain })
//   onEntry({ name, type, size, mode, linkname }) 每个条目调一次（pax 'x' 与 GNU 'L' / 'K' 长名头在这里吃掉，
//   不会交给调用方；它们带的 path / linkpath 已经并进下一个条目）。返回 null = 跳过数据；返回 { data(chunk), end() }
//   = 数据分块交给 data（可返回 Promise 做背压），条目读完调 end。两者都可以是 async。
//   stop()：每到条目边界问一次，为真就不再往下读（找到要的就收手，不必把整个包读完）。
//   drain：读到归档结尾标记之后仍把流读干——调用方在原始字节上同时算哈希时要拿到最后一个字节，
//   提前退出 for await 会把上游流销毁、哈希就少了尾巴。

const META_MAX = 1 << 20;

function cstr(b, off, len) {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString('utf8');
}

function tarNumber(b, off, len) {
  if (b[off] & 0x80) {   // base-256（超过 8GB 的条目才会用到）
    let n = 0;
    for (let i = off + 1; i < off + len; i++) n = n * 256 + b[i];
    return n;
  }
  return parseInt(cstr(b, off, len).trim() || '0', 8) || 0;
}

// pax 扩展头里我们关心的两项：path、linkpath。
function paxFields(buf) {
  const out = {};
  for (let i = 0; i < buf.length;) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.subarray(i, sp).toString('latin1'), 10);
    if (!(len > 0)) break;
    const rec = buf.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0) {
      const k = rec.slice(0, eq);
      if (k === 'path' || k === 'linkpath') out[k] = rec.slice(eq + 1);
    }
    i += len;
  }
  return out;
}

export async function walkTar(stream, onEntry, { stop = null, drain = false } = {}) {
  let buf = Buffer.alloc(0);
  let mode = 'head', left = 0, pad = 0, sink = null;
  let meta = null, metaType = '', next = {};
  for await (const chunk of stream) {
    if (mode === 'end') continue;   // 只有 drain 才会走到这里：把剩下的读干
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (mode === 'head') {
        if (stop && stop()) { mode = 'stopped'; break; }
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((x) => x === 0)) { mode = 'end'; break; }
        const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
        left = tarNumber(h, 124, 12);
        pad = (512 - (left % 512)) % 512;
        sink = null;
        if (type === 'x' || type === 'L' || type === 'K') {
          // 扩展头整个攒在内存里才解析：正常只有几百字节，太大说明包是坏的，别把内存吃光
          if (left > META_MAX) throw new Error(`tar 扩展头过大（${left} 字节）`);
          mode = 'meta'; metaType = type; meta = [];
        } else {
          let name = cstr(h, 0, 100);
          if (h.subarray(257, 262).toString('latin1') === 'ustar') { const pre = cstr(h, 345, 155); if (pre) name = pre + '/' + name; }
          let linkname = cstr(h, 157, 100);
          if (next.path) name = next.path;
          if (next.linkpath) linkname = next.linkpath;
          next = {};
          const entry = { name, type, size: left, mode: tarNumber(h, 100, 8) & 0o7777, linkname };
          sink = (await onEntry(entry)) || null;
          mode = 'body';
        }
        if (left === 0) {
          if (mode === 'body' && sink) { await sink.end?.(); sink = null; }
          mode = 'pad';
        }
        continue;
      }
      if (mode === 'body' || mode === 'meta') {
        if (!buf.length) break;
        const n = Math.min(left, buf.length);
        const part = buf.subarray(0, n);
        buf = buf.subarray(n);
        left -= n;
        if (mode === 'meta') meta.push(Buffer.from(part));
        else if (sink) await sink.data(part);
        if (left === 0) {
          if (mode === 'meta') {
            const m = Buffer.concat(meta);
            if (metaType === 'L') next.path = cstr(m, 0, m.length);
            else if (metaType === 'K') next.linkpath = cstr(m, 0, m.length);
            else Object.assign(next, paxFields(m));
          } else if (sink) { await sink.end?.(); sink = null; }
          mode = 'pad';
        }
        continue;
      }
      if (mode === 'pad') {
        if (pad === 0) { mode = 'head'; continue; }
        if (!buf.length) break;
        const n = Math.min(pad, buf.length);
        buf = buf.subarray(n);
        pad -= n;
        if (pad === 0) mode = 'head';
        continue;
      }
      break;   // end / stopped
    }
    if (mode === 'stopped' || (mode === 'end' && !drain)) break;
  }
  return mode;
}

// 读完（或找到）为止。match(name) 选中第一个普通文件条目，其数据分块交给 onData（可返回 Promise 做背压）。返回是否找到。
export async function extractTarEntry(stream, match, onData) {
  let found = false;
  await walkTar(stream, (e) => {
    if (found || !(e.type === '0' || e.type === '7') || !match(e.name)) return null;
    return { data: onData, end: () => { found = true; } };
  }, { stop: () => found });
  return found;
}
