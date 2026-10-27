// 二维码编码器（零依赖）：字节模式、纠错 L/M/Q/H、版本 1–40，按 ISO/IEC 18004 的掩码评分选掩码。
//
// 来源与许可：编码核心（纠错表、Reed–Solomon、码字分块交织、功能图形与之字形填充、对齐图形位置、掩码罚分）移植并精简自
// Project Nayuki 的 QR Code generator library（https://www.nayuki.io/page/qr-code-generator-library），MIT 许可。
// 本文件因此按 MIT 许可分发，原版权与许可声明照录如下（改动：只留字节模式、改写成函数式 ES 模块、加了 SVG / 终端字符画输出）：
//
//   Copyright (c) Project Nayuki. (MIT License)
//   https://www.nayuki.io/page/qr-code-generator-library
//
//   Permission is hereby granted, free of charge, to any person obtaining a copy of
//   this software and associated documentation files (the "Software"), to deal in
//   the Software without restriction, including without limitation the rights to
//   use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
//   the Software, and to permit persons to whom the Software is furnished to do so,
//   subject to the following conditions:
//   - The above copyright notice and this permission notice shall be included in
//     all copies or substantial portions of the Software.
//   - The Software is provided "as is", without warranty of any kind, express or
//     implied, including but not limited to the warranties of merchantability,
//     fitness for a particular purpose and noninfringement. In no event shall the
//     authors or copyright holders be liable for any claim, damages or other
//     liability, whether in an action of contract, tort or otherwise, arising from,
//     out of or in connection with the Software or the use or other dealings in the
//     Software.
//
// 为什么放一份在仓库里、不引 npm 包：扫码配对（开源路线 S1-2）要在没有二维码库的地方出码——
//   · 桌面客户端向导完成页 / 托盘「访问信息」：服务端 /api/pair/connect 直接回 SVG，壳不用带库；
//   · 网页（设置「连接与更新」、控制台）：同一份 SVG，省得再拉一次 qrcode 分块；
//   · 终端字符画（qrTerminal）：命令行 `cli.mjs pair`（src/cli/access.mjs）用的也是这一份。
// 服务端加第三方依赖要过许可与体积闸门、还要在正式服目录里装包。
// 网页端「扫码登录（手机替网页登录）」仍用现成的 qrcode（MIT），两边互不影响。
//
// 只做字节模式（UTF-8）：配对码是一条网址，数字 / 字母数字模式省下的那点体积不值得多一套编码。

const ECC = {
  L: { ord: 0, fmt: 1 },
  M: { ord: 1, fmt: 0 },
  Q: { ord: 2, fmt: 3 },
  H: { ord: 3, fmt: 2 },
};
const ECC_ORDER = ['L', 'M', 'Q', 'H'];

// 每块纠错码字数、纠错块数（下标 = 版本，0 号不用）。表出自标准，与各家实现一致。
const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const NUM_ECC_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** 这个版本能放多少个模块的数据（扣掉所有功能图形之后），单位：位。 */
function numRawDataModules(ver) {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    r -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}
const numDataCodewords = (ver, e) => Math.floor(numRawDataModules(ver) / 8) - ECC_CODEWORDS_PER_BLOCK[e.ord][ver] * NUM_ECC_BLOCKS[e.ord][ver];
// 字节模式的字符计数位数：1–9 版 8 位，10 版起 16 位
const ccBits = (ver) => (ver <= 9 ? 8 : 16);

// —— Reed–Solomon（GF(256)，本原多项式 0x11D）——
function rsMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}
function rsDivisor(degree) {
  const r = new Array(degree).fill(0);
  r[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < r.length; j++) {
      r[j] = rsMul(r[j], root);
      if (j + 1 < r.length) r[j] ^= r[j + 1];
    }
    root = rsMul(root, 0x02);
  }
  return r;
}
function rsRemainder(data, divisor) {
  const r = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ r.shift();
    r.push(0);
    for (let i = 0; i < r.length; i++) r[i] ^= rsMul(divisor[i], factor);
  }
  return r;
}

