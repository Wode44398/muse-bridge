// 开机入场「穿月」的画面：一个全屏片元着色器画完全部——
//   · 月桥标记（拱、倒影、水线都是解析距离场，放大多少倍都锐利；失焦 = 把距离场的边柔化）；
//   · 门外的墙（暖墨），门洞里的彼岸；
//   · 静态壁纸：洞里画壁纸本身，按景深图逐像素推镜（近处放大得多、远处少），拉焦用 mipmap 的 LOD；
//   · 动态壁纸（流光）：洞里透明，下面是主页里真的流光 iframe，推镜交给它自己（lib/boot/intro.js）。
// 几何与安卓启动画面 / index.html 首帧同一套：108 网格，拱 R19、线宽 7.4，水面 2.2，倒影 2.8、离水面 11°。
const VS = `#version 300 es
void main() { vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform vec2 uRes;        // 画布设备像素
uniform float uK;         // 每 css px 的设备像素
uniform vec2 uView;       // 视口 css px
uniform vec2 uC;          // 门心（水面线中点，css px）
uniform vec4 uRing;       // 中线半径、拱宽、倒影宽、倒影离水面的角度（弧度）
uniform vec4 uRing2;      // 倒影实心程度 0..1、整环（1 = 上下不分）、失焦宽度（css px）、环的不透明度
uniform vec3 uLine;       // 水线半长、线宽、不透明度
uniform vec3 uDot;        // 门心光点：半径、不透明度、光晕半径
uniform float uHole;      // 门洞半径（css px）
uniform float uScene;     // 1 = 洞里画壁纸；0 = 洞里透明
uniform vec4 uCam;        // 镜头进度 e、推进距离 Z、景深图白（近）/ 黑（远）对应的距离
uniform vec4 uLook;       // 拉焦 LOD、曝光、暖光、洞口阴影
uniform vec3 uImg3;       // 图像宽、高、overscan（空间壁纸静止时比 cover 再放大一点）
uniform sampler2D uImg;
uniform sampler2D uDepth;
out vec4 o;

const vec3 INK = vec3(15.0, 14.0, 12.0) / 255.0;
const vec3 IVORY = vec3(243.0, 238.0, 228.0) / 255.0;

// 和 <img object-fit:cover> / SpatialLayer 静止时同一种铺法，终帧才能和主页逐像素接上
vec2 coverUV(vec2 q) {
  float sa = uView.x / uView.y, ia = uImg3.x / uImg3.y;
  vec2 uv = q / uView;
  if (sa < ia) uv.x = 0.5 + (uv.x - 0.5) * sa / ia; else uv.y = 0.5 + (uv.y - 0.5) * ia / sa;
  return 0.5 + (uv - 0.5) / uImg3.z;
}
float cov(float d, float w) { return clamp(0.5 - d / w, 0.0, 1.0); }

void main() {
  vec2 q = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uK;
  vec2 d = q - uC;
  float r = length(d);
  float aa = 1.0 / uK;

  vec4 scene = vec4(0.0);
  if (uScene > 0.5) {
    // 推镜的逆映射：屏幕上这一点来自原图哪里（深度依赖位置，迭代几次就收敛）
    vec2 p = q;
    for (int i = 0; i < 4; i++) {
      float dv = texture(uDepth, coverUV(p)).r;
      float D = mix(uCam.w, uCam.z, dv);
      float s = D / (D + uCam.y * (1.0 - uCam.x));
      p = uC + (q - uC) / s;
    }
    vec2 uv = coverUV(p);
    float lod = uLook.x;
    vec3 c;
    if (lod > 0.05) {
      // 四个错开的取样把 mipmap 的方块感抹掉
      vec2 px = vec2(1.0) / uImg3.xy * exp2(lod) * 0.6;
      c = (textureLod(uImg, uv + vec2(px.x, px.y * 0.4), lod).rgb + textureLod(uImg, uv - vec2(px.x, px.y * 0.4), lod).rgb
         + textureLod(uImg, uv + vec2(-px.x * 0.4, px.y), lod).rgb + textureLod(uImg, uv + vec2(px.x * 0.4, -px.y), lod).rgb) * 0.25;
    } else c = texture(uImg, uv).rgb;
    c = c * uLook.y;
    c = mix(c, vec3(1.0, 0.95, 0.86), uLook.z);
    // 门有厚度：洞口一圈暗一点
    c *= 1.0 - smoothstep(uHole * 0.45, uHole, r) * uLook.w;
    scene = vec4(c, 1.0);
  }
  // 墙和门在同一个深度：洞的边和门一起失焦
  float inHole = uHole > 0.0 ? clamp(0.5 - (r - uHole) / max(aa, uRing2.z), 0.0, 1.0) : 0.0;
  vec4 col = mix(vec4(INK, 1.0), scene, inHole);

  float R = uRing.x, wa = uRing.y, wr = uRing.z, gap = uRing.w;
  float blur = max(aa, uRing2.z);
  // 拱：上半个圆环，脚平切在水面上
  float cA = cov(abs(r - R) - wa * 0.5, blur) * clamp(0.5 - d.y / aa, 0.0, 1.0);
  // 倒影：下半圆弧，离水面 gap 的两端是圆头，透明度从水面往下渐隐
  float th = atan(d.y, d.x);
  float dR;
  if (d.y > 0.0 && th >= gap && th <= 3.14159265 - gap) dR = abs(r - R) - wr * 0.5;
  else {
    vec2 e0 = vec2(cos(gap), sin(gap)) * R, e1 = vec2(-cos(gap), sin(gap)) * R;
    dR = min(length(d - e0), length(d - e1)) - wr * 0.5;
  }
  float grad = mix(0.58, 0.12, clamp(d.y / (R + wr * 0.5), 0.0, 1.0));
  float cR = cov(dR, blur) * mix(grad, 1.0, uRing2.x);
  float cFull = cov(abs(r - R) - wa * 0.5, blur);
  float cRing = mix(max(cA, cR), cFull, uRing2.y) * uRing2.w;
  // 水线：胶囊
  float dL = length(d - vec2(clamp(d.x, -uLine.x, uLine.x), 0.0)) - uLine.y * 0.5;
  float cL = cov(dL, aa) * uLine.z;
  float m = max(cRing, cL);
  col = col * (1.0 - m) + vec4(IVORY, 1.0) * m;
  if (uDot.y > 0.0) {
    float core = cov(r - uDot.x, aa) * uDot.y;
    float halo = exp(-(r * r) / (uDot.z * uDot.z)) * 0.55 * uDot.y;
    vec3 warm = vec3(1.0, 0.965, 0.91);
    col.rgb = col.rgb * (1.0 - core) + warm * core;
    col.rgb += warm * halo * (1.0 - core);
    col.a = max(col.a, max(core, halo));
  }
  // 抖动防色带（预乘：透明处不加）
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
  col.rgb += (n - 0.5) / 255.0 * col.a;
  o = col;
}`;

