// Figma「Clear Glass」WebGPU 移植：着色器与管线状态全部来自 figma-shaders.js（Figma 运行时原件），
// 本文件只做胶水——uniform 打包、管线/绑定组创建、纹理调度，以及 loop-Blinn 需要的 CPU 端路径三角化。
// 绘制顺序逐条对照截获的 Figma 指令流（见 README.md「渲染序列」）。
import { FIGMA_SHADERS, FIGMA_PIPELINES } from './figma-shaders.js';

// ---------- WGSL UniformBlock 布局（uniform 地址空间规则） ----------
const TYPES = {
  f32: [4, 4, 'f', 1], i32: [4, 4, 'i', 1], u32: [4, 4, 'u', 1],
  'vec2<f32>': [8, 8, 'f', 2], 'vec3<f32>': [12, 16, 'f', 3], 'vec4<f32>': [16, 16, 'f', 4],
  'mat3x3<f32>': [48, 16, 'm3', 9],
};
function parseUniformBlock(code) {
  const m = code.match(/struct UniformBlock\{([^}]*)\}/);
  if (!m) return null;
  const fields = {};
  let off = 0;
  for (const part of m[1].split(/,(?![^<]*>)/)) {
    const mm = part.trim().match(/^(\w+):(.+)$/);
    if (!mm) continue;
    const [size, align, kind, n] = TYPES[mm[2].trim()];
    off = Math.ceil(off / align) * align;
    fields[mm[1]] = { off, kind, n };
    off += size;
  }
  return { fields, size: Math.ceil(off / 16) * 16 };
}
function packUniforms(layout, values, dv, base) {
  for (const [name, v] of Object.entries(values)) {
    const f = layout.fields[name];
    if (!f) throw new Error('UniformBlock 无字段 ' + name);   // i18n-ignore 内部错误，调用方只打日志
    const p = base + f.off;
    if (f.kind === 'm3') {
      // mat3x3 按列存，每列 16 字节对齐；v 为 [[c0],[c1],[c2]]
      for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) dv.setFloat32(p + c * 16 + r * 4, v[c][r], true);
    } else if (f.n === 1) {
      if (f.kind === 'i') dv.setInt32(p, v, true); else if (f.kind === 'u') dv.setUint32(p, v, true); else dv.setFloat32(p, v, true);
    } else {
      for (let k = 0; k < f.n; k++) dv.setFloat32(p + k * 4, v[k], true);
    }
  }
}
function parseBindings(code) {
  // 返回 {group: {binding: 'uniform'|'texture'|'sampler'}}
  const out = {};
  const re = /@group\((\d+)\)@binding\((\d+)\)var(<uniform>)?\s*\w+:([\w<>]+)/g;
  let m;
  while ((m = re.exec(code))) {
    const g = +m[1], b = +m[2];
    (out[g] ||= {})[b] = m[3] ? 'uniform' : /^texture/.test(m[4]) ? 'texture' : 'sampler';
  }
  return out;
}

// Figma 内部 BlendMode 枚举（blendTileCustom 的 type_，已按着色器分支逐一核对）
export const BLEND = { NORMAL: 1, DARKEN: 2, MULTIPLY: 3, LINEAR_BURN: 4, COLOR_BURN: 5, LIGHTEN: 6, SCREEN: 7, LINEAR_DODGE: 8, COLOR_DODGE: 9, OVERLAY: 10, SOFT_LIGHT: 11, HARD_LIGHT: 12, DIFFERENCE: 13, EXCLUSION: 14, HUE: 15, SATURATION: 16, COLOR: 17, LUMINOSITY: 18 };