function alignmentPositions(ver) {
  if (ver === 1) return [];
  const size = ver * 4 + 17;
  const numAlign = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < numAlign; pos -= step) out.splice(1, 0, pos);
  return out;
}

const getBit = (x, i) => ((x >>> i) & 1) !== 0;

/**
 * 编码。返回 { version, ecc, size, dark(x, y) }。
 * @param {string} text
 * @param {object} [o]
 * @param {'L'|'M'|'Q'|'H'} [o.ecc='M']  最低纠错级别；同一版本放得下时自动往上提（码不变大、更耐污损）
 */
export function encodeQr(text, { ecc = 'M', minVersion = 1, maxVersion = 40, boostEcc = true } = {}) {
  const bytes = Buffer.from(String(text ?? ''), 'utf8');
  let e = ECC[ecc] || ECC.M;
  let ver = 0, needBits = 0;
  for (let v = Math.max(1, minVersion); v <= Math.min(40, maxVersion); v++) {
    const need = 4 + ccBits(v) + bytes.length * 8;
    if (bytes.length < 1 << ccBits(v) && need <= numDataCodewords(v, e) * 8) { ver = v; needBits = need; break; }
  }
  if (!ver) throw new RangeError('内容太长，二维码放不下');
  if (boostEcc) {
    for (const k of ECC_ORDER.slice(e.ord + 1)) if (needBits <= numDataCodewords(ver, ECC[k]) * 8) e = ECC[k];
  }

  // —— 数据位流 ——
  const bits = [];
  const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
  put(0x4, 4);
  put(bytes.length, ccBits(ver));
  for (const b of bytes) put(b, 8);
  const capBits = numDataCodewords(ver, e) * 8;
  put(0, Math.min(4, capBits - bits.length));
  put(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capBits; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    data.push(b);
  }

  // —— 纠错与交织 ——
  const numBlocks = NUM_ECC_BLOCKS[e.ord][ver];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[e.ord][ver];
  const rawCodewords = Math.floor(numRawDataModules(ver) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);
  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const eccBytes = rsRemainder(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(eccBytes));
  }
  const codewords = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) codewords.push(blocks[j][i]);
    }
  }

  // —— 画矩阵 ——
  const size = ver * 4 + 17;
  const mod = new Uint8Array(size * size);
  const fn = new Uint8Array(size * size);
  const at = (x, y) => y * size + x;
  const setFn = (x, y, dark) => { mod[at(x, y)] = dark ? 1 : 0; fn[at(x, y)] = 1; };

  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setFn(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = alignmentPositions(ver);
  for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  const drawFormat = (mask) => {
    const d = (e.fmt << 3) | mask;
    let rem = d;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const b = ((d << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFn(8, i, getBit(b, i));
    setFn(8, 7, getBit(b, 6));
    setFn(8, 8, getBit(b, 7));
    setFn(7, 8, getBit(b, 8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, getBit(b, i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, getBit(b, i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, getBit(b, i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);   // 先占位，选好掩码后重画
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const b = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(b, i), a = size - 11 + (i % 3), c = Math.floor(i / 3);
      setFn(a, c, bit); setFn(c, a, bit);
    }
  }

  // 数据码字：从右下角起两列一组之字形往上 / 往下填
  let bi = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fn[at(x, y)] && bi < total) {
          mod[at(x, y)] = getBit(codewords[bi >>> 3], 7 - (bi & 7)) ? 1 : 0;
          bi++;
        }
      }
    }
  }

  const maskHit = (m, x, y) => {
    switch (m) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
      default: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    }
  };
  const applyMask = (m) => {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!fn[at(x, y)] && maskHit(m, x, y)) mod[at(x, y)] ^= 1;
    }
  };

  // 掩码评分（N1 连续同色、N2 2×2 色块、N3 类寻像图形、N4 深浅比例），取最低分
  const addHistory = (len, hist) => { if (hist[0] === 0) len += size; hist.pop(); hist.unshift(len); };
  const countPatterns = (h) => {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  };
  const terminate = (color, len, hist) => { if (color) { addHistory(len, hist); len = 0; } len += size; addHistory(len, hist); return countPatterns(hist); };
  const penalty = () => {
    let s = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let color = 0, run = 0;
        const hist = [0, 0, 0, 0, 0, 0, 0];
        for (let b = 0; b < size; b++) {
          const c = pass === 0 ? mod[at(b, a)] : mod[at(a, b)];
          if (c === color) {
            run++;
            if (run === 5) s += 3; else if (run > 5) s++;
          } else {
            addHistory(run, hist);
            if (!color) s += countPatterns(hist) * 40;
            color = c; run = 1;
          }
        }
        s += terminate(color, run, hist) * 40;
      }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
      const c = mod[at(x, y)];
      if (c === mod[at(x + 1, y)] && c === mod[at(x, y + 1)] && c === mod[at(x + 1, y + 1)]) s += 3;
    }
    let dark = 0;
    for (let i = 0; i < mod.length; i++) dark += mod[i];
    const totalMods = size * size;
    s += (Math.ceil(Math.abs(dark * 20 - totalMods * 10) / totalMods) - 1) * 10;
    return s;
  };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) {
    applyMask(m); drawFormat(m);
    const sc = penalty();
    if (sc < bestScore) { bestScore = sc; best = m; }
    applyMask(m);
  }
  applyMask(best); drawFormat(best);

  const eccName = ECC_ORDER[e.ord];
  return {
    version: ver,
    ecc: eccName,
    mask: best,
    size,
    dark: (x, y) => x >= 0 && y >= 0 && x < size && y < size && mod[at(x, y)] === 1,
  };
}

