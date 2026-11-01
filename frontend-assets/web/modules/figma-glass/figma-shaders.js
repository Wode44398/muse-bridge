// 自动生成，勿手改。来源：Figma 编辑器运行时（WebGPU）截获的着色器与管线描述。
// 生成脚本：tools/gen-shaders.js；截获数据：capture/modules2.json、capture/pipes2.json
export const FIGMA_SHADERS = {
 "loopBlinnSolidPaint": {
  "vertex": "struct UniformBlock{vertexTransform:mat3x3<f32>,coverTransform:mat3x3<f32>,color:vec4<f32>,alpha:f32,dummyPadding0_:f32,dummyPadding1_:f32,dummyPadding2_:f32,}struct c{@location(0)d:vec3<f32>,@builtin(position)e:vec4<f32>,}@group(0)@binding(0)var<uniform>f:UniformBlock;var<private>h:vec2<f32>;var<private>i:vec3<f32>;var<private>d:vec3<f32>;var<private>e:vec4<f32>;fn j(){let k=i;d=k;let l=f.vertexTransform;let m=h;let n=(l*vec3<f32>(m.x,m.y,1f));e=vec4<f32>(n.x,n.y,n.z,0f).xywz;let o=e;e.y=(o.y*-1f);return;}@vertex fn main(@location(0)p:vec2<f32>,@location(1)q:vec3<f32>)->c{h=p;i=q;j();let s=d;let t=e;return c(s,t);}",
  "fragment": "struct UniformBlock{vertexTransform:mat3x3<f32>,coverTransform:mat3x3<f32>,color:vec4<f32>,alpha:f32,dummyPadding0_:f32,dummyPadding1_:f32,dummyPadding2_:f32,}struct c{@location(0)fig_FragColor:vec4<f32>,}@group(0)@binding(0)var<uniform>d:UniformBlock;var<private>e:vec3<f32>;var<private>fig_FragColor:vec4<f32>;fn f(){let h=e;let i=e;let j=e;let k=e;let l=e;if(((h.x*i.x)*j.x)>(k.y*l.z)){{discard;}}else{return;}}@fragment fn main(@location(0)m:vec3<f32>)->c{e=m;f();let j=fig_FragColor;return c(j);}"
 },
 "solidColorPaintLoopBlinn": {
  "vertex": "struct UniformBlock{vertexTransform:mat3x3<f32>,coverTransform:mat3x3<f32>,color:vec4<f32>,alpha:f32,dummyPadding0_:f32,dummyPadding1_:f32,dummyPadding2_:f32,}struct c{@location(0)d:vec2<f32>,@builtin(position)e:vec4<f32>,}@group(0)@binding(0)var<uniform>f:UniformBlock;var<private>h:vec2<f32>;var<private>d:vec2<f32>;var<private>e:vec4<f32>;fn i(){let j=h;d=j;let k=f.coverTransform;let l=h;let m=(k*vec3<f32>(l.x,l.y,1f));e=vec4<f32>(m.x,m.y,m.z,0f).xywz;let n=e;e.y=(n.y*-1f);return;}@vertex fn main(@location(0)o:vec2<f32>)->c{h=o;i();let p=d;let q=e;return c(p,q);}",
  "fragment": "struct UniformBlock{vertexTransform:mat3x3<f32>,coverTransform:mat3x3<f32>,color:vec4<f32>,alpha:f32,dummyPadding0_:f32,dummyPadding1_:f32,dummyPadding2_:f32,}struct c{@location(0)fig_FragColor:vec4<f32>,}@group(0)@binding(0)var<uniform>d:UniformBlock;var<private>e:vec2<f32>;var<private>fig_FragColor:vec4<f32>;fn f(){let h=d.color;let i=d.alpha;fig_FragColor=(h*i);return;}@fragment fn main(@location(0)j:vec2<f32>)->c{e=j;f();let k=fig_FragColor;return c(k);}"
 },
 "downscaleTile": {
  "vertex": "struct UniformBlock{quad:vec4<f32>,source:vec4<f32>,}struct c{@location(0)d:vec2<f32>,@builtin(position)e:vec4<f32>,}@group(0)@binding(0)var<uniform>f:UniformBlock;var<private>h:vec2<f32>;var<private>d:vec2<f32>;var<private>e:vec4<f32>;fn i(){let j=f.source;let k=f.source;let l=h;d=mix(j.xy,k.zw,l);let m=f.quad;let n=f.quad;let o=h;let p=((mix(m.xy,n.zw,o)*2f)-vec2(1f));e=vec4<f32>(p.x,p.y,0f,1f);let q=e;e.y=(q.y*-1f);return;}@vertex fn main(@location(0)s:vec2<f32>)->c{h=s;i();let t=d;let m=e;return c(t,m);}",
  "fragment": "struct UniformBlock{quad:vec4<f32>,source:vec4<f32>,}struct c{@location(0)fig_FragColor:vec4<f32>,}@group(0)@binding(0)var<uniform>d:UniformBlock;@group(1)@binding(0)var texture0_:texture_2d<f32>;@group(1)@binding(1)var e:sampler;var<private>f:vec2<f32>;var<private>fig_FragColor:vec4<f32>;fn h(){let i=f;let j=textureSample(texture0_,e,i);fig_FragColor=j;return;}@fragment fn main(@location(0)k:vec2<f32>)->c{f=k;h();let l=fig_FragColor;return c(l);}"
 },
 "unclampedBlurTile": {
  "vertex": "struct UniformBlock{quad:vec4<f32>,blurDelta:vec2<f32>,count:f32,dummyPadding0_:f32,}struct c{@location(0)d:vec2<f32>,@builtin(position)e:vec4<f32>,}@group(0)@binding(0)var<uniform>f:UniformBlock;var<private>h:vec2<f32>;var<private>d:vec2<f32>;var<private>e:vec4<f32>;fn i(){let j=f.quad;let k=f.quad;let l=h;d=mix(j.xy,k.zw,l);let m=d;let n=((m*2f)-vec2(1f));e=vec4<f32>(n.x,n.y,0f,1f);let o=e;e.y=(o.y*-1f);return;}@vertex fn main(@location(0)p:vec2<f32>)->c{h=p;i();let q=d;let m=e;return c(q,m);}",
  "fragment": "struct UniformBlock{quad:vec4<f32>,blurDelta:vec2<f32>,count:f32,dummyPadding0_:f32,}struct c{@location(0)fig_FragColor:vec4<f32>,}const d:i32=64i;@group(0)@binding(0)var<uniform>e:UniformBlock;@group(1)@binding(0)var texture0_:texture_2d<f32>;@group(1)@binding(1)var f:sampler;var<private>h:vec2<f32>;var<private>fig_FragColor:vec4<f32>;fn i(){var j:f32;var k:vec4<f32>;var l:f32;var m:i32=1i;var n:f32;var o:f32;var p:vec2<f32>;var q:vec2<f32>;var s:vec2<f32>;var t:vec2<f32>;var u:f32;var v:f32;var ac:f32;var ad:vec2<f32>;var ae:vec2<f32>;let af=e.count;j=af;let ah=h;let ai=textureSample(texture0_,f,ah);let aj=j;k=(ai*aj);let ak=j;l=ak;loop{let al=m;if!((al<d)){break;}{let am=m;let an=e.count;if(f32(am)>an){{break;}}let ao=m;n=f32(ao);let ap=n;let aq=e.count;o=min((ap+1f),aq);let at=h;let au=e.blurDelta;let av=n;p=(at-(au*av));let aw=h;let ax=e.blurDelta;let ay=n;q=(aw+(ax*ay));let az=h;let bc=e.blurDelta;let bd=o;s=(az-(bc*bd));let be=h;let bf=e.blurDelta;let bh=o;t=(be+(bf*bh));let bi=e.count;let bj=n;u=(bi-bj);let bk=e.count;let bl=o;v=(bk-bl);let bm=u;let bn=v;ac=(bm+bn);let bo=p;let bp=u;let bq=s;let bs=v;let bt=ac;ad=(((bo*bp)+(bq*bs))/vec2(bt));let bu=q;let bv=u;let bw=t;let bx=v;let by=ac;ae=(((bu*bv)+(bw*bx))/vec2(by));let bz=k;let ca=ac;let cb=ad;let cc=textureSample(texture0_,f,cb);let cd=ae;let ce=textureSample(texture0_,f,cd);k=(bz+(ca*(cc+ce)));let cf=l;let cg=ac;l=(cf+(2f*cg));}continuing{let ch=m;m=(ch+2i);}}let ci=k;let cj=l;fig_FragColor=(ci/vec4(cj));return;}@fragment fn main(@location(0)ck:vec2<f32>)->c{h=ck;i();let cl=fig_FragColor;return c(cl);}"
 },
 "upscaleTile": {
  "vertex": "struct UniformBlock{quad:vec4<f32>,source:vec4<f32>,preserveOpaqueDitherAlpha:i32,dummyPadding0_:f32,dummyPadding1_:f32,dummyPadding2_:f32,}struct c{@location(0)d:vec2<f32>,@builtin(position)e:vec4<f32>,}@group(0)@binding(0)var<uniform>f:UniformBlock;var<private>h:vec2<f32>;var<private>d:vec2<f32>;var<private>e:vec4<f32>;fn i(){let j=f.source;let k=f.source;let l=h;d=mix(j.xy,k.zw,l);let m=f.quad;let n=f.quad;let o=h;let p=((mix(m.xy,n.zw,o)*2f)-vec2(1f));e=vec4<f32>(p.x,p.y,0f,1f);let q=e;e.y=(q.y*-1f);return;}@vertex fn main(@location(0)s:vec2<f32>)->c{h=s;i();let t=d;let m=e;return c(t,m);}",
  "fragment": "struct UniformBlock{quad:vec4<f32>,source:vec4<f32>,preserveOpaqueDitherAlpha:i32,dummyPadding0_:f32,dummyPadding1_:f32,dummyPadding2_:f32,}struct c{@location(0)fig_FragColor:vec4<f32>,}const d:f32=0.007843f;@group(0)@binding(0)var<uniform>e:UniformBlock;var<private>f:vec4<f32>;@group(1)@binding(0)var texture0_:texture_2d<f32>;@group(1)@binding(1)var h:sampler;var<private>i:vec2<f32>;var<private>fig_FragColor:vec4<f32>;fn j()->f32{var k:vec2<f32>;let l=f;k=l.xy;let m=k;return fract((sin(dot(vec2<f32>(12.9898f,78.233f),m))*43758.547f));}fn n(o:vec4<f32>)->vec4<f32>{var p:vec4<f32>;var q:f32;var s:vec4<f32>;var t:vec4<f32>;p=o;let u=j();q=((u-0.5f)*d);let v=p;if(v.w==0f){{let ac=p;return ac;}}let ad=p;let ae=q;s=min(abs((ad+vec4(ae))),vec4(1f));let af=e.preserveOpaqueDitherAlpha;let ah=p;if((af!=0i)&&(ah.w==1f)){let ai=s;let aj=ai.xyz;let ak=p;t=vec4<f32>(aj.x,aj.y,aj.z,ak.w);}else{let al=s;t=al;}let am=t;return am;}fn an(){let ao=i;let ap=textureSample(texture0_,h,ao);let m=n(ap);fig_FragColor=m;return;}@fragment fn main(@builtin(position)aq:vec4<f32>,@location(0)at:vec2<f32>)->c{f=aq;i=at;an();let ae=fig_FragColor;return c(ae);}"
 },
 "maskKnockoutShadowTile": {
  "vertex": "struct UniformBlock{quad:vec4<f32>,}struct c{@location(0)d:vec2<f32>,@builtin(position)e:vec4<f32>,}@group(0)@binding(0)var<uniform>f:UniformBlock;var<private>h:vec2<f32>;var<private>d:vec2<f32>;var<private>e:vec4<f32>;fn i(){let j=f.quad;let k=f.quad;let l=h;d=mix(j.xy,k.zw,l);let m=d;let n=((m*2f)-vec2(1f));e=vec4<f32>(n.x,n.y,0f,1f);let o=e;e.y=(o.y*-1f);return;}@vertex fn main(@location(0)p:vec2<f32>)->c{h=p;i();let q=d;let m=e;return c(q,m);}",
  "fragment": "struct UniformBlock{quad:vec4<f32>,}struct c{@location(0)fig_FragColor:vec4<f32>,}@group(0)@binding(0)var<uniform>d:UniformBlock;@group(1)@binding(0)var texture0_:texture_2d<f32>;@group(1)@binding(1)var e:sampler;@group(1)@binding(2)var texture1_:texture_2d<f32>;@group(1)@binding(3)var f:sampler;var<private>h:vec2<f32>;var<private>fig_FragColor:vec4<f32>;fn i(){let j=h;let k=textureSample(texture0_,e,j);let l=h;let m=textureSample(texture1_,f,l);fig_FragColor=(k*select(0f,1f,(m.w==0f)));return;}@fragment fn main(@location(0)n:vec2<f32>)->c{h=n;i();let o=fig_FragColor;return c(o);}"
 },
 "copyTile": {
  "vertex": "struct UniformBlock{quad:vec4<f32>,}struct c{@location(0)d:vec2<f32>,@location(1)e:vec2<f32>,@builtin(position)f:vec4<f32>,}@group(0)@binding(0)var<uniform>h:UniformBlock;var<private>i:vec2<f32>;var<private>d:vec2<f32>;var<private>e:vec2<f32>;var<private>f:vec4<f32>;fn j(){let k=i;d=k;let l=h.quad;let m=h.quad;let n=i;let o=mix(l.xy,m.zw,n);f=vec4<f32>(o.x,o.y,0f,1f);let p=f;f.y=(p.y*-1f);e=vec2(0f);return;}@vertex fn main(@location(0)q:vec2<f32>)->c{i=q;j();let n=d;let s=e;let t=f;return c(n,s,t);}",
  "fragment": "struct UniformBlock{quad:vec4<f32>,}struct c{@location(0)fig_FragColor:vec4<f32>,}@group(0)@binding(0)var<uniform>d:UniformBlock;@group(1)@binding(0)var texture0_:texture_2d<f32>;@group(1)@binding(1)var e:sampler;var<private>f:vec2<f32>;var<private>fig_FragColor:vec4<f32>;fn h(){let i=f;let j=textureSample(texture0_,e,i);fig_FragColor=j;return;}@fragment fn main(@location(0)k:vec2<f32>)->c{f=k;h();let l=fig_FragColor;return c(l);}"
 },
 "blendTileSimple": {
  "vertex": "struct UniformBlock{quad:vec4<f32>,alpha:f32,dummyPadding0_:f32,dummyPadding1_:f32,dummyPadding2_:f32,}struct c{@location(0)d:vec2<f32>,@builtin(position)e:vec4<f32>,}@group(0)@binding(0)var<uniform>f:UniformBlock;var<private>h:vec2<f32>;var<private>d:vec2<f32>;var<private>e:vec4<f32>;fn i(){let j=f.quad;let k=f.quad;let l=h;d=mix(j.xy,k.zw,l);let m=d;let n=((m*2f)-vec2(1f));e=vec4<f32>(n.x,n.y,0f,1f);let o=e;e.y=(o.y*-1f);return;}@vertex fn main(@location(0)p:vec2<f32>)->c{h=p;i();let q=d;let m=e;return c(q,m);}",
  "fragment": "struct UniformBlock{quad:vec4<f32>,alpha:f32,dummyPadding0_:f32,dummyPadding1_:f32,dummyPadding2_:f32,}struct c{@location(0)fig_FragColor:vec4<f32>,}@group(0)@binding(0)var<uniform>d:UniformBlock;@group(1)@binding(0)var texture0_:texture_2d<f32>;@group(1)@binding(1)var e:sampler;var<private>f:vec2<f32>;var<private>fig_FragColor:vec4<f32>;fn h(){let i=f;let j=textureSample(texture0_,e,i);let k=d.alpha;fig_FragColor=(j*k);return;}@fragment fn main(@location(0)l:vec2<f32>)->c{f=l;h();let m=fig_FragColor;return c(m);}"
 },
 "blendTileCustom": {
  "vertex": "struct UniformBlock{quad:vec4<f32>,type_:i32,alpha:f32,dummyPadding0_:f32,dummyPadding1_:f32,}struct c{@location(0)d:vec2<f32>,@builtin(position)e:vec4<f32>,}@group(0)@binding(0)var<uniform>f:UniformBlock;var<private>h:vec2<f32>;var<private>d:vec2<f32>;var<private>e:vec4<f32>;fn i(){let j=f.quad;let k=f.quad;let l=h;d=mix(j.xy,k.zw,l);let m=d;let n=((m*2f)-vec2(1f));e=vec4<f32>(n.x,n.y,0f,1f);let o=e;e.y=(o.y*-1f);return;}@vertex fn main(@location(0)p:vec2<f32>)->c{h=p;i();let q=d;let m=e;return c(q,m);}",
  "fragment": "struct UniformBlock{quad:vec4<f32>,type_:i32,alpha:f32,dummyPadding0_:f32,dummyPadding1_:f32,}struct c{@location(0)fig_FragColor:vec4<f32>,}const d:f32=0.003922f;@group(0)@binding(0)var<uniform>e:UniformBlock;@group(1)@binding(0)var texture0_:texture_2d<f32>;@group(1)@binding(1)var f:sampler;@group(1)@binding(2)var texture1_:texture_2d<f32>;@group(1)@binding(3)var h:sampler;var<private>i:vec2<f32>;var<private>fig_FragColor:vec4<f32>;fn j(k:vec3<f32>)->f32{var l:vec3<f32>;l=k;let m=l;let n=l;let o=l;return min(min(m.x,n.y),o.z);}fn p(q:vec3<f32>)->f32{var s:vec3<f32>;s=q;let m=s;let n=s;let o=s;return max(max(m.x,n.y),o.z);}fn t(u:vec3<f32>)->f32{var v:vec3<f32>;v=u;let m=v;let ac=p(m);let n=v;let ad=j(n);return(ac-ad);}fn ae(af:vec3<f32>)->f32{var ah:vec3<f32>;ah=af;let m=ah;return dot(m,vec3<f32>(0.3f,0.59f,0.11f));}fn ai(aj:vec3<f32>,ak:vec3<f32>)->vec3<f32>{var al:vec3<f32>;var am:vec3<f32>;var an:f32;var ao:vec3<f32>;var ap:f32;var aq:f32;al=aj;am=ak;let n=al;al=clamp(n,vec3(0f),vec3(1f));let at=am;am=clamp(at,vec3(0f),vec3(1f));let au=am;let av=ae(au);an=av;let aw=al;let ax=an;let ay=al;let az=ae(ay);ao=(aw+vec3((ax-az)));let bc=ao;let bd=j(bc);ap=bd;let be=ao;let bf=p(be);aq=bf;let bh=ap;if(bh<0f){{let bi=an;let bj=ao;let bk=an;let bl=an;let bm=ap;ao=mix(vec3(bi),bj,vec3((bk/(bl-bm))));}}else{let bn=aq;if(bn>1f){{let bo=an;let bp=ao;let bq=an;let bs=aq;let bt=an;ao=mix(vec3(bo),bp,vec3(((1f-bq)/(bs-bt))));}}}let bu=ao;return bu;}fn bv(bw:vec3<f32>,bx:vec3<f32>,by:vec3<f32>)->vec3<f32>{var bz:vec3<f32>;var ca:vec3<f32>;var cb:vec3<f32>;var cc:f32;var cd:vec3<f32>=vec3(0f);var ce:f32;var cf:f32;bz=bw;ca=bx;cb=by;let cg=bz;let o=t(cg);cc=o;let ch=cc;if(ch>0f){{let ci=bz;let au=j(ci);ce=au;let cj=ca;let aw=t(cj);cf=aw;let ay=bz;let az=ce;let ck=cf;let bc=cc;cd=(((ay-vec3(az))*ck)/vec3(bc));}}let be=cd;let bf=cb;let cl=ai(be,bf);return cl;}fn cm(cn:vec4<f32>,co:vec4<f32>,cp:i32)->vec4<f32>{var cq:vec4<f32>;var cr:vec4<f32>;var cs:i32;var ct:i32=2i;var cu:i32=3i;var cv:i32=4i;var cw:i32=5i;var cx:i32=6i;var cy:i32=7i;var cz:i32=8i;var da:i32=9i;var db:i32=10i;var dc:i32=11i;var dd:i32=12i;var de:i32=13i;var df:i32=14i;var dg:i32=15i;var dh:i32=16i;var di:i32=17i;var dj:i32=18i;var dk:f32;var dl:f32;var dm:vec3<f32>;var dn:f32=0.000001f;var dp:vec3<f32>;var dq:vec3<f32>;var dr:vec3<f32>;var ds:vec3<f32>;var dt:vec3<f32>;var du:vec3<f32>;var dv:vec3<f32>=vec3(0f);var dw:vec3<f32>;var dx:vec3<f32>;var dy:vec3<f32>;var dz:vec3<f32>;var ea:vec3<f32>;var eb:vec3<f32>;cq=cn;cr=co;cs=cp;let bl=cq;dk=bl.w;let ec=cr;dl=ec.w;let bn=cr;dm=bn.xyz;let bo=dk;if(bo==0f){{let ed=dm;let bq=dl;return vec4<f32>(ed.x,ed.y,ed.z,bq);}}let ee=cq;dp=ee.xyz;let ef=dp;let eg=dl;let eh=dm;let ei=dk;dq=((ef*(1f-eg))+(eh*(1f-ei)));let ej=cs;let ek=ct;if(ej==ek){{let el=dq;let em=dp;let en=dl;let eo=dm;let ep=dk;dq=(el+min((em*en),(eo*ep)));}}else{let eq=cs;let er=cu;if(eq==er){{let es=dq;let et=dp;let eu=dm;dq=(es+(et*eu));}}else{let ev=cs;let ew=cv;if(ev==ew){{let ex=dp;let ey=dm;let ez=dk;let fa=dl;dq=max(vec3(0f),((ex+ey)-vec3((ez*fa))));}}else{let fb=cs;let fc=cw;if(fb==fc){{let fd=dp;let fe=dl;dr=max((fd*fe),vec3(0.003922f));let ff=dl;let fg=dm;let fh=dk;let fi=dl;let fj=dm;ds=(((vec3(ff)-fg)*fh)*step(vec3(0.003922f),(vec3(fi)-fj)));let fk=dq;let fl=dk;let fm=dl;let fo=ds;let fp=dr;dq=(fk+((fl*fm)*(vec3(1f)-min(vec3(1f),(fo/fp)))));}}else{let fq=cs;let fr=cx;if(fq==fr){{let fs=dq;let ft=dp;let fu=dl;let fv=dm;let fw=dk;dq=(fs+max((ft*fu),(fv*fw)));}}else{let fx=cs;let fy=cy;if(fx==fy){{let fz=dp;let gc=dm;let gd=dp;let ge=dm;dq=((fz+gc)-(gd*ge));}}else{let gf=cs;let gh=cz;if(gf==gh){{let gi=dp;let gj=dm;dq=min(vec3(1f),(gi+gj));}}else{let gk=cs;let gl=da;if(gk==gl){{let gm=dl;let gn=dk;let go=dp;dt=max((gm*(vec3(gn)-go)),vec3(0.003922f));let gp=dm;let gq=dk;let gs=dm;du=((gp*gq)*step(vec3(0.003922f),gs));let gt=dq;let gu=dk;let gv=dl;let gw=du;let gx=dt;dq=(gt+((gu*gv)*min(vec3(1f),(gw/gx))));}}else{let gy=cs;let gz=db;if(gy==gz){{let ha=dq;let hb=dk;let hc=dl;let hd=dl;let he=dm;let hf=dk;let hg=dp;let hh=dp;let hi=dm;let hj=dm;let hk=dl;dq=(ha+mix((vec3((hb*hc))-((2f*(vec3(hd)-he))*(vec3(hf)-hg))),((2f*hh)*hi),select(vec3(0f),vec3(1f),((2f*hj)<=vec3(hk)))));}}else{let hl=cs;let hm=dd;if(hl==hm){{let hn=dq;let ho=dp;let hp=dm;let hq=dk;let hr=dl;let hs=dl;let ht=dm;let hu=dk;let hv=dp;let hw=dp;let hx=dk;dq=(hn+mix(((2f*ho)*hp),(vec3((hq*hr))-((2f*(vec3(hs)-ht))*(vec3(hu)-hv))),select(vec3(0f),vec3(1f),((2f*hw)>vec3(hx)))));}}else{let hy=cs;let hz=de;if(hy==hz){{let ia=dq;let ib=dm;let ic=dk;let ie=dp;let ig=dl;dq=(ia+abs(((ib*ic)-(ie*ig))));}}else{let ih=cs;let ii=df;if(ih==ii){{let ij=dq;let ik=dp;let il=dl;let im=dm;let io=dk;let ip=dp;let iq=dm;dq=(ij+(((ik*il)+(im*io))-((2f*ip)*iq)));}}else{{let ir=dp;dw=ir;let is=dm;dx=is;let it=dk;if(it>0f){let iu=dw;let iv=dk;dw=(iu/vec3(iv));}let iw=dl;if(iw>0f){let ix=dx;let iy=dl;dx=(ix/vec3(iy));}let iz=cs;let ja=dc;if(iz==ja){{let jb=dx;dy=(vec3(1f)-jb);let jc=dx;let jd=dx;dz=((((16f*jc)-vec3(12f))*jd)+vec3(3f));let je=dx;let jf=dn;ea=(inverseSqrt((je+vec3(jf)))-vec3(1f));let jg=dz;let jh=ea;let ji=dx;eb=mix(jg,jh,select(vec3(0f),vec3(1f),(ji>vec3(0.25f))));let jj=eb;let jk=dy;let jl=dw;eb=mix(jj,jk,select(vec3(0f),vec3(1f),(jl>vec3(0.5f))));let jm=dx;let jn=eb;let jo=dw;dv=(jm*(vec3(1f)+(jn*((2f*jo)-vec3(1f)))));}}else{let jp=cs;let jq=dg;if(jp==jq){{let jr=dw;let js=dx;let jt=dx;let ju=bv(jr,js,jt);dv=ju;}}else{let jv=cs;let jw=dh;if(jv==jw){{let jx=dx;let jy=dw;let jz=dx;let ka=bv(jx,jy,jz);dv=ka;}}else{let kb=cs;let kc=di;if(kb==kc){{let kd=dw;let ke=dx;let kf=ai(kd,ke);dv=kf;}}else{let kg=cs;let kh=dj;if(kg==kh){{let ki=dx;let kj=dw;let kk=ai(ki,kj);dv=kk;}}}}}}let kl=dq;let km=dk;let kn=dl;let ko=dv;dq=(kl+((km*kn)*ko));}}}}}}}}}}}}}let kp=dq;let kq=dk;let kr=dl;let ks=dk;let kt=dl;return vec4<f32>(kp.x,kp.y,kp.z,((kq+kr)-(ks*kt)));}fn ku(){var kv:vec4<f32>;var kw:vec4<f32>;let cg=i;let o=textureSample(texture0_,f,cg);let kx=e.alpha;kv=(o*kx);let ky=i;let ch=textureSample(texture1_,h,ky);kw=ch;let kz=kv;let ci=kw;let au=e.type_;let av=cm(kz,ci,au);fig_FragColor=av;return;}@fragment fn main(@location(0)la:vec2<f32>)->c{i=la;ku();let au=fig_FragColor;return c(au);}"
 },
 "maskKnockoutShadowTilePassThrough": {
  "vertex": "struct UniformBlock{quad:vec4<f32>,useBinaryKnockoutMask:i32,dummyPadding0_:f32,dummyPadding1_:f32,dummyPadding2_:f32,}struct c{@location(0)d:vec2<f32>,@builtin(position)e:vec4<f32>,}@group(0)@binding(0)var<uniform>f:UniformBlock;var<private>h:vec2<f32>;var<private>d:vec2<f32>;var<private>e:vec4<f32>;fn i(){let j=f.quad;let k=f.quad;let l=h;d=mix(j.xy,k.zw,l);let m=d;let n=((m*2f)-vec2(1f));e=vec4<f32>(n.x,n.y,0f,1f);let o=e;e.y=(o.y*-1f);return;}@vertex fn main(@location(0)p:vec2<f32>)->c{h=p;i();let q=d;let m=e;return c(q,m);}",
  "fragment": "struct UniformBlock{quad:vec4<f32>,useBinaryKnockoutMask:i32,dummyPadding0_:f32,dummyPadding1_:f32,dummyPadding2_:f32,}struct c{@location(0)fig_FragColor:vec4<f32>,}@group(0)@binding(0)var<uniform>d:UniformBlock;@group(1)@binding(0)var texture0_:texture_2d<f32>;@group(1)@binding(1)var e:sampler;@group(1)@binding(2)var texture1_:texture_2d<f32>;@group(1)@binding(3)var f:sampler;@group(1)@binding(4)var texture2_:texture_2d<f32>;@group(1)@binding(5)var h:sampler;var<private>i:vec2<f32>;var<private>fig_FragColor:vec4<f32>;fn j(){var k:f32;var l:f32;var m:vec4<f32>;var n:vec4<f32>;let o=i;let p=textureSample(texture2_,h,o);k=p.w;let q=k;l=select(0f,1f,(q==0f));let s=i;let t=textureSample(texture1_,f,s);m=t;let u=i;let v=textureSample(texture0_,e,u);n=v;let ac=d.useBinaryKnockoutMask;if(ac!=0i){{let ad=m;let ae=n;let af=l;fig_FragColor=mix(ad,ae,vec4(af));return;}}else{{let ah=n;let ai=l;let aj=m;let ak=k;fig_FragColor=mix((ah*ai),aj,vec4(ak));return;}}}@fragment fn main(@location(0)al:vec2<f32>)->c{i=al;j();let s=fig_FragColor;return c(s);}"
 },
 "glass": {
  "vertex": "struct UniformBlock{nodeToTileSpace:mat3x3<f32>,tileToNodeSpace:mat3x3<f32>,quad:vec4<f32>,cornerRadii:vec4<f32>,cornerSmoothings:vec4<f32>,tintColor:vec4<f32>,directCompositeBackgroundColor:vec4<f32>,nodeSpaceCenterPoint:vec2<f32>,maskTextureSize:f32,hasUniformCorners:i32,tileExpansionScale:f32,splay:f32,frameRotation:f32,refractionIntensity:f32,refractionDistance:f32,lightIntensity:f32,lightAngle:f32,bevelSize:f32,chromaticAberration:f32,directComposite:i32,textureMaskDirectComposite:i32,dummyPadding0_:f32,}struct c{@location(0)d:vec2<f32>,@builtin(position)e:vec4<f32>,}@group(0)@binding(0)var<uniform>f:UniformBlock;var<private>h:vec2<f32>;var<private>d:vec2<f32>;var<private>e:vec4<f32>;fn i(){let j=f.quad;let k=f.quad;let l=h;d=mix(j.xy,k.zw,l);let m=d;let n=((m*2f)-vec2(1f));e=vec4<f32>(n.x,n.y,0f,1f);let o=e;e.y=(o.y*-1f);return;}@vertex fn main(@location(0)p:vec2<f32>)->c{h=p;i();let q=d;let m=e;return c(q,m);}",
  "fragment": "struct UniformBlock{nodeToTileSpace:mat3x3<f32>,tileToNodeSpace:mat3x3<f32>,quad:vec4<f32>,cornerRadii:vec4<f32>,cornerSmoothings:vec4<f32>,tintColor:vec4<f32>,directCompositeBackgroundColor:vec4<f32>,nodeSpaceCenterPoint:vec2<f32>,maskTextureSize:f32,hasUniformCorners:i32,tileExpansionScale:f32,splay:f32,frameRotation:f32,refractionIntensity:f32,refractionDistance:f32,lightIntensity:f32,lightAngle:f32,bevelSize:f32,chromaticAberration:f32,directComposite:i32,textureMaskDirectComposite:i32,dummyPadding0_:f32,}struct c{@location(0)fig_FragColor:vec4<f32>,}const d:i32=2i;const e:i32=3i;const f:f32=1f;const h:f32=1.5707964f;const i:f32=0.35f;const j:f32=0.6f;const k:f32=0.2f;const l:f32=3.5f;const m:f32=0.2f;const n:f32=0.05f;const o:i32=8i;@group(0)@binding(0)var<uniform>p:UniformBlock;@group(1)@binding(0)var texture0_:texture_2d<f32>;@group(1)@binding(1)var q:sampler;@group(1)@binding(2)var texture1_:texture_2d<f32>;@group(1)@binding(3)var s:sampler;var<private>t:vec2<f32>;var<private>fig_FragColor:vec4<f32>;fn u(v:vec2<f32>)->vec2<f32>{var ac:vec2<f32>;var ad:f32;var ae:vec2<f32>;ac=v;let af=ac;let ah=ac;ad=dot(af,ah);let ai=ad;if(ai>0.0000000001f){let aj=ac;let ak=ad;ae=(aj/vec2(sqrt(ak)));}else{ae=vec2<f32>(0f,0f);}let al=ae;return al;}fn am(an:vec2<f32>,ao:vec2<f32>)->f32{var ap:vec2<f32>;var aq:vec2<f32>;var at:vec2<f32>;ap=an;aq=ao;let au=ap;let ai=aq;at=(abs(au)-ai);let aj=at;let av=at;let aw=at;return(length(max(aj,vec2(0f)))+min(max(av.x,aw.y),0f));}fn ax(ay:vec2<f32>,az:vec2<f32>,bc:f32)->f32{var bd:vec2<f32>;var be:vec2<f32>;var bf:f32;var bh:f32;bd=ay;be=az;bf=bc;let ai=bf;let bi=be;let aj=be;bh=min(ai,min(bi.x,aj.y));let av=bd;let bj=be;let aw=bh;let bk=am(av,(bj-vec2(aw)));let bl=bh;return(bk-bl);}fn bm(bn:vec2<f32>,bo:vec2<f32>,bp:vec4<f32>)->f32{var bq:vec2<f32>;var bs:vec2<f32>;var bt:vec4<f32>;var bu:f32=-9999999f;var size:vec2<f32>;bq=bn;bs=bo;bt=bp;let aj=bs;size=(aj*2f);let bv=bu;let av=bq;let bk=bs;let bw=size;let bx=bt;let by=ax(((av*vec2<f32>(1f,1f))+bk),bw,bx.x);bu=max(bv,by);let bz=bu;let ca=bq;let cb=bs;let cc=size;let cd=bt;let ce=ax(((ca*vec2<f32>(-1f,1f))+cb),cc,cd.y);bu=max(bz,ce);let cf=bu;let cg=bq;let ch=bs;let ci=size;let cj=bt;let ck=ax(((cg*vec2<f32>(-1f,-1f))+ch),ci,cj.z);bu=max(cf,ck);let cl=bu;let cm=bq;let cn=bs;let co=size;let cp=bt;let cq=ax(((cm*vec2<f32>(1f,-1f))+cn),co,cp.w);bu=max(cl,cq);let cr=bu;return cr;}fn cs(ct:f32)->mat2x2<f32>{var cu:f32;var cv:f32;var cw:f32;cu=ct;let af=cu;cv=cos(af);let cx=cu;cw=sin(cx);let cy=cv;let aj=cw;let cz=cw;let da=cv;return mat2x2<f32>(vec2<f32>(cy,-(aj)),vec2<f32>(cz,da));}fn db(a:f32,b:f32,dc:f32,dd:ptr<function,vec3<f32>>)->i32{var de:f32;var df:f32;var dg:f32;var dh:f32;var di:f32;var dj:f32;var dk:f32;var dl:f32;var z:f32;var dm:f32;var dn:f32;var dp:f32;var dq:f32;var dr:f32;var ds:f32;var dt:f32;var du:f32;var dv:vec3<f32>;var dw:vec3<f32>;de=a;df=b;dg=dc;let ak=df;let cz=de;let da=de;dh=(ak-((cz*da)/3f));let al=de;let bl=de;let bx=de;let dx=df;let dy=dg;di=(((al*(((2f*bl)*bx)-(9f*dx)))/27f)+dy);let dz=dh;let cc=dh;let ea=dh;dj=((dz*cc)*ea);let cf=di;let cg=di;let eb=dj;dk=((cf*cg)+((4f*eb)/27f));let ci=de;dl=(-(ci)/3f);let cl=dk;if(cl>=0f){{let ec=dk;z=sqrt(ec);let ed=di;let ee=z;dm=((-(ed)+ee)/2f);let ef=di;let eg=z;dn=((-(ef)-eg)/2f);let eh=dm;let ei=dm;dm=(sign(eh)*pow(abs(ei),0.33333334f));let ej=dn;let ek=dn;dn=(sign(ej)*pow(abs(ek),0.33333334f));let el=dl;let em=dm;let en=dn;(*dd)[0i]=((el+em)+en);let eo=(*dd).x;let ep=de;let eq=(*dd).x;let er=df;let es=(*dd).x;let et=dg;dp=(((((eo+ep)*eq)+er)*es)+et);let eu=(*dd).x;let ev=de;let ew=(*dd).x;let ex=df;dq=((((3f*eu)+(2f*ev))*ew)+ex);let ey=(*dd).x;let ez=dp;let fa=dq;(*dd)[0i]=(ey-(ez/fa));return 1i;}}let fb=dh;dr=sqrt((-(fb)/3f));let fc=dj;let fd=di;ds=(acos(((-(sqrt((-27f/fc)))*fd)/2f))/3f);let fe=ds;dt=cos(fe);let ff=ds;du=(sin(ff)*1.7320508f);let fg=dl;let fh=dr;let fi=dt;let fj=dt;(*dd)[0i]=(fg+(fh*(fi+fj)));let fk=dl;let fl=dr;let fm=du;let fo=dt;(*dd)[1i]=(fk-(fl*(fm+fo)));let fp=dl;let fq=dr;let fr=du;let fs=dt;(*dd)[2i]=(fp+(fq*(fr-fs)));let ft=(*dd);let fu=de;let fv=(*dd);let fw=df;let fx=(*dd);let fy=dg;dv=(((((ft+vec3(fu))*fv)+vec3(fw))*fx)+vec3(fy));let fz=(*dd);let gc=de;let gd=(*dd);let ge=df;dw=((((3f*fz)+vec3((2f*gc)))*gd)+vec3(ge));let gf=(*dd);let gh=dv;let gi=dw;(*dd)=(gf-(gh/gi));return 3i;}fn gj(gk:vec2<f32>,gl:vec2<f32>,gm:vec2<f32>,gn:vec2<f32>,go:vec2<f32>)->f32{var gp:vec2<f32>;var gq:vec2<f32>;var gs:vec2<f32>;var gt:vec2<f32>;var gu:vec2<f32>;var gv:f32;var gw:f32;var gx:f32;var gy:f32;var gz:vec3<f32>;var ha:i32;var hb:i32=0i;var hc:i32=0i;var hd:f32;var he:f32;var hf:vec2<f32>;var hg:vec2<f32>;var hh:vec2<f32>;var hi:vec2<f32>;gp=gk;gq=gl;gs=gm;gt=gn;gu=go;let bv=gq;let hj=gs;let bx=gt;let bz=gu;gv=(((-(bv.y)+(3f*hj.y))-(3f*bx.y))+bz.y);let dy=gq;let cc=gs;let cf=gt;gw=(((3f*dy.y)-(6f*cc.y))+(3f*cf.y));let hk=gq;let cj=gs;gx=((-3f*hk.y)+(3f*cj.y));let cm=gq;let ec=gp;gy=(cm.y-ec.y);let ee=gw;let co=gv;let hl=gx;let cq=gv;let cr=gy;let eg=gv;let hm=db((ee/co),(hl/cq),(cr/eg),(&gz));ha=hm;loop{let hn=hc;if!((hn<3i)){break;}{let ho=hc;let hp=ha;if(ho<hp){{let hq=hc;let hr=gz[hq];let el=hc;let hs=gz[el];if((hr>=0f)&&(hs<=1f)){{let ht=hc;let ep=gz[ht];hd=ep;let hu=gq;let er=gs;let hv=gt;let hw=gu;let eu=hd;let ev=gq;let hx=gs;let hy=gt;let ey=hd;let hz=gq;let ia=gs;let ib=hd;let ic=gq;he=(((((((((-(hu.x)+(3f*er.x))-(3f*hv.x))+hw.x)*eu)+(((3f*ev.x)-(6f*hx.x))+(3f*hy.x)))*ey)+((-3f*hz.x)+(3f*ia.x)))*ib)+ic.x);let ie=he;let ig=gp;if(ie<ig.x){{let ih=hb;hb=(ih+1i);}}}}}}}continuing{let ej=hc;hc=(ej+1i);}}let fe=gq;let ii=gs;hf=(fe.xy-ii.xy);let ij=gt;let ik=gu;hg=(ij.xy-ik.xy);let fi=hf;let il=hf;hh=vec2<f32>(fi.y,-(il.x));let fk=hg;let fm=hg;hi=vec2<f32>(fk.y,-(fm.x));let im=gq;let fp=gs;if(im.y<fp.y){{let fs=gp;let io=gq;let fu=gp;let ip=gq;let iq=hh;if((fs.y<=io.y)&&(dot((fu-ip.xy),iq)<0f)){{let ir=hb;hb=(ir+1i);}}}}else{{let is=gp;let it=gq;let gc=gp;let iu=gq;let gd=hh;if(!((is.y<=it.y))&&!((dot((gc-iu.xy),gd)<0f))){{let gf=hb;hb=(gf+1i);}}}}let iv=gt;let iw=gu;if(iv.y<iw.y){{let ix=gp;let iy=gu;let iz=gp;let ja=gu;let jb=hi;if(!((ix.y<=iy.y))&&(dot((iz-ja.xy),jb)<0f)){{let jc=hb;hb=(jc+1i);}}}}else{{let jd=gp;let je=gu;let jf=gp;let jg=gu;let jh=hi;if((jd.y<=je.y)&&!((dot((jf-jg.xy),jh)<0f))){{let ji=hb;hb=(ji+1i);}}}}let jj=hb;let jk=hb;let jl=hb;if(((jj==0i)||(jk==2i))||(jl==4i)){{return 1f;}}else{{return-1f;}}}fn jm(jn:f32,jo:vec2<f32>,jp:vec2<f32>,jq:vec2<f32>,jr:vec2<f32>)->f32{var js:f32;var jt:vec2<f32>;var ju:vec2<f32>;var jv:vec2<f32>;var jw:vec2<f32>;var jx:vec2<f32>;var jy:vec2<f32>;var jz:vec2<f32>;var ka:vec2<f32>;var kb:vec2<f32>;var kc:f32;var kd:f32;js=jn;jt=jo;ju=jp;jv=jq;jw=jr;let bv=jv;let av=js;let bj=jw;jx=(bv+(av*bj));let bk=ju;let bl=js;let bw=jx;jy=(bk+(bl*bw));let dx=jx;let bz=js;let ca=jw;jz=(dx+(bz*ca));let dy=jt;let ke=js;let cb=jy;ka=(dy+(ke*cb));let ea=jy;let ce=js;let kf=jz;kb=(ea+(ce*kf));let kg=kb;let eb=kb;kc=dot(kg,eb);let hk=kb;let ch=ka;kd=dot(hk,ch);let cj=js;let kh=kd;let ki=kc;return(cj-((f*kh)/ki));}fn kj(kk:vec2<f32>,kl:vec2<f32>,km:vec2<f32>,kn:vec2<f32>,ko:vec2<f32>)->f32{var kp:vec2<f32>;var kq:vec2<f32>;var kr:vec2<f32>;var ks:vec2<f32>;var kt:vec2<f32>;var ku:vec2<f32>;var kv:vec2<f32>;var kw:vec2<f32>;var kx:vec2<f32>;var ky:f32=100000000000000000000000000000000000000f;var kz:f32=0f;var la:f32;var lb:i32=0i;var lc:i32;var ld:vec2<f32>;kp=kk;kq=kl;kr=km;ks=kn;kt=ko;let bv=kq;let aw=kr;let bl=ks;let le=kt;ku=(((-(bv)+(3f*aw))-(3f*bl))+le);let ca=kq;let lf=kr;let dz=ks;kv=(((3f*ca)-(6f*lf))+(3f*dz));let cf=kq;let kg=kr;kw=((-3f*cf)+(3f*kg));let hk=kq;let ch=kp;kx=(hk-ch);loop{let ec=lb;if!((ec<e)){break;}{let co=kz;la=co;lc=0i;loop{let cq=lc;if!((cq<d)){break;}{let lg=la;let hm=kx;let eh=kw;let lh=kv;let ei=ku;let li=jm(lg,hm,eh,lh,ei);la=li;}continuing{let eg=lc;lc=(eg+1i);}}let lj=la;la=clamp(lj,0f,1f);let lk=ku;let ej=la;let ek=kv;let hp=la;let hq=kw;let hr=la;let ll=kx;ld=((((((lk*ej)+ek)*hp)+hq)*hr)+ll);let hs=ky;let en=ld;let lm=ld;ky=min(hs,dot(en,lm));let eo=kz;kz=(eo+0.5f);}continuing{let ed=lb;lb=(ed+1i);}}let ln=ky;return ln;}fn lo(lp:vec2<f32>,lq:vec2<f32>,lr:vec2<f32>,ls:vec2<f32>,lt:vec2<f32>)->f32{var lu:vec2<f32>;var lv:vec2<f32>;var lw:vec2<f32>;var lx:vec2<f32>;var ly:vec2<f32>;lu=lp;lv=lq;lw=lr;lx=ls;ly=lt;let bv=lu;let av=lv;let bj=lw;let aw=lx;let hj=ly;let al=kj(bv,av,bj,aw,hj);return sqrt(al);}fn lz(ma:vec2<f32>,mb:f32,mc:f32)->f32{var md:vec2<f32>;var me:f32;var mf:f32;var mg:f32=3.1415927f;var mh:f32;var mi:f32=1.4142135f;var mj:f32;var mk:f32;var ml:f32;var mm:f32;var mn:f32;var mo:f32;var mp:f32;var mq:f32;var mr:f32;var ms:vec2<f32>;var mt:f32;var mu:vec2<f32>;var mv:vec2<f32>;var mw:vec2<f32>;var mx:vec2<f32>;var my:vec2<f32>;var mz:f32;var na:f32;md=ma;me=mb;mf=mc;let cz=mg;mh=(cz*0.5f);let al=mh;let bl=mf;mj=((0.5f*al)*bl);let le=mh;let dx=mf;mk=(le*(1f-dx));let lf=mf;let ke=me;ml=((1f+lf)*ke);let cc=mj;mm=tan(cc);let ce=mk;let nb=me;let eb=mi;mn=((sin((ce*0.5f))*nb)*eb);let hk=me;let ch=mj;let ck=mj;mo=((hk*tan((ch*0.5f)))*cos(ck));let nc=mo;let ec=mm;mp=(nc*ec);let ed=ml;let cn=mn;let cp=mm;let cq=mo;mq=(((ed-cn)-((1f+cp)*cq))/3f);let hm=mq;mr=(2f*hm);let ei=mg;let nd=cs((ei*-0.25f));let ne=md;md=(nd*ne);let nf=md;md.x=-(abs(nf.x));let ng=md;let nh=me;ms=(ng+(vec2<f32>(0f,1.414213f)*nh));let hs=ms;let lm=ms;mt=atan2(hs.x,lm.y);let ep=mg;let ni=cs((ep*0.25f));let eq=md;md=(ni*eq);let er=ml;mu=vec2<f32>(-(er),0f);let hv=mu;let et=mr;mv=(hv+vec2<f32>(et,0f));let nj=mv;let eu=mq;mw=(nj+vec2<f32>(eu,0f));let nk=mw;let nl=mo;let hx=mp;mx=(nk+vec2<f32>(nl,-(hx)));let hy=md;let nm=ml;my=(hy+vec2(nm));let ey=my;if(ey.x<0f){{let hz=my;let fb=ml;return(hz.y-fb);}}else{let ia=mt;let nn=mk;if(abs(ia)<(nn*0.5f)){{let fc=ms;let no=me;return(length(fc)-no);}}}let fd=md;let ie=mu;let ig=mv;let np=mw;let nq=mx;let ih=lo(fd,ie,ig,np,nq);mz=ih;let nr=md;let fe=mu;let ns=mv;let ii=mw;let ff=mx;let nt=gj(nr,fe,ns,ii,ff);na=-(nt);let nu=mz;let ik=na;return(nu*ik);}fn nv(nw:vec2<f32>,nx:vec2<f32>,ny:f32,nz:f32)->f32{var oa:vec2<f32>;var ob:vec2<f32>;var oc:f32;var od:f32;var oe:f32;var og:f32;var oh:f32;var oi:f32;var oj:f32;var ok:vec2<f32>;oa=nw;ob=nx;oc=ny;od=nz;let cz=oc;if(cz<=0.000001f){{let av=oa;let bj=ob;let aw=am(av,bj);return aw;}}let hj=ob;let bk=ob;oe=min(hj.x,bk.y);let le=oc;let dx=od;og=(le*(1f+dx));let lf=og;let dy=oe;let dz=oc;oh=(max(0f,(lf-dy))/dz);let ce=od;let kf=oh;oi=max(0f,(ce-kf));let kg=oe;let eb=oc;oj=min(kg,eb);let hk=oi;if(hk<=0.000001f){{let ci=oa;let cj=ob;let kh=oj;let ck=ax(ci,cj,kh);return ck;}}let ki=oa;let cm=ob;ok=(abs(ki)-cm);let ol=ok;let om=oj;let ed=oi;let cn=lz(ol,om,ed);return cn;}fn on(oo:vec2<f32>,op:vec2<f32>,oq:vec4<f32>,or:vec4<f32>)->f32{var os:vec2<f32>;var ot:vec2<f32>;var ou:vec4<f32>;var ov:vec4<f32>;var ow:f32;var ox:vec2<f32>;os=oo;ot=op;ou=oq;ov=or;let cz=os;let da=ot;let bv=am(cz,da);ow=bv;let bj=ot;ox=(bj*2f);let bk=ow;let bl=os;let dx=ot;let ca=ox;let oy=ou;let lf=ov;let ke=nv(((bl*vec2<f32>(1f,1f))+dx),ca,oy.x,lf.x);ow=max(bk,ke);let dz=ow;let cc=os;let cg=ot;let kg=ox;let eb=ou;let oz=ov;let ch=nv(((cc*vec2<f32>(-1f,1f))+cg),kg,eb.y,oz.y);ow=max(dz,ch);let ci=ow;let cj=os;let ec=ot;let om=ox;let ed=ou;let ee=ov;let cp=nv(((cj*vec2<f32>(-1f,-1f))+ec),om,ed.z,ee.z);ow=max(ci,cp);let cq=ow;let ef=os;let hm=ot;let lh=ox;let ei=ou;let lj=ov;let nd=nv(((ef*vec2<f32>(1f,-1f))+hm),lh,ei.w,lj.w);ow=max(cq,nd);let lk=ow;return lk;}fn pa(pb:f32,pc:f32,pd:f32)->f32{var pe:f32;var pf:f32;var pg:f32;pe=pb;pf=pc;pg=pd;let le=pg;let by=pe;let ca=pf;let oy=pe;return clamp(((le-by)/max(0.00001f,(ca-oy))),0f,1f);}fn ph(pi:vec2<f32>)->vec2<f32>{var pj:vec2<f32>;var pk:vec2<f32>;var pl:vec2<f32>;pj=pi;let bk=p.nodeToTileSpace;let bl=pj;pk=(bk*vec3<f32>(bl.x,bl.y,1f)).xy;let oy=pk;let ke=p.tileExpansionScale;pl=(((oy-vec2(0.5f))*ke)+vec2(0.5f));let ce=pl;return ce;}fn pm(pn:vec2<f32>)->vec2<f32>{var po:vec2<f32>;var pp:vec2<f32>;po=pn;let bk=p.nodeToTileSpace;let bl=po;pp=(bk*vec3<f32>(bl.x,bl.y,1f)).xy;let oy=pp;return oy;}fn pq(pr:vec2<f32>)->vec4<f32>{var ps:vec2<f32>;var pt:vec2<f32>;ps=pr;let bk=ps;let bl=ph(bk);pt=bl;let bx=pt;let le=textureSample(texture0_,q,bx);return le;}fn pu(pv:vec2<f32>,pw:vec2<f32>,px:f32)->vec4<f32>{var py:vec2<f32>;var pz:vec2<f32>;var qa:f32;var qb:vec4<f32>=vec4<f32>(0f,0f,0f,0f);var qc:f32=0.14285715f;var qd:f32=0f;var qe:i32=0i;var qf:f32;var qg:f32;var qh:vec4<f32>;var qi:vec4<f32>;var qj:vec4<f32>;var qk:f32;py=pv;pz=pw;qa=px;loop{let cf=qe;if!((cf<o)){break;}{let oz=qe;let ch=qc;qf=((f32(oz)*ch)-0.5f);let ki=qf;qg=(1f-abs((ki*2f)));let om=py;let ed=qf;let co=qa;let hl=pz;let cr=pq((om+(((ed+0.5f)*co)*hl)));qh=cr;let ql=py;let qm=qf;let lg=qa;let eh=pz;let li=pq((ql+((qm*lg)*eh)));qi=li;let hn=py;let nd=qf;let ej=qa;let ek=pz;let ng=pq((hn+(((nd-0.5f)*ej)*ek)));qj=ng;let qn=qh;let nh=qi;let em=qj;qk=max(max(qn.w,nh.w),em.w);let qo=qb;let ht=qh;let ep=qi;let hu=qj;let eq=qk;let er=qg;qb=(qo+(vec4<f32>(ht.x,ep.y,hu.z,eq)*er));let qp=qd;let es=qg;qd=(qp+es);}continuing{let kg=qe;qe=(kg+1i);}}let et=qb;let qq=qd;return(et/vec4(qq));}fn qr(qs:vec2<f32>,qt:vec2<f32>)->f32{var qu:vec2<f32>;var qv:vec2<f32>;qu=qs;qv=qt;let bw=p.hasUniformCorners;if(bw==1i){{let by=qu;let dx=qv;let bz=p.cornerRadii;let oy=p.cornerSmoothings;let lf=nv(by,dx,bz.x,oy.x);return lf;}}else{{let dy=qu;let ke=qv;let cb=p.cornerRadii;let dz=p.cornerSmoothings;let cc=on(dy,ke,cb,dz);return cc;}}}fn qw(qx:vec2<f32>,qy:vec2<f32>,qz:vec4<f32>)->vec2<f32>{var rc:vec2<f32>;var rd:vec2<f32>;var re:vec4<f32>;var r:f32;var rf:vec2<f32>;var rh:bool;var ri:vec2<f32>;var rj:f32=0.1f;var rk:f32;var rl:f32;var rm:f32;rc=qx;rd=qy;re=qz;let le=p.hasUniformCorners;if(le==1i){{let bz=rd;let oy=rd;let dy=re;r=min(min(bz.x,oy.y),dy.x);let cc=rc;let ea=rd;let ce=r;rf=(abs(cc)-(ea-vec2(ce)));let kg=rf;let rn=rf;let ch=p.bevelSize;let ci=re;let kh=p.bevelSize;rh=(max(kg.x,rn.y)<=(-(ch)*step(ci.x,kh)));let nc=rh;if nc{{return vec2<f32>(0f,0f);}}let ed=rf;let cn=rf;let co=rf;ri=(ed+vec2(max(-(min(cn.x,co.y)),0f)));let lg=ri;let hm=u(lg);let eh=rc;return(hm*sign(eh));}}else{{let hn=rc;let nd=rd;let ne=re;let lk=bm(hn,nd,ne);rk=lk;let nf=rc;let ek=rj;let hq=rd;let qn=re;let hr=bm((nf+vec2<f32>(ek,0f)),hq,qn);rl=hr;let ll=rc;let em=rj;let lm=rd;let qo=re;let ht=bm((ll+vec2<f32>(0f,em)),lm,qo);rm=ht;let ep=rl;let ro=rm;let ni=rk;let er=rj;return((vec2<f32>(ep,ro)-vec2(ni))/vec2(er));}}}fn rp(rq:vec2<f32>,rs:vec2<f32>,refractionDistance:f32)->vec2<f32>{var rt:vec2<f32>;var ru:vec2<f32>;var rv:f32;var rw:vec2<f32>;var rx:vec2<f32>;rt=rq;ru=rs;rv=refractionDistance;let le=rt;let by=ru;let dx=p.cornerRadii;let bz=rv;let ry=qw(le,by,max(dx,vec4(bz)));rw=ry;let dy=rt;let ke=u(dy);rx=ke;let dz=rw;let cc=rx;let cd=p.splay;return mix(dz,cc,vec2(cd));}fn rz(){var sa:vec2<f32>;var sb:vec2<f32>;var sc:vec2<f32>;var sd:vec2<f32>;var se:vec2<f32>;var sf:f32;var sg:f32;var sh:f32;var si:f32;var sj:f32;var sk:f32;var sl:f32;var sm:vec2<f32>;var sn:vec2<f32>;var so:vec2<f32>;var sp:vec4<f32>=vec4(0f);var sq:f32;var sr:f32;var ss:f32;var st:f32;var su:vec2<f32>;var sv:vec2<f32>;var sw:f32;var sx:f32;var sy:f32;var sz:vec2<f32>;var ta:f32;let hj=p.tileToNodeSpace;let al=t;sa=(hj*vec3<f32>(al.x,al.y,1f)).xy;let bz=p.nodeSpaceCenterPoint;sb=(bz*2f);let lf=sb;sc=(lf*0.5f);let dz=p.nodeSpaceCenterPoint;sd=dz;let cd=sa;let ea=p.nodeSpaceCenterPoint;se=(cd-ea);let cf=se;let cg=sc;let nb=qr(cf,cg);sf=nb;let eb=p.refractionDistance;let oz=p.bevelSize;let ch=p.bevelSize;let ci=sf;let cj=pa((-(eb)-oz),-(ch),ci);sg=cj;let ck=sg;let cl=p.refractionDistance;sh=(pow(ck,l)*cl);let ol=p.refractionDistance;si=(0.999f*ol);let cn=sh;let ee=p.refractionIntensity;let cp=si;let cq=si;sj=clamp((cn*ee),-(cp),cq);let eg=p.refractionIntensity;let qm=si;sk=((eg*k)*qm);let eh=p.bevelSize;let lj=p.bevelSize;let lk=sf;let ej=pa((-(eh)-0.0001f),(-(lj)*0.3f),lk);sl=ej;let ek=se;let ho=sc;let hp=p.bevelSize;let ng=p.refractionDistance;let qn=rp(ek,ho,max(hp,ng));sm=qn;let nh=sm;let el=sj;let em=sk;let hs=sl;sn=(-(nh)*mix(el,em,hs));let ht=sa;so=ht;let ni=so;let eq=sn;so=(ni+eq);let er=p.chromaticAberration;if(er<0.001f){{let qp=so;let es=pq(qp);sp=es;}}else{{let hv=so;let et=sn;let qq=p.chromaticAberration;let tb=pu(hv,et,qq);sp=tb;}}let hw=p.lightIntensity;sq=hw;let nj=p.bevelSize;sr=(nj*0.5f);let ev=p.bevelSize;let hx=p.bevelSize;let ex=sf;ss=smoothstep((-(ev)-0.001f),(-(hx)*m),ex);let nm=p.lightAngle;let tc=p.frameRotation;st=((nm-tc)+h);let ez=se;let fa=sc;let td=p.cornerRadii;let hz=qw(ez,fa,td);su=hz;let fb=st;let ia=st;sv=vec2<f32>(cos(fb),sin(ia));let te=sp;let fc=sp;let tf=su;let fd=sv;let nq=ss;let tg=sq;let ns=(fc.xyz+vec3(((smoothstep(i,1f,dot(tf,-(fd)))*nq)*tg)));sp.x=ns.x;sp.y=ns.y;sp.z=ns.z;let ik=sp;let fg=sp;let fj=su;let il=sv;let th=ss;let fk=sq;let ti=(fg.xyz+vec3((((smoothstep(i,1f,dot(fj,il))*th)*fk)*j)));sp.x=ti.x;sp.y=ti.y;sp.z=ti.z;let fr=p.refractionDistance;sw=fr;let tj=sw;let tk=p.bevelSize;let tl=sf;let fv=pa(-(tj),(-(tk)+0.0001f),tl);sx=pow(fv,2f);let tm=sm;let fx=sv;sy=dot(tm,fx);let tn=sp;let to=sp;let fz=sy;let tp=sx;let iu=sq;let gd=(to.xyz+vec3((((fz*tp)*n)*iu)));sp.x=gd.x;sp.y=gd.y;sp.z=gd.z;let gh=p.directComposite;if(gh==1i){{let tq=sp;let iw=p.directCompositeBackgroundColor;let tr=sp;sp=(tq+(iw*(1f-tr.w)));let ts=p.textureMaskDirectComposite;if(ts==1i){{let ja=t;let tt=p.maskTextureSize;let tu=p.maskTextureSize;sz=((floor((ja*tt))+vec2(0.5f))/vec2(tu));let jd=sz;let tv=textureSample(texture1_,s,jd);ta=tv.w;let tw=ta;if(tw==0f){{discard;}}}}else{let tx=sf;if(tx>0f){{discard;}}}}}let ty=sp;fig_FragColor=ty;return;}@fragment fn main(@location(0)tz:vec2<f32>)->c{t=tz;rz();let ea=fig_FragColor;return c(ea);}"
 },
 "maskBackgroundBlurTile": {
  "vertex": "struct UniformBlock{quad:vec4<f32>,}struct c{@location(0)d:vec2<f32>,@builtin(position)e:vec4<f32>,}@group(0)@binding(0)var<uniform>f:UniformBlock;var<private>h:vec2<f32>;var<private>d:vec2<f32>;var<private>e:vec4<f32>;fn i(){let j=f.quad;let k=f.quad;let l=h;d=mix(j.xy,k.zw,l);let m=d;let n=((m*2f)-vec2(1f));e=vec4<f32>(n.x,n.y,0f,1f);let o=e;e.y=(o.y*-1f);return;}@vertex fn main(@location(0)p:vec2<f32>)->c{h=p;i();let q=d;let m=e;return c(q,m);}",
  "fragment": "struct UniformBlock{quad:vec4<f32>,}struct c{@location(0)fig_FragColor:vec4<f32>,}@group(0)@binding(0)var<uniform>d:UniformBlock;@group(1)@binding(0)var texture0_:texture_2d<f32>;@group(1)@binding(1)var e:sampler;@group(1)@binding(2)var texture1_:texture_2d<f32>;@group(1)@binding(3)var f:sampler;var<private>h:vec2<f32>;var<private>fig_FragColor:vec4<f32>;fn i(){let j=h;let k=textureSample(texture1_,f,j);if(k.w==0f){{discard;}}let l=h;let m=textureSample(texture0_,e,l);fig_FragColor=m;return;}@fragment fn main(@location(0)n:vec2<f32>)->c{h=n;i();let o=fig_FragColor;return c(o);}"
 },
 "maskInnerShadowTile": {
  "vertex": "struct UniformBlock{quad:vec4<f32>,color:vec4<f32>,}struct c{@location(0)d:vec2<f32>,@builtin(position)e:vec4<f32>,}@group(0)@binding(0)var<uniform>f:UniformBlock;var<private>h:vec2<f32>;var<private>d:vec2<f32>;var<private>e:vec4<f32>;fn i(){let j=f.quad;let k=f.quad;let l=h;d=mix(j.xy,k.zw,l);let m=d;let n=((m*2f)-vec2(1f));e=vec4<f32>(n.x,n.y,0f,1f);let o=e;e.y=(o.y*-1f);return;}@vertex fn main(@location(0)p:vec2<f32>)->c{h=p;i();let q=d;let m=e;return c(q,m);}",
  "fragment": "struct UniformBlock{quad:vec4<f32>,color:vec4<f32>,}struct c{@location(0)fig_FragColor:vec4<f32>,}@group(0)@binding(0)var<uniform>d:UniformBlock;@group(1)@binding(0)var texture0_:texture_2d<f32>;@group(1)@binding(1)var e:sampler;@group(1)@binding(2)var texture1_:texture_2d<f32>;@group(1)@binding(3)var f:sampler;var<private>h:vec2<f32>;var<private>fig_FragColor:vec4<f32>;fn i(){let j=h;let k=textureSample(texture0_,e,j);let l=h;let m=textureSample(texture1_,f,l);let n=d.color;fig_FragColor=(((1f-k.w)*m.w)*n);return;}@fragment fn main(@location(0)o:vec2<f32>)->c{h=o;i();let n=fig_FragColor;return c(n);}"
 }
};