// ---------- Figma 平滑圆角路径（corner smoothing） ----------
// 与 glass 着色器的 cornerSmoothings 截断一致：smoothing ≤ min(w,h)/2 / r − 1
function cornerParams(r, smoothing, budget) {
  if (r <= 0) return null;
  r = Math.min(r, budget);
  const s = Math.max(0, Math.min(smoothing, budget / r - 1));
  const p = Math.min((1 + s) * r, budget);
  const rad = (d) => (d * Math.PI) / 180;
  const arcMeasure = 90 * (1 - s);
  const arc = Math.sin(rad(arcMeasure / 2)) * r * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p34 = r * Math.tan(rad(alpha / 2));
  const beta = 45 * s;
  const c = p34 * Math.cos(rad(beta));
  const d = c * Math.tan(rad(beta));
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  return { r, s, p, a, b, c, d, arc };
}
export function effectiveSmoothing(w, h, r, smoothing) {
  const budget = Math.min(w, h) / 2;
  const rr = Math.min(r, budget);
  return rr > 0 ? Math.max(0, Math.min(smoothing, budget / rr - 1)) : 0;
}
// 生成闭合多边形（节点坐标，y 向下），曲线按 px 容差细分
function squirclePolygon(x, y, w, h, r, smoothing, segs = 24) {
  const pts = [];
  const cp = cornerParams(r, smoothing, Math.min(w, h) / 2);
  let cx = 0, cy = 0;
  const move = (px, py) => { cx = px; cy = py; pts.push([x + cx, y + cy]); };
  const line = (px, py) => move(px, py);
  const cubic = (x1, y1, x2, y2, x3, y3) => { // 相对坐标
    const sx = cx, sy = cy;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs, u = 1 - t;
      const bx = u * u * u * sx + 3 * u * u * t * (sx + x1) + 3 * u * t * t * (sx + x2) + t * t * t * (sx + x3);
      const by = u * u * u * sy + 3 * u * u * t * (sy + y1) + 3 * u * t * t * (sy + y2) + t * t * t * (sy + y3);
      pts.push([x + bx, y + by]);
    }
    cx = sx + x3; cy = sy + y3;
  };
  const arcTo = (ox, oy, dx, dy) => { // 圆心(ox,oy) 顺时针到相对终点
    const ex = cx + dx, ey = cy + dy;
    let a0 = Math.atan2(cy - oy, cx - ox), a1 = Math.atan2(ey - oy, ex - ox);
    while (a1 < a0) a1 += Math.PI * 2;
    const rr = Math.hypot(cx - ox, cy - oy);
    for (let i = 1; i <= segs; i++) { const t = a0 + ((a1 - a0) * i) / segs; pts.push([x + ox + rr * Math.cos(t), y + oy + rr * Math.sin(t)]); }
    cx = ex; cy = ey;
  };
  if (!cp) { move(0, 0); line(w, 0); line(w, h); line(0, h); return pts; }
  const { r: R, p, a, b, c, d, arc } = cp;
  move(w - p, 0);
  cubic(a, 0, a + b, 0, a + b + c, d); arcTo(w - R, R, arc, arc); cubic(d, c, d, b + c, d, a + b + c);
  line(w, h - p);
  cubic(0, a, 0, a + b, -d, a + b + c); arcTo(w - R, h - R, -arc, arc); cubic(-c, d, -(b + c), d, -(a + b + c), d);
  line(p, h);
  cubic(-a, 0, -(a + b), 0, -(a + b + c), -d); arcTo(R, h - R, -arc, -arc); cubic(-d, -c, -d, -(b + c), -d, -(a + b + c));
  line(0, p);
  cubic(0, -a, 0, -(a + b), d, -(a + b + c)); arcTo(R, R, arc, -arc); cubic(c, -d, b + c, -d, a + b + c, -d);
  return pts;
}
// 形状 = 节点矩形按 spread 外扩（半径同步 +spread）、再平移 offset
function shapeFor(node, spread = 0, dx = 0, dy = 0) {
  const r = node.radius > 0 ? Math.max(0, node.radius + spread) : 0;
  return { x: -spread + dx, y: -spread + dy, w: node.w + spread * 2, h: node.h + spread * 2, r, smoothing: node.smoothing };
}