const NAMES = ['uRes', 'uK', 'uView', 'uC', 'uRing', 'uRing2', 'uLine', 'uDot', 'uHole', 'uScene', 'uCam', 'uLook', 'uImg3', 'uImg', 'uDepth'];

/** 建渲染器；没有 WebGL2 返回 null（调用方走减弱动效那条路） */
export function createGate(canvas) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  } catch {}
  if (!gl) return null;
  const sh = (t, src) => {
    const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  let prog;
  try {
    prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  } catch { return null; }
  const U = {};
  for (const n of NAMES) U[n] = gl.getUniformLocation(prog, n);
  gl.bindVertexArray(gl.createVertexArray());

  const tex1 = (rgba) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    return t;
  };
  // 没有景深图的壁纸：整张图同一个深度，推镜就是均匀放大
  const tex = [tex1([15, 14, 12, 255]), tex1([128, 128, 128, 255])];
  let imgSz = [4, 3], W = 0, H = 0, k = 1, hasScene = false;

  function upload(i, src, mip) {
    gl.bindTexture(gl.TEXTURE_2D, tex[i]);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    // 推镜起步时画面比终帧小，洞边可能取到图外：镜像比钳边自然
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (mip) { gl.generateMipmap(gl.TEXTURE_2D); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR); }
    else gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  }
  // 上传壁纸常 4–6K：缩到「终帧 1 texel/px」再进 GPU，大纹理每像素多次取样全是缓存缺失。
  // 用 createImageBitmap 在主线程外缩放、解码好再传：开机时主线程正忙，同步缩放 + 上传会卡掉好几帧
  async function fit(img, maxPx) {
    const s = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * s)), h = Math.max(1, Math.round(img.naturalHeight * s));
    if (typeof createImageBitmap === 'function') {
      try { return await createImageBitmap(img, s < 0.999 ? { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' } : {}); } catch {}
    }
    if (s >= 0.999) return img;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(img, 0, 0, w, h);
    return c;
  }
  const loadImg = (src) => new Promise((res) => {
    if (!src) return res(null);
    const im = new Image();   // 同源，不设 crossOrigin（同 SpatialLayer）
    im.onload = () => (im.decode ? im.decode() : Promise.resolve()).catch(() => {}).then(() => res(im));
    im.onerror = () => res(null);
    im.src = src;
  });

  return {
    /** 载入壁纸（与景深图）；成功返回 true。图拿不到 / 被当成跨域污染画布时返回 false，洞里改为透明 */
    async load(url, depthUrl) {
      const [im, dp] = await Promise.all([loadImg(url), loadImg(depthUrl)]);
      if (!im) return false;
      try {
        const px = Math.max(screen.width || 0, screen.height || 0, innerWidth, innerHeight) * Math.min(3, devicePixelRatio || 1);
        const [a, b] = await Promise.all([fit(im, Math.max(1024, Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), px * 1.1))), dp ? fit(dp, 2048) : null]);
        upload(0, a, true);
        if (b) upload(1, b, false);
        for (const x of [a, b]) { try { x?.close?.(); } catch {} }
        imgSz = [im.naturalWidth, im.naturalHeight];
        hasScene = true;
      } catch { hasScene = false; }
      return hasScene;
    },
    get hasScene() { return hasScene; },
    resize(w, h, dpr) {
      const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
      W = w; H = h; k = bw / w;
    },
    draw(s) {
      if (!W) return;
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.useProgram(prog);
      gl.uniform2f(U.uRes, canvas.width, canvas.height);
      gl.uniform1f(U.uK, k);
      gl.uniform2f(U.uView, W, H);
      gl.uniform2f(U.uC, s.cx, s.cy);
      gl.uniform4f(U.uRing, s.R, s.wa, s.wr, s.gap);
      gl.uniform4f(U.uRing2, s.solid, s.full, s.blur, s.ringA);
      gl.uniform3f(U.uLine, s.half, s.lw, s.lineA);
      gl.uniform3f(U.uDot, s.dotR, s.dotA, s.dotHalo);
      gl.uniform1f(U.uHole, s.hole);
      gl.uniform1f(U.uScene, s.scene && hasScene ? 1 : 0);
      gl.uniform4f(U.uCam, s.e, s.Z, s.Dn, s.Df);
      gl.uniform4f(U.uLook, s.lod, s.expo, s.warm, s.ao);
      gl.uniform3f(U.uImg3, imgSz[0], imgSz[1], s.overscan || 1);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex[0]); gl.uniform1i(U.uImg, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tex[1]); gl.uniform1i(U.uDepth, 1);
      gl.disable(gl.BLEND);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    // 用完立即还给 GPU：开机后它一帧都不用再画，留着上下文会占一份显存
    destroy() { try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch {} },
  };
}