export const FIGMA_PIPELINES = {
 "loopBlinnSolidPaint/KEEP": {
  "shader": "loopBlinnSolidPaint",
  "blend": "KEEP",
  "colorBlend": {
   "alpha": {
    "srcFactor": "zero",
    "dstFactor": "one"
   },
   "color": {
    "srcFactor": "zero",
    "dstFactor": "one"
   }
  },
  "writeMask": 0,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-list",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "increment-wrap"
   },
   "stencilBack": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "decrement-wrap"
   },
   "stencilReadMask": 63,
   "stencilWriteMask": 63,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "solidColorPaintLoopBlinn/PREMULTIPLIED": {
  "shader": "solidColorPaintLoopBlinn",
  "blend": "PREMULTIPLIED",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "one-minus-src-alpha"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "one-minus-src-alpha"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "not-equal",
    "failOp": "zero",
    "passOp": "zero"
   },
   "stencilBack": {
    "compare": "not-equal",
    "failOp": "zero",
    "passOp": "zero"
   },
   "stencilReadMask": 63,
   "stencilWriteMask": 63,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "downscaleTile/COPY": {
  "shader": "downscaleTile",
  "blend": "COPY",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "zero"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "zero"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilBack": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilReadMask": 0,
   "stencilWriteMask": 255,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "unclampedBlurTile/COPY": {
  "shader": "unclampedBlurTile",
  "blend": "COPY",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "zero"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "zero"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilBack": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilReadMask": 0,
   "stencilWriteMask": 255,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "upscaleTile/PREMULTIPLIED": {
  "shader": "upscaleTile",
  "blend": "PREMULTIPLIED",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "one-minus-src-alpha"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "one-minus-src-alpha"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilBack": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilReadMask": 0,
   "stencilWriteMask": 255,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "maskKnockoutShadowTile/PREMULTIPLIED": {
  "shader": "maskKnockoutShadowTile",
  "blend": "PREMULTIPLIED",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "one-minus-src-alpha"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "one-minus-src-alpha"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilBack": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilReadMask": 0,
   "stencilWriteMask": 255,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "copyTile/COPY": {
  "shader": "copyTile",
  "blend": "COPY",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "zero"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "zero"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": null,
  "buffers": [
   {
    "arrayStride": 8,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     }
    ]
   }
  ]
 },
 "blendTileSimple/COPY": {
  "shader": "blendTileSimple",
  "blend": "COPY",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "zero"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "zero"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilBack": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilReadMask": 0,
   "stencilWriteMask": 255,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "blendTileCustom/COPY": {
  "shader": "blendTileCustom",
  "blend": "COPY",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "zero"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "zero"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilBack": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilReadMask": 0,
   "stencilWriteMask": 255,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "maskKnockoutShadowTilePassThrough/COPY": {
  "shader": "maskKnockoutShadowTilePassThrough",
  "blend": "COPY",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "zero"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "zero"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilBack": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilReadMask": 0,
   "stencilWriteMask": 255,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "blendTileSimple/LINEAR_DODGE": {
  "shader": "blendTileSimple",
  "blend": "LINEAR_DODGE",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "one-minus-src-alpha"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "one"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilBack": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilReadMask": 0,
   "stencilWriteMask": 255,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "glass/PREMULTIPLIED": {
  "shader": "glass",
  "blend": "PREMULTIPLIED",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "one-minus-src-alpha"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "one-minus-src-alpha"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilBack": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilReadMask": 0,
   "stencilWriteMask": 255,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "maskBackgroundBlurTile/COPY": {
  "shader": "maskBackgroundBlurTile",
  "blend": "COPY",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "zero"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "zero"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilBack": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilReadMask": 0,
   "stencilWriteMask": 255,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "maskInnerShadowTile/PREMULTIPLIED": {
  "shader": "maskInnerShadowTile",
  "blend": "PREMULTIPLIED",
  "colorBlend": {
   "alpha": {
    "srcFactor": "one",
    "dstFactor": "one-minus-src-alpha"
   },
   "color": {
    "srcFactor": "one",
    "dstFactor": "one-minus-src-alpha"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": {
   "format": "stencil8",
   "depthWriteEnabled": false,
   "depthCompare": "always",
   "stencilFront": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilBack": {
    "compare": "always",
    "failOp": "keep",
    "passOp": "keep"
   },
   "stencilReadMask": 0,
   "stencilWriteMask": 255,
   "depthBias": 0,
   "depthBiasSlopeScale": 0,
   "depthBiasClamp": 0
  },
  "buffers": [
   {
    "arrayStride": 20,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     },
     {
      "format": "float32x3",
      "offset": 8,
      "shaderLocation": 1
     }
    ]
   }
  ]
 },
 "copyTile/INTERPOLATE": {
  "shader": "copyTile",
  "blend": "INTERPOLATE",
  "colorBlend": {
   "alpha": {
    "srcFactor": "constant",
    "dstFactor": "one-minus-constant"
   },
   "color": {
    "srcFactor": "constant",
    "dstFactor": "one-minus-constant"
   }
  },
  "writeMask": 15,
  "format": "rgba8unorm",
  "primitive": {
   "topology": "triangle-strip",
   "unclippedDepth": false
  },
  "depthStencil": null,
  "buffers": [
   {
    "arrayStride": 8,
    "stepMode": "vertex",
    "attributes": [
     {
      "format": "float32x2",
      "offset": 0,
      "shaderLocation": 0
     }
    ]
   }
  ]
 }
};
