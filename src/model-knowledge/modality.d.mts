// modality.mjs 的类型声明（modality.test.mjs 核对这里声明的导出名与运行时一致）。

/** 模型中心一侧的种类；Studio 内部把配音叫 speech，只在桥接处互转。 */
export type Modality = "text" | "image" | "video" | "voice" | "music";
/** 目录里另有 other：向量 / 重排 / 语音识别 / 审核 / OCR / 实时语音等，看得见但不能添加。 */
export type ModalityOrOther = Modality | "other";

export interface ClassifyMeta {
  /** 上游这条型号的原始条目（OpenRouter / fal / Together / 硅基流动 / Gemini / Mistral / ElevenLabs …） */
  raw?: unknown;
  /**
   * 目录出处，最高优先。另收 "speech"（= voice）、"audio"（只知道出音频：配音 / 音乐 / 其他按名字与元数据分）、"other"。
   * voice / music / audio 时名字能明确认出配音 / 音乐 / 其他的，以名字为准（音频目录常混着语音识别与音频对话）。
   */
  hint?: Modality | "other" | "speech" | "audio" | string;
  /** 纯媒体服务（fal、Replicate…）：名字认不出就算 other，而不是 text */
  mediaOnly?: boolean;
}

export const MODALITIES: readonly Modality[];
export function classifyModality(id: unknown, meta?: ClassifyMeta | null): ModalityOrOther;
