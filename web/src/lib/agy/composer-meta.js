// 输入框底栏芯片用的展示元数据：模型系列的品牌标、运行模式的展示名。

import { modeMetaOf } from './catalog.js';

export function brandLogoOfSeries(series = '') {
  const s = String(series).toLowerCase();
  if (s.startsWith('gemini')) return 'gemini-color';
  if (s.includes('claude')) return 'claude-color';
  if (s.includes('gpt') || s.includes('openai')) return 'openai';
  return '';
}

export function brandLogoOfModel(id = '') {
  const s = String(id).toLowerCase();
  if (s.startsWith('gemini') || s.includes('orchestrator')) return 'gemini-color';
  if (s.includes('claude')) return 'claude-color';
  if (s.includes('gpt')) return 'openai';
  return '';
}

export function modeShortOf(id = '') {
  const v = String(id || 'default');
  return { mode: v, label: modeMetaOf(v).label };
}

