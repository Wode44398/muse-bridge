// 参数的「翻译层」（render.js 是纯函数、单测在 node 里跑，界面词放这边）：
//   valueWords  常见枚举值 → 界面词（humanValue 用）。自动识别出来的参数，接口原值常是 high / auto / transparent 这类英文小写词
//   paramLabel  参数名：目录写好的中文名照翻；上游给的是英文名（schema 的 title）或干脆没名字的，先按键名查常见参数表，查不到再整理键名
//   optText     选项文字：有 label 用 label（动态的「N 秒」统一成一种写法），没有就把原值整理成人话
// 原样上屏像接口文档（复核 11-06 两轮：Prompt upsampling / Safety tolerance、mp3_44100_128）。
import { t, tc, tr } from '../../lib/i18n.js';
import { cleanLabel, humanValue } from './render.js';

let cache = null;
export function valueWords() {
  if (cache) return cache;
  cache = {
    '': t('默认'), default: t('默认'), auto: t('自动'), none: t('无'), off: t('关'), on: t('开'), true: t('开'), false: t('关'),
    low: t('低'), medium: t('中'), mid: t('中'), high: t('高'), ultra: t('超高'), max: t('最高'), min: t('最低'),
    standard: t('标准'), hd: t('高清'), fast: t('快速'), balanced: t('均衡'), quality: t('质量优先'), speed: t('速度优先'),
    transparent: t('透明'), opaque: t('不透明'), portrait: t('竖屏'), landscape: t('横屏'), square: t('方形'), natural: t('自然'), vivid: t('鲜艳'),
  };
  return cache;
}

// 常见参数键（去掉 _ - 空格、小写）→ 界面名。只收各家接口里反复出现、意思不含糊的那些
let keys = null;
function keyWords() {
  if (keys) return keys;
  const w = (zh, ...ks) => ks.forEach((k) => (keys[k] = zh));
  keys = {};
  w(t('比例'), 'aspectratio', 'ratio');
  w(t('分辨率'), 'resolution');
  w(t('尺寸'), 'size', 'imagesize');
  w(t('画质'), 'quality');
  w(t('张数'), 'n', 'numimages', 'numoutputs', 'numberofimages', 'samplecount', 'batchsize', 'count');
  w(t('时长'), 'duration', 'durationseconds');
  w(t('帧率'), 'fps', 'framerate');
  w(t('格式'), 'outputformat', 'format');
  w(t('压缩率'), 'outputcompression', 'compression');
  w(t('背景'), 'background');
  w(t('风格'), 'style', 'stylepreset');
  w(t('种子'), 'seed');
  w(t('负面提示词'), 'negativeprompt');
  w(t('提示词增强'), 'promptupsampling', 'enhanceprompt', 'promptenhancement', 'promptoptimizer', 'promptextend', 'expandprompt');
  w(t('原始模式'), 'raw', 'rawmode');
  w(t('安全宽松度'), 'safetytolerance');
  w(t('安全检查'), 'enablesafetychecker', 'safetychecker');
  w(t('参考图强度'), 'imagepromptstrength');
  w(t('采样步数'), 'numinferencesteps', 'inferencesteps', 'steps');
  w(t('引导强度'), 'guidancescale', 'guidance', 'cfgscale', 'cfg');
  w(t('人物生成'), 'persongeneration');
  w(t('生成音频'), 'generateaudio');
  w(t('固定镜头'), 'camerafixed');
  w(t('水印'), 'watermark', 'addwatermark');
  w(t('音色'), 'voice', 'voiceid');
  w(t('语速'), 'speed');
  w(t('语言'), 'language', 'languagecode');
  w(t('歌词'), 'lyrics');
  w(t('纯音乐'), 'instrumental');
  w(t('温度'), 'temperature');
  return keys;
}
const CJK = /[㐀-鿿]/;
const norm = (k) => String(k || '').replace(/[\s_-]+/g, '').toLowerCase();

export function paramLabel(spec) {
  if (spec?.label && CJK.test(spec.label)) return cleanLabel(tr(spec.label));
  const known = keyWords()[norm(spec?.key)];
  if (known) return known;
  if (spec?.label) return cleanLabel(spec.label);
  const k = String(spec?.key || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return k ? k[0].toUpperCase() + k.slice(1) : '';
}

export function optText(o) {
  if (o.label != null && o.label !== '' && String(o.label) !== String(o.value)) {
    const s = String(o.label).trim();
    const m = /^(\d+(?:\.\d+)?) 秒$/.exec(s);
    return m ? tc('时长', '{n} 秒', { n: m[1] }) : tr(s);
  }
  return humanValue(o, valueWords());
}

// 参数从哪来（picker.js 的 paramSource）：参数头 / 浮层副标题和模型选择器的行下小字同一种写法（不带「参数：」）；
// head = false（选择器）时「接口自报」不写——它是自动识别模型的常态，只写值得一提的「沿用 X」「通用参数」
export function sourceText(src, labelFor = (id) => id, head = false) {
  if (!src) return '';
  if (src.kind === 'schema') return head ? t('接口自报') : '';
  if (src.kind === 'family') return t('沿用 {model}', { model: labelFor(src.from) });
  return t('通用参数');
}