// ---------- 渲染器 ----------
const QUAD = [0, 0, 1, 0, 0, 1, 1, 1];
export class FigmaGlassRenderer {
  static async create(canvas, opts = {}) {
    if (!navigator.gpu) throw new Error('此浏览器不支持 WebGPU');   // i18n-ignore 同上
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const r = new FigmaGlassRenderer(device, canvas, opts);
    return r;
  }
  constructor(device, canvas, opts) {
    this.device = device;
    this.canvas = canvas;
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    if (canvas) {
      this.ctx = canvas.getContext('webgpu');
      this.ctx.configure({ device, format: this.canvasFormat, alphaMode: 'premultiplied' });
    }
    this.samplers = {
      linear: device.createSampler({ label: 'LinearClampSampler', magFilter: 'linear', minFilter: 'linear' }),
      nearest: device.createSampler({ label: 'NearestClampSampler', magFilter: 'nearest', minFilter: 'nearest' }),
    };
    // 顶点：瓦片四边形（stride 20：pos.xy + 占位 klm），copyTile 用 stride 8
    const q20 = new Float32Array(20);
    for (let i = 0; i < 4; i++) q20.set([QUAD[i * 2], QUAD[i * 2 + 1], 0, 0, 0], i * 5);
    this.quad20 = this.buffer(q20, GPUBufferUsage.VERTEX);
    this.quad8 = this.buffer(new Float32Array(QUAD), GPUBufferUsage.VERTEX);
    this.dummy = device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.layouts = {};
    this.bindInfo = {};
    for (const [name, sh] of Object.entries(FIGMA_SHADERS)) {
      this.layouts[name] = parseUniformBlock(sh.fragment) || parseUniformBlock(sh.vertex);
      const bv = parseBindings(sh.vertex), bf = parseBindings(sh.fragment);
      this.bindInfo[name] = { 0: { ...(bv[0] || {}), ...(bf[0] || {}) }, 1: { ...(bv[1] || {}), ...(bf[1] || {}) } };
    }
    this.modules = {};
    this.pipelines = {};
    this.texPool = new Map();
  }
  buffer(data, usage) {
    const b = this.device.createBuffer({ size: Math.ceil(data.byteLength / 4) * 4, usage: usage | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(b, 0, data);
    return b;
  }
  module(name, stage) {
    const k = name + '.' + stage;
    return (this.modules[k] ||= this.device.createShaderModule({ label: name, code: FIGMA_SHADERS[name][stage] }));
  }
  bgl(name, group) {
    const info = this.bindInfo[name][group];
    const entries = Object.entries(info).map(([b, kind]) => ({
      binding: +b,
      visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
      ...(kind === 'uniform' ? { buffer: { type: 'uniform' } } : kind === 'texture' ? { texture: { sampleType: 'float' } } : { sampler: { type: 'filtering' } }),
    }));
    return this.device.createBindGroupLayout({ entries });
  }
  // key = 'shader/BLEND'；override 用于本移植自己加的变体（最终上屏的格式与混合）
  pipeline(key, override) {
    const pk = key + (override ? JSON.stringify(override) : '');
    if (this.pipelines[pk]) return this.pipelines[pk];
    const base = FIGMA_PIPELINES[key] || FIGMA_PIPELINES[override && override.from];
    if (!base) throw new Error('没有管线变体 ' + key);   // i18n-ignore 同上
    const name = base.shader;
    const g0 = this.bgl(name, 0), g1 = Object.keys(this.bindInfo[name][1]).length ? this.bgl(name, 1) : null;
    const layout = this.device.createPipelineLayout({ bindGroupLayouts: g1 ? [g0, g1] : [g0] });
    const desc = {
      label: key,
      layout,
      vertex: { module: this.module(name, 'vertex'), entryPoint: 'main', buffers: base.buffers },
      fragment: {
        module: this.module(name, 'fragment'), entryPoint: 'main',
        targets: [{ format: (override && override.format) || base.format, blend: (override && override.blend) || base.colorBlend, writeMask: base.writeMask }],
      },
      primitive: base.primitive,
    };
    if (base.depthStencil && !(override && override.noStencil)) desc.depthStencil = base.depthStencil;
    const p = { gpu: this.device.createRenderPipeline(desc), g0, g1, name, stencil: !!desc.depthStencil };
    this.pipelines[pk] = p;
    return p;
  }

  // ---- 纹理池（同尺寸 rgba8unorm 中间纹理，全部与瓦片同大小，和 Figma 一样） ----
  // 按尺寸分组存、最多留 3 种尺寸（最久没用的整组销毁）：手机主页一个渲染器轮流画入口方块和
  // 右上胶囊两种尺寸，不必每画一块就把另一种的整套纹理重建；桌面 Dock 拖窗口时尺寸一直在变，
  // 旧尺寸照样很快被挤掉，不会越攒越多。
  sizeKey() {
    const sk = this.PW + 'x' + this.PH;
    const order = (this._sizes ||= []);
    const i = order.indexOf(sk);
    if (i !== order.length - 1) {
      if (i >= 0) order.splice(i, 1);
      order.push(sk);
      while (order.length > 3) {
        const old = order.shift();
        for (const [k, t] of this.texPool) if (k.endsWith('@' + old)) { t.destroy(); this.texPool.delete(k); }
      }
    }
    return sk;
  }
  tex(tag) {
    const k = tag + '@' + this.sizeKey();
    let t = this.texPool.get(k);
    if (!t) {
      t = this.device.createTexture({
        label: tag, size: [this.PW, this.PH], format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST,
      });
      this.texPool.set(k, t);
    }
    return t;
  }
  stencilTex() {
    const k = 'stencil@' + this.sizeKey();
    let t = this.texPool.get(k);
    if (!t) {
      t = this.device.createTexture({ size: [this.PW, this.PH], format: 'stencil8', usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.texPool.set(k, t);
    }
    return t;
  }
  // 多块画布共用一个设备：各配一个上屏 context，render() 经 context 参数指定画到哪块
  configure(canvas) {
    const ctx = canvas.getContext('webgpu');
    ctx.configure({ device: this.device, format: this.canvasFormat, alphaMode: 'premultiplied' });
    return ctx;
  }

  // ---- 一帧的指令录制 ----
  beginFrame() {
    this.enc = this.device.createCommandEncoder();
    this.uniformBytes = new ArrayBuffer(256 * 512);
    this.uniformDV = new DataView(this.uniformBytes);
    this.uniformSlot = 0;
    this.pendingDraws = [];
  }
  slot(name, values) {
    const layout = this.layouts[name];
    const base = this.uniformSlot * 256;
    if (base + 256 > this.uniformBytes.byteLength) throw new Error('uniform 槽位不足');   // i18n-ignore 同上
    packUniforms(layout, values, this.uniformDV, base);
    this.uniformSlot++;
    return { offset: base, size: layout.size };
  }
  // pass(target, load, draws[])；draw = {key, override, u, tex:[t0,t1,t2], samplers:[...], vb, count}
  pass(target, load, draws, clear = [0, 0, 0, 0]) {
    this.pendingDraws.push({ target, load, draws, clear });
  }
  endFrame() {
    const dev = this.device;
    const ubuf = dev.createBuffer({ size: Math.max(256, this.uniformSlot * 256), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    dev.queue.writeBuffer(ubuf, 0, this.uniformBytes, 0, Math.max(256, this.uniformSlot * 256));
    for (const p of this.pendingDraws) {
      const view = p.target.createView();
      const needStencil = p.draws.some((d) => this.pipeline(d.key, d.override).stencil);
      const rp = this.enc.beginRenderPass({
        colorAttachments: [{ view, loadOp: p.load ? 'load' : 'clear', storeOp: 'store', clearValue: { r: p.clear[0], g: p.clear[1], b: p.clear[2], a: p.clear[3] } }],
        ...(needStencil ? { depthStencilAttachment: { view: this.stencilTex().createView(), stencilLoadOp: 'clear', stencilStoreOp: 'discard', stencilClearValue: 0 } } : {}),
      });
      for (const d of p.draws) {
        const pl = this.pipeline(d.key, d.override);
        rp.setPipeline(pl.gpu);
        rp.setBindGroup(0, dev.createBindGroup({ layout: pl.g0, entries: [{ binding: 0, resource: { buffer: ubuf, offset: d.u.offset, size: d.u.size } }] }));
        if (pl.g1) {
          const info = this.bindInfo[pl.name][1];
          const entries = Object.entries(info).map(([b, kind]) => {
            const i = Math.floor(+b / 2);
            return kind === 'texture'
              ? { binding: +b, resource: (d.tex[i] || this.dummy).createView() }
              : { binding: +b, resource: this.samplers[(d.samplers && d.samplers[i]) || 'nearest'] };
          });
          rp.setBindGroup(1, dev.createBindGroup({ layout: pl.g1, entries }));
        }
        rp.setVertexBuffer(0, d.vb || (pl.name === 'copyTile' ? this.quad8 : this.quad20));
        rp.draw(d.count || 4);
      }
      rp.end();
    }
    dev.queue.submit([this.enc.finish()]);
    ubuf.destroy?.();
  }

  // ---- 坐标：节点坐标(单位) ↔ 瓦片 uv；ds = 以瓦片中心缩放的降采样比例（Figma 的 tileExpansionScale 语义） ----
  clipMatrix(ds = 1) {
    const { TW, TH, M } = this;
    const sx = (2 * ds) / TW, sy = (2 * ds) / TH;
    return { sx, sy, tx: ds * ((2 * M) / TW - 1), ty: ds * ((2 * M) / TH - 1) };
  }
  // loop-Blinn 两步填充：模板非零环绕 + cover（Figma 的 loopBlinnSolidPaint / solidColorPaintLoopBlinn 原件）
  fillPathDraws(shape, color, alpha, ds = 1) {
    const pts = squirclePolygon(shape.x, shape.y, shape.w, shape.h, shape.r, shape.smoothing);
    const verts = new Float32Array((pts.length - 2) * 3 * 5);
    let o = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      for (const p of [pts[0], pts[i], pts[i + 1]]) { verts.set([p[0], p[1], 0, 1, 1], o); o += 5; } // klm=(0,1,1)：非曲线三角形，恒不丢弃
    }
    const vb = this.buffer(verts, GPUBufferUsage.VERTEX);
    this._frameBuffers.push(vb);
    const m = this.clipMatrix(ds);
    const pad = 1;
    const bx = shape.x - pad, by = shape.y - pad, bw = shape.w + pad * 2, bh = shape.h + pad * 2;
    const vt = [[m.sx, 0, 0], [0, m.sy, 0], [m.tx, m.ty, 1]];
    const ct = [[m.sx * bw, 0, 0], [0, m.sy * bh, 0], [m.sx * bx + m.tx, m.sy * by + m.ty, 1]];
    const u = { vertexTransform: vt, coverTransform: ct, color, alpha };
    return [
      { key: 'loopBlinnSolidPaint/KEEP', u: this.slot('loopBlinnSolidPaint', u), vb, count: verts.length / 5 },
      { key: 'solidColorPaintLoopBlinn/PREMULTIPLIED', u: this.slot('solidColorPaintLoopBlinn', u) },
    ];
  }
  fillPath(target, shape, color, alpha, ds = 1) { this.pass(target, false, this.fillPathDraws(shape, color, alpha, ds)); }
  blit(key, target, load, uniforms, tex, samplers) {
    const name = FIGMA_PIPELINES[key].shader;
    this.pass(target, load, [{ key, u: this.slot(name, uniforms), tex, samplers }]);
  }
  // 三角核分离模糊：count = 模糊半径(单位) × 模糊纹理上每单位像素数（与 Figma 截获值吻合）
  blurChain(src, blurRadius, ds, tmpA, tmpB) {
    const count = blurRadius * this.S * ds;
    this.blit('unclampedBlurTile/COPY', tmpA, false, { quad: [0, 0, 1, 1], blurDelta: [1 / this.PW, 0], count }, [src], ['linear']);
    this.blit('unclampedBlurTile/COPY', tmpB, false, { quad: [0, 0, 1, 1], blurDelta: [0, 1 / this.PH], count }, [tmpA], ['linear']);
    return tmpB;
  }
  chooseDs(blurRadius) { const c = blurRadius * this.S; return c > 32 ? 32 / c : 1; }
  centered(ds) { return [0.5 - ds / 2, 0.5 - ds / 2, 0.5 + ds / 2, 0.5 + ds / 2]; }
  // 形状 → 模糊 → 回放到全分辨率（投影 / 内阴影共用；Figma：loopBlinn@低分辨率 → blur×2 → upscaleTile）
  blurredShape(shape, color, alpha, blurRadius, out) {
    const ds = blurRadius > 0 ? this.chooseDs(blurRadius) : 1;
    const A = this.tex('sA');
    this.fillPath(A, shape, color, alpha, ds);
    if (blurRadius <= 0) return A;
    const B = this.blurChain(A, blurRadius, ds, this.tex('sB'), this.tex('sC'));
    this.blit('upscaleTile/PREMULTIPLIED', out, false, { quad: [0, 0, 1, 1], source: this.centered(ds), preserveOpaqueDitherAlpha: 1 }, [B], ['linear']);
    return out;
  }

  // ---------- 场景：Figma「Clear Glass」组件（Fill + Shadow 层 + Glass Effect 层） ----------
  // scene = { node:{w,h,radius,smoothing}, margin, scale, background:{texture?}, fillShadow:{shadows[], fills[]}, glass:{...}, innerShadows[] }
  render(scene, { target, pageColor = [0, 0, 0, 0], present = true, context = this.ctx } = {}) {
    const node = scene.node;
    this.M = scene.margin;
    this.TW = node.w + 2 * this.M;
    this.TH = node.h + 2 * this.M;
    this.S = scene.scale;
    this.PW = Math.round(this.TW * this.S);
    this.PH = Math.round(this.TH * this.S);
    this._frameBuffers = [];
    this.beginFrame();
    const F = this.tex('F');
    const main = shapeFor(node);
    const black = [0, 0, 0, 1];

    // 0) 瓦片起点：透明（画布页面色不参与混合，最后才合成）；若有背景图层则先画进来
    if (scene.background && scene.background.texture) {
      this.blit('copyTile/COPY', F, false, { quad: [-1, -1, 1, 1] }, [scene.background.texture], ['linear']);
    } else {
      this.pass(F, false, []);
    }

    // 1) Fill + Shadow 层的投影（按效果列表顺序）；图层可整体隐藏（校准用例 C-glass）
    const fs = scene.fillShadow && !scene.fillShadow.hidden ? scene.fillShadow : { shadows: [], fills: [] };
    for (const s of fs.shadows) {
      const shp = shapeFor(node, s.spread, s.x, s.y);
      const col = [s.color[0], s.color[1], s.color[2], 1];
      if (s.blend === 'NORMAL') {
        // maskKnockoutShadowTile：阴影 × (形状外)，PREMULTIPLIED 叠到 F
        const U = s.radius > 0 ? this.blurredShape(shp, col, s.color[3], s.radius, this.tex('sU')) : (this.fillPath(this.tex('sU'), shp, col, s.color[3]), this.tex('sU'));
        const Mk = this.tex('mask');
        this.fillPath(Mk, main, black, 1);
        this.blit('maskKnockoutShadowTile/PREMULTIPLIED', F, true, { quad: [0, 0, 1, 1] }, [U, Mk]);
      } else {
        // 自定义混合：Orig=拷贝 F；Sh=阴影；Bl=blendTileCustom(Sh over Orig)；F=KnockoutPassThrough(Bl, Orig, 形状)
        const Orig = this.tex('orig');
        this.blit('blendTileSimple/COPY', Orig, false, { quad: [0, 0, 1, 1], alpha: 1 }, [F]);
        let Sh;
        if (s.radius > 0) Sh = this.blurredShape(shp, col, s.color[3], s.radius, this.tex('sU'));
        else { Sh = this.tex('sU'); this.fillPath(Sh, shp, col, s.color[3]); }
        const Bl = this.tex('blend');
        this.blit('blendTileCustom/COPY', Bl, false, { quad: [0, 0, 1, 1], type_: BLEND[s.blend], alpha: 1 }, [Sh, Orig]);
        const Mk = this.tex('mask');
        this.fillPath(Mk, main, black, 1);
        this.blit('maskKnockoutShadowTilePassThrough/COPY', F, false, { quad: [0, 0, 1, 1], useBinaryKnockoutMask: 1 }, [Bl, Orig, Mk]);
      }
    }
    // 2) Fill + Shadow 层的填充
    for (const f of fs.fills) {
      if (f.blend === 'NORMAL') {
        // 普通填充直接 PREMULTIPLIED 画到 F（blendTileCustom 没有 NORMAL 分支）
        this.pass(F, true, this.fillPathDraws(main, [f.color[0], f.color[1], f.color[2], 1], f.opacity));
        continue;
      }
      const P = this.tex('paint');
      this.fillPath(P, main, [f.color[0], f.color[1], f.color[2], 1], f.opacity);
      if (f.blend === 'LINEAR_DODGE') {
        this.blit('blendTileSimple/LINEAR_DODGE', F, true, { quad: [0, 0, 1, 1], alpha: 1 }, [P]);
      } else {
        const Dst = this.tex('orig');
        this.blit('blendTileSimple/COPY', Dst, false, { quad: [0, 0, 1, 1], alpha: 1 }, [F]);
        this.blit('blendTileCustom/COPY', F, false, { quad: [0, 0, 1, 1], type_: BLEND[f.blend], alpha: 1 }, [P, Dst]);
      }
    }

    // 3) Glass Effect 层：背景（此刻的 F）→ 降采样 → 三角核模糊 ×2 → glass → 按形状遮罩写回
    const g = scene.glass;
    const glassLayerOn = g && !scene.glassHidden;
    if (glassLayerOn) {
      let ds = g.frost > 0 ? this.chooseDs(g.frost) : 1;
      let src = F;
      if (ds < 1) {
        // 逐级 ≥0.5 的 downscaleTile（单次双线性采样），内容以瓦片中心缩放
        let cur = 1, ping = [this.tex('dsA'), this.tex('dsB')], k = 0;
        while (cur > ds + 1e-6) {
          const next = Math.max(ds, cur / 2);
          const dst = ping[k++ % 2];
          this.blit('downscaleTile/COPY', dst, false, { quad: this.centered(next), source: this.centered(cur) }, [src], ['linear']);
          src = dst; cur = next;
        }
      }
      const blurred = g.frost > 0 ? this.blurChain(src, g.frost, ds, this.tex('gA'), this.tex('gB')) : src;
      const G = this.tex('glassOut');
      const { TW, TH, M } = this;
      this.blit('glass/PREMULTIPLIED', G, false, {
        nodeToTileSpace: [[1 / TW, 0, 0], [0, 1 / TH, 0], [M / TW, M / TH, 1]],
        tileToNodeSpace: [[TW, 0, 0], [0, TH, 0], [-M, -M, 1]],
        quad: [0, 0, 1, 1],
        cornerRadii: Array(4).fill(Math.min(main.r, Math.min(node.w, node.h) / 2)),
        cornerSmoothings: Array(4).fill(effectiveSmoothing(node.w, node.h, node.radius, node.smoothing)),
        tintColor: [0, 0, 0, 0],
        directCompositeBackgroundColor: [0, 0, 0, 0],
        nodeSpaceCenterPoint: [node.w / 2, node.h / 2],
        maskTextureSize: 1,
        hasUniformCorners: 1,
        tileExpansionScale: ds,
        splay: g.splay,
        frameRotation: 0,
        refractionIntensity: g.refraction,
        refractionDistance: g.depth,
        lightIntensity: g.lightIntensity,
        lightAngle: (g.lightAngle * Math.PI) / 180,
        bevelSize: 1,
        chromaticAberration: g.dispersion * 0.2,
        directComposite: 0,
        textureMaskDirectComposite: 0,
      }, [blurred, this.dummy], ['linear', 'linear']);
      const Mk = this.tex('mask');
      this.fillPath(Mk, main, black, 1);
      // Figma 在同一 pass 里紧跟一次 0.4% 黑色形状填充（截获序列 1179–1191）
      this.pass(F, true, [
        { key: 'maskBackgroundBlurTile/COPY', u: this.slot('maskBackgroundBlurTile', { quad: [0, 0, 1, 1] }), tex: [G, Mk] },
        ...this.fillPathDraws(main, black, 0.004),
      ]);
    }

    // 4) Glass Effect 层的内阴影：(1 − 模糊(外扩平移形状)) × 形状 × 颜色，再按混合模式合成
    for (const s of glassLayerOn ? scene.innerShadows : []) {
      const shp = shapeFor(node, -s.spread, s.x, s.y);
      const U = this.blurredShape(shp, black, 1, s.radius, this.tex('sU'));
      const Mk = this.tex('mask');
      this.fillPath(Mk, main, black, 1);
      const I = this.tex('inner');
      const c = s.color;
      this.blit('maskInnerShadowTile/PREMULTIPLIED', I, false, { quad: [0, 0, 1, 1], color: [c[0] * c[3], c[1] * c[3], c[2] * c[3], c[3]] }, [U, Mk]);
      if (s.blend === 'LINEAR_DODGE') {
        this.blit('blendTileSimple/LINEAR_DODGE', F, true, { quad: [0, 0, 1, 1], alpha: 1 }, [I]);
      } else if (s.blend === 'NORMAL') {
        this.pass(F, true, [{ key: 'blendTileSimple/COPY', override: { from: 'blendTileSimple/COPY', blend: FIGMA_PIPELINES['glass/PREMULTIPLIED'].colorBlend }, u: this.slot('blendTileSimple', { quad: [0, 0, 1, 1], alpha: 1 }), tex: [I] }]);
      } else {
        const Dst = this.tex('orig');
        this.blit('blendTileSimple/COPY', Dst, false, { quad: [0, 0, 1, 1], alpha: 1 }, [F]);
        this.blit('blendTileCustom/COPY', F, false, { quad: [0, 0, 1, 1], type_: BLEND[s.blend], alpha: 1 }, [I, Dst]);
      }
    }

    // 5) 上屏：页面色打底 + copyTile（本移植加的变体：目标格式=画布格式，混合=PREMULTIPLIED over）
    if (present && context) {
      const cv = context.getCurrentTexture();
      this.pendingDraws.push({
        target: cv, load: false, clear: pageColor,
        draws: [{ key: 'copyTile/COPY', override: { from: 'copyTile/COPY', format: this.canvasFormat, blend: FIGMA_PIPELINES['glass/PREMULTIPLIED'].colorBlend }, u: this.slot('copyTile', { quad: [-1, -1, 1, 1] }), tex: [F], samplers: ['linear'] }],
      });
    }
    if (target) {
      this.pendingDraws.push({
        target, load: false, clear: pageColor,
        draws: [{ key: 'copyTile/COPY', override: { from: 'copyTile/COPY', blend: FIGMA_PIPELINES['glass/PREMULTIPLIED'].colorBlend }, u: this.slot('copyTile', { quad: [-1, -1, 1, 1] }), tex: [F], samplers: ['linear'] }],
      });
    }
    this.endFrame();
    const bufs = this._frameBuffers;
    this.device.queue.onSubmittedWorkDone().then(() => bufs.forEach((b) => b.destroy()));
    return F;
  }

  // 读回瓦片像素（rgba8，premultiplied），用于与 Figma 导出图逐像素比对
  async readback(tex) {
    const bpr = Math.ceil((tex.width * 4) / 256) * 256;
    const buf = this.device.createBuffer({ size: bpr * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: bpr }, [tex.width, tex.height]);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const src = new Uint8Array(buf.getMappedRange());
    const out = new Uint8ClampedArray(tex.width * tex.height * 4);
    for (let y = 0; y < tex.height; y++) out.set(src.subarray(y * bpr, y * bpr + tex.width * 4), y * tex.width * 4);
    buf.unmap(); buf.destroy();
    return out;
  }
}

// 截获文件里 Notification - Collapsed 的全部参数（来源：Figma 插件 API 读数 + 渲染时 uniform 实测）
export const NOTIFICATION_SCENE = {
  node: { w: 386, h: 68, radius: 23, smoothing: 0.6 },
  margin: 40,
  scale: 2,
  fillShadow: {
    shadows: [
      { blend: 'NORMAL', radius: 15, x: 0, y: 8, spread: 0, color: [0, 0, 0, 0.02] },
      { blend: 'LINEAR_BURN', radius: 0, x: 0, y: 0, spread: 0.5, color: [0.8, 0.8, 0.8, 1] },
      { blend: 'LINEAR_BURN', radius: 0, x: -1.25, y: 0, spread: -0.75, color: [0.81569, 0.81569, 0.81569, 1] },
      { blend: 'LINEAR_BURN', radius: 0, x: 1.25, y: 0, spread: -0.75, color: [0.81569, 0.81569, 0.81569, 1] },
    ],
    fills: [
      { blend: 'LINEAR_DODGE', color: [0.06275, 0.06275, 0.06275], opacity: 1 },
      { blend: 'LUMINOSITY', color: [1, 1, 1], opacity: 0.04 },
    ],
  },
  glass: { frost: 6, refraction: 0.7, depth: 30, dispersion: 0.2, lightAngle: 0, lightIntensity: 0.4, splay: 0.2 },
  innerShadows: [
    { blend: 'LINEAR_BURN', radius: 30, x: 0, y: 40, spread: -40, color: [0.90196, 0.90196, 0.90196, 1] },
    { blend: 'LINEAR_DODGE', radius: 10, x: 0, y: -40, spread: -40, color: [0.15686, 0.15686, 0.15686, 1] },
    { blend: 'LINEAR_DODGE', radius: 10, x: 0, y: 40, spread: -40, color: [0.15686, 0.15686, 0.15686, 1] },
  ],
};

// 校准用例：文件「Glass Calibration」页 calib4/wall15（413×68、半径 1000、图片背景图层；参数取自插件 API）
export const WALL15_SCENE = {
  node: { w: 413, h: 68, radius: 1000, smoothing: 0.6 },
  margin: 40,
  scale: 2,
  fillShadow: {
    shadows: [
      { blend: 'NORMAL', radius: 15, x: 0, y: 8, spread: 0, color: [0, 0, 0, 0.02] },
      { blend: 'LINEAR_BURN', radius: 0, x: 0, y: 0, spread: 0.5, color: [0.9098, 0.9098, 0.9098, 1] },
      { blend: 'LINEAR_BURN', radius: 0, x: -1.25, y: 0, spread: -0.75, color: [0.81569, 0.81569, 0.81569, 1] },
      { blend: 'LINEAR_BURN', radius: 0, x: 1.25, y: 0, spread: -0.75, color: [0.81569, 0.81569, 0.81569, 1] },
    ],
    fills: [
      { blend: 'NORMAL', color: [0, 0, 0], opacity: 0.25 },
      { blend: 'NORMAL', color: [1, 1, 1], opacity: 0.25 },
      { blend: 'LINEAR_DODGE', color: [0.26667, 0.26667, 0.26667], opacity: 0.6 },
      { blend: 'LUMINOSITY', color: [0.97255, 0.97255, 0.97255], opacity: 0.2 },
    ],
  },
  glass: { frost: 6, refraction: 0.7, depth: 30, dispersion: 0.2, lightAngle: 0, lightIntensity: 0.25, splay: 0.2 },
  innerShadows: NOTIFICATION_SCENE.innerShadows,
};