/**
 * SVG（深色码点、透明底，viewBox 自适应——容器给多大画多大；放在白底方块里用）。
 * 同一行连续的深色模块并成一段，二三十个版本的码也只有几 KB。
 */
export function qrSvg(text, { margin = 0, color = '#000', ecc = 'M' } = {}) {
  const q = encodeQr(text, { ecc });
  const n = q.size + margin * 2;
  let d = '';
  for (let y = 0; y < q.size; y++) {
    for (let x = 0; x < q.size; x++) {
      if (!q.dark(x, y)) continue;
      let len = 1;
      while (q.dark(x + len, y)) len++;
      d += `M${x + margin} ${y + margin}h${len}v1h-${len}z`;
      x += len - 1;
    }
  }
  const fill = String(color).replace(/[^#\w(),.\s%-]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges"><path fill="${fill}" d="${d}"/></svg>`;
}

/**
 * 终端字符画：每个字符上下两个模块（▀ ▄ █），留 margin 圈浅色静区。
 * 默认按深色背景的终端画（浅色模块用前景色块画出来）；浅色背景的终端传 invert:true。
 * ascii:true 时每个模块两个字符（'##' / '  '），给不认 Unicode 方块字的终端。
 */
export function qrTerminal(text, { margin = 2, invert = false, ascii = false, ecc = 'M' } = {}) {
  const q = encodeQr(text, { ecc });
  const n = q.size + margin * 2;
  // 「要不要用前景色画」：深色终端上画的是浅色模块（含静区）；越过静区外的那半行当背景
  const lit = (x, y) => {
    if (y >= n) return false;
    const light = !q.dark(x - margin, y - margin);
    return invert ? !light : light;
  };
  const lines = [];
  if (ascii) {
    for (let y = 0; y < n; y++) {
      let s = '';
      for (let x = 0; x < n; x++) s += lit(x, y) ? '##' : '  ';
      lines.push(s);
    }
    return lines.join('\n');
  }
  for (let y = 0; y < n; y += 2) {
    let s = '';
    for (let x = 0; x < n; x++) {
      const top = lit(x, y), bot = lit(x, y + 1);
      s += top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
    }
    lines.push(s);
  }
  return lines.join('\n');
}
