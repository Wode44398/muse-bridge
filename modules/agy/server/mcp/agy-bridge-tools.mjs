// Antigravity 的 Bridge 工具（子进程本地实现的那部分）：媒体生成、界面协同、手机授权文件。
// 不暴露工作区文件读写或任意命令执行（agy 自带）；浏览器、共享终端、工作区协同、bridge 操作、设备、图表
// 由服务端工具中枢（hub.mjs）提供，按归属轮实例化 Claude 同款工具。

import { z } from 'zod';

const txt = (text) => ({ content: [{ type: 'text', text: String(text) }] });
const fail = (prefix, err) => ({
  content: [{ type: 'text', text: `${prefix}：${String(err?.message ?? err).slice(0, 600)}` }],
  isError: true,
});

function cleanArgs(obj = {}) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')
  );
}

function formatScanResult(result) {
  const files = Array.isArray(result?.files) ? result.files : [];
  if (!files.length) return txt('扫描完成：在可访问范围内没有匹配的文件。');
  const totalMB = (files.reduce((sum, f) => sum + (f.size || 0), 0) / 1048576).toFixed(1);
  const lines = files.map((f) => {
    const mb = ((f.size || 0) / 1048576).toFixed(1);
    const when = f.mtime ? new Date(f.mtime).toISOString().slice(0, 10) : '?';
    return `${mb} MB  ${when}  ${f.path}`;
  });
  return txt(
    `扫描到 ${files.length} 个文件，合计约 ${totalMB} MB（按大小降序）：\n`
    + lines.join('\n')
    + (result.truncated ? '\n…（清单被截断，可缩小目录或提高 minSizeMB 再扫）' : '')
    + '\n\n删除任何手机文件前必须先向用户列出路径与体积并征得确认；本工具仅限系统选择器已授权目录，无法访问 Android/data 等私有缓存。'
  );
}

export function parseEnabledCategories(rawCategories = '', { phonePluginOn = true } = {}) {
  const set = new Set(
    (Array.isArray(rawCategories) ? rawCategories : String(rawCategories || '').split(','))
      .map((s) => String(s || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (!phonePluginOn) set.delete('phone');
  return set;
}

export function buildAgyBridgeToolDefs({
  categories = ['media', 'ui'],
  phonePluginOn = true,
  callAgentOp,
  callInternal,
  waitBudgetMs = 150_000,   // 单次调用里最多等任务多久（agy 的工具调用 3 分钟硬上限，留余量）
  pollMs = 2_500,
} = {}) {
  const active = parseEnabledCategories(categories, { phonePluginOn });
  const tools = [];

  // Antigravity 对每次 MCP 工具调用有 3 分钟硬上限（11-19 探针实测：180 秒整报 context deadline exceeded，
  // 进度通知也不续期）。超时后生成其实还在服务端跑，模型看到的却是失败，重试一次就重复计费。
  // 所以慢的生成（视频 / 音乐，以及走 Studio 任务的进阶调用）不在一次调用里死等：发起任务后最多等 WAIT_BUDGET_MS，
  // 没好就把任务 id 交回去，模型过一会儿用 media_result 取结果。
  const WAIT_BUDGET_MS = waitBudgetMs;
  const POLL_MS = pollMs;
  const FINAL_STATES = new Set(['done', 'error', 'canceled']);
  const KIND_LABEL = { image: '图片', video: '视频', speech: '语音', music: '音乐' };
  const sleep = (ms, signal) => new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve(); }
    signal?.addEventListener?.('abort', done, { once: true });
  });
  const linkOf = (saved) => saved.markdownLink || `[${saved.fileName}](${saved.savedPath})`;
  const idNote = (kind, id) => (kind === 'image' && id ? `作品 id：${id}（接着改这张图：下次调用 continueFrom 传这个 id）` : '');
  const saveOne = (id, mediaKind, saveTo, toolName) => callInternal('/api/agy/internal/save-media', {
    mediaId: id,
    kind: mediaKind,
    saveTo: saveTo || '',
    toolName,
  });

  // 等任务跑完（最多 budgetMs）。这一轮被停止 = signal 中断：把任务也取消掉，别让它白跑白计费。
  async function waitJob(job, signal, budgetMs = WAIT_BUDGET_MS) {
    const t0 = Date.now();
    let cur = job;
    while (cur && !FINAL_STATES.has(cur.state) && Date.now() - t0 < budgetMs) {
      await sleep(POLL_MS, signal);
      if (signal?.aborted) {
        try { await callAgentOp('studio.job_cancel', { id: cur.id }, { timeoutMs: 10_000 }); } catch {}
        throw new Error('已取消');
      }
      try { cur = (await callAgentOp('studio.job', { id: cur.id }, { timeoutMs: 20_000 })).job || cur; } catch (err) {
        if (/不见了|not.?found|404/i.test(String(err?.message || ''))) throw err;
      }
    }
    return cur;
  }

  // 任务的结局 → 给模型的话：跑完就把作品存进会话工作目录；失败照实报；还没完就交出任务 id。
  async function settleJob(job, { toolName, saveTo }) {
    const kindLabel = KIND_LABEL[job?.kind] || '媒体';
    if (!job || !job.id) throw new Error('任务没有建成');
    if (job.state === 'error' || job.state === 'canceled') {
      throw new Error(job.state === 'canceled' ? '任务已取消' + (job.note ? `（${job.note}）` : '') : (job.error || job.note || '生成失败'));
    }
    if (job.state !== 'done') {
      const pct = Number.isFinite(job.progress) && job.progress > 0 ? `，进度约 ${Math.round(job.progress * 100)}%` : '';
      return txt(
        `${kindLabel}还在生成（已 ${Math.round(Number(job.elapsed) || 0)} 秒${pct}）。任务 id：${job.id}\n`
        + `过一会儿调用 media_result（job 填这个 id${saveTo ? `，saveTo 填 ${saveTo}` : ''}）取结果。`
        + '不要重新发起生成：任务仍在服务端跑，重发会重复计费。'
      );
    }
    const results = Array.isArray(job.result) ? job.result : [];
    if (!results.length) throw new Error('任务完成了但没有产出');
    const lines = [];
    for (const r of results) {
      const saved = await saveOne(r.id, r.kind, saveTo, toolName);
      const note = idNote(r.kind, r.id);
      lines.push(`${saved.savedPath}\n  Markdown 链接：${linkOf(saved)}${note ? '\n  ' + note : ''}`);
    }
    return txt(
      `${kindLabel}已生成${results.length > 1 ? ` ${results.length} 件` : ''}并保存到当前会话工作目录`
      + (job.model ? `（${job.model}）` : '') + '：\n' + lines.join('\n')
      + '\n请在回复正文中原样附上上面的 Markdown 链接交付给用户。'
    );
  }

  // 生成并存进当前会话工作目录。两条路：
  //   · 图片 / 语音且只用了常用参数 → 走 media.<种类>（和以前一样，几秒到几十秒）。
  //   · 视频 / 音乐，或给了 params（模型卡上的任意参数）/ inputs（素材）/ continueFrom（接着改）/ negative →
  //     走 Media Studio 的任务（studio.generate，与 Claude 的媒体工具同一个执行器）：常用参数并进 params、
  //     素材先交服务端换成 Studio 认的写法；任务发起后分段等（见上）。
  const deliverMedia = async (toolName, opName, kindLabel, args = {}, timeoutMs = 300_000, extra = null) => {
    await callInternal('/api/agy/internal/gate', { category: 'media' });
    const kind = toolName.replace(/^media_/, '');
    const { saveTo, params, inputs, continueFrom, negative, ...opArgs } = args;
    const extraParams = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    const extraInputs = Array.isArray(inputs) ? inputs.filter((x) => x && typeof x === 'object') : [];
    // 给了 image（要改的图 / 参考图）也算进阶：快通道那条老接口只认 uploads 目录里的素材，别处的图会被悄悄丢掉、
    // 照样按文生图出一张不相干的并计费；任务通道经 media-inputs 认会话工作目录、附加目录、上传目录与媒体库。
    const advanced = Object.keys(extraParams).length > 0 || extraInputs.length > 0 || !!continueFrom
      || (typeof negative === 'string' && negative.trim() !== '') || !!opArgs.image;

    if (!advanced && (kind === 'image' || kind === 'speech')) {
      const generated = await callAgentOp(opName, cleanArgs(opArgs), { timeoutMs: Math.min(timeoutMs, 170_000) });
      const saved = await saveOne(generated.id, generated.kind, saveTo, toolName);
      const note = idNote(kind, generated.id);
      return txt(
        `${kindLabel}已生成并保存到当前会话工作目录：${saved.savedPath}\n`
        + `请在回复正文中原样附上此 Markdown 链接交付给用户：${linkOf(saved)}`
        + (note ? '\n' + note : '')
      );
    }

    const { prompt, text, model, image, negativePrompt, ...common } = opArgs;
    const rawInputs = [
      ...(image ? [{ role: kind === 'video' ? 'first' : 'edit', path: image }] : []),
      ...extraInputs,
    ];
    const studioInputs = rawInputs.length
      ? (await callInternal('/api/agy/internal/media-inputs', { inputs: rawInputs, toolName })).inputs
      : [];
    let thread;
    let parent;
    if (continueFrom) {
      // 接回那张图的续改链：链 id = 它的 thread（第一张自成一条 = 它自己的 id），parent 记血缘
      const { asset } = await callAgentOp('studio.asset', { id: String(continueFrom).trim() });
      parent = asset.id;
      thread = asset.thread || asset.id;
    }
    const started = await callAgentOp('studio.generate', cleanArgs({
      kind,
      model,
      prompt: prompt ?? text,
      negative: (typeof negative === 'string' && negative.trim()) || negativePrompt,
      params: { ...cleanArgs(common), ...extraParams },
      inputs: studioInputs,
      thread,
      parent,
      wait: false,
    }), { timeoutMs: 60_000 });
    const job = await waitJob(started.job, extra?.signal);
    return settleJob(job, { toolName, saveTo });
  };

  // 进阶参数（与 Claude 的媒体工具同一套）：键名、取值、能收什么素材先用 media_models 查
  const PARAMS_FIELD = z.record(z.string(), z.any()).optional().describe('模型卡上的其它参数，键名照 media_models 查到的写（如 { "count": 2, "seed": 7, "quality": "high" }）；按卡规范化（越界的夹紧、不认识的丢掉），和上面同名的字段同时给时以这里为准');
  const NEGATIVE_FIELD = z.string().max(2000).optional().describe('负面提示词（不要出现什么），只在模型卡收 negative 时生效');
  const INPUTS_FIELD = z.array(z.object({
    role: z.enum(['edit', 'ref', 'first', 'last', 'audio', 'video']).describe('edit = 改这张图；ref = 参考图（主体 / 风格）；first / last = 视频首帧 / 尾帧；audio / video = 参考音频 / 视频'),
    path: z.string().optional().describe('文件路径：绝对路径，或相对当前会话工作目录（须在会话工作目录、已授权附加目录、上传目录或媒体库里）'),
    asset: z.string().optional().describe('媒体库里的作品 id（生成回执里有）'),
  })).max(12).optional().describe('素材；模型收哪些角色、几张，先用 media_models 查');
  const CONTINUE_FIELD = z.string().max(80).optional().describe('接着改哪张图：作品 id（生图回执里有）。会带上这条续改链的上下文；不支持多轮的模型拿上一张当参考图');

  if (active.has('media')) {
    tools.push(
      {
        name: 'media_image',
        description: '使用 Bridge Media Studio 生成图片并保存到当前会话工作目录。改图 / 给参考图用 inputs（role edit = 改这张，ref = 参考主体或风格），接着改上一张用 continueFrom，模型卡上的其它参数放 params、负面词放 negative——键名与取值先用 media_models 查。生成后请把返回的 Markdown 文件链接 [文件名](绝对路径) 写进回复正文，以便界面展示可预览的图片附件卡。',
        schema: {
          prompt: z.string().min(1).max(8000).describe('画面描述：主体、场景、风格、光线、构图'),
          model: z.string().optional().describe('可选模型 id 或 <服务>/<模型>；留空使用 Media Studio 默认图像模型'),
          aspectRatio: z.string().optional().describe('画面比例，如 1:1、16:9、9:16、4:3'),
          imageSize: z.string().optional().describe('分辨率档位：1K / 2K / 4K'),
          thinkingLevel: z.string().optional().describe('思考档位（仅支持该参数的模型生效）'),
          useSearch: z.boolean().optional().describe('联网搜索增强'),
          useImageSearch: z.boolean().optional().describe('图片搜索增强'),
          image: z.string().optional().describe('参考图的本地绝对路径（须在工作目录或上传目录内）'),
          saveTo: z.string().optional().describe('相对当前会话工作目录的保存路径或子目录（以 / 结尾表示目录）'),
          params: PARAMS_FIELD,
          negative: NEGATIVE_FIELD,
          inputs: INPUTS_FIELD,
          continueFrom: CONTINUE_FIELD,
        },
        handler: async (args, extra) => {
          try { return await deliverMedia('media_image', 'media.image', '图片', args, 300_000, extra); }
          catch (err) { return fail('生成图片失败', err); }
        },
      },
      {
        name: 'media_video',
        description: '使用 Bridge Media Studio 生成视频并保存到当前会话工作目录（耗时约 1–3 分钟且按秒计费，用户未明确要求视频时请先确认）。两分半内没生成完会先返回任务 id，过一会儿用 media_result 取结果，别重新发起。首帧 / 尾帧 / 参考图用 inputs（role first / last / ref），卡上的其它参数（种子、条数、提示词增强等）放 params，先用 media_models 查。回复中附上返回的 Markdown 文件链接即可渲染视频卡片。',
        schema: {
          prompt: z.string().min(1).max(8000).describe('画面、主体运动与镜头调度描述'),
          model: z.string().optional().describe('可选视频模型 id 或 <服务>/<模型>'),
          aspectRatio: z.string().optional().describe('比例：16:9 或 9:16'),
          resolution: z.string().optional().describe('720p / 1080p / 4k（受管理员分辨率上限约束）'),
          durationSeconds: z.number().int().min(1).max(10).optional().describe('时长（秒）'),
          generateAudio: z.boolean().optional().describe('是否生成伴音'),
          negativePrompt: z.string().max(500).optional().describe('反向提示词'),
          image: z.string().optional().describe('首帧参考图绝对路径'),
          saveTo: z.string().optional().describe('相对当前会话工作目录的保存路径或子目录'),
          params: PARAMS_FIELD,
          inputs: INPUTS_FIELD,
        },
        handler: async (args, extra) => {
          try { return await deliverMedia('media_video', 'media.video', '视频', args, 15 * 60_000, extra); }
          catch (err) { return fail('生成视频失败', err); }
        },
      },
      {
        name: 'media_speech',
        description: '使用 Bridge Media Studio 将文字合成为语音音频并保存到当前会话工作目录。换配音模型传 model（media_models 查可用的模型与音色），双人对白、语气等卡上的其它参数放 params。回复中附上返回的 Markdown 链接即可渲染音频播放卡。',
        schema: {
          text: z.string().min(1).max(8000).describe('要朗读的文本内容'),
          voice: z.string().optional().describe('可选音色名'),
          style: z.string().max(120).optional().describe('可选语气或播报风格提示'),
          model: z.string().optional().describe('可选语音模型 id 或 <服务>/<模型>'),
          saveTo: z.string().optional().describe('相对当前会话工作目录的保存路径或子目录'),
          params: PARAMS_FIELD,
        },
        handler: async (args, extra) => {
          try { return await deliverMedia('media_speech', 'media.speech', '语音', args, 180_000, extra); }
          catch (err) { return fail('生成语音失败', err); }
        },
      },
      {
        name: 'media_music',
        description: '使用 Bridge Media Studio 按风格描述生成音乐并保存到当前会话工作目录（耗时约 1–2 分钟且按次计费，用户未明确要求音乐时请先确认）。两分半内没生成完会先返回任务 id，过一会儿用 media_result 取结果，别重新发起。换模型传 model，卡上的其它参数放 params，部分模型收参考音频（inputs role audio），先用 media_models 查。回复中附上返回的 Markdown 链接即可渲染音频播放卡。',
        schema: {
          prompt: z.string().min(1).max(4000).describe('曲风、乐器、情绪与节奏描述'),
          negativePrompt: z.string().max(500).optional().describe('需要排除的元素'),
          model: z.string().optional().describe('可选音乐模型 id 或 <服务>/<模型>'),
          saveTo: z.string().optional().describe('相对当前会话工作目录的保存路径或子目录'),
          params: PARAMS_FIELD,
          inputs: INPUTS_FIELD,
        },
        handler: async (args, extra) => {
          try { return await deliverMedia('media_music', 'media.music', '音乐', args, 15 * 60_000, extra); }
          catch (err) { return fail('生成音乐失败', err); }
        },
      },
      {
        name: 'media_result',
        description: '取一次生成任务的结果：生成工具回「还在生成，任务 id …」之后，过一会儿用它查。跑完了就把作品存进当前会话工作目录并返回 Markdown 链接；还没完会再等一会儿（最多约 2 分半）并告诉你进度，接着再调即可。不花钱，不会重新生成。',
        schema: {
          job: z.string().min(1).max(80).describe('任务 id（生成工具回执里的）'),
          saveTo: z.string().optional().describe('相对当前会话工作目录的保存路径或子目录（以 / 结尾表示目录）'),
        },
        handler: async (args) => {
          try {
            await callInternal('/api/agy/internal/gate', { category: 'media' });
            const { job } = await callAgentOp('studio.job', { id: String(args.job).trim() }, { timeoutMs: 20_000 });
            // 这里只是等：中途被停止不取消任务（取消是发起那次调用的事）
            return await settleJob(await waitJob(job, null, WAIT_BUDGET_MS), { toolName: 'media_result', saveTo: args.saveTo });
          } catch (err) { return fail('取生成结果失败', err); }
        },
      },
      {
        name: 'media_models',
        description: '列出能用的媒体模型——Media Studio 里的全部服务（含用户自己接的 fal / Replicate / OpenRouter / ElevenLabs 等）：模型键（填生成工具的 model）、能收的素材（inputs 的角色与张数）、参数键与取值（填 params）、默认模型。带 key 查某一个模型的完整参数表（配音模型带音色）。换模型、改图 / 给参考图、调条数 / 种子 / 画质这类进阶参数之前先查这里；只读，不花钱。',
        schema: {
          kind: z.enum(['image', 'video', 'speech', 'music']).optional().describe('只看这一种媒体'),
          key: z.string().max(300).optional().describe('只看这一个模型：<服务 id>/<模型 id>'),
          q: z.string().max(100).optional().describe('按名字 / id 过滤'),
        },
        handler: async (args) => {
          try {
            await callInternal('/api/agy/internal/gate', { category: 'media' });
            const res = await callAgentOp('studio.models', cleanArgs(args));
            const text = JSON.stringify(res, null, 1);
            return txt(text.length > 60_000 ? text.slice(0, 60_000) + '\n…（太长，已截断：加 kind / q 缩小范围，或带 key 只看一个模型）' : text);
          } catch (err) { return fail('读取媒体模型失败', err); }
        },
      }
    );
  }

  if (active.has('ui')) {
    tools.push(
      {
        name: 'ui_view',
        description: '查看用户当前打开的 Bridge 客户端界面状态（所在分页、打开的文件面板路径、正在预览的文件、前台可见性与手机设备句柄）。',
        schema: {},
        handler: async () => {
          try {
            await callInternal('/api/agy/internal/gate', { category: 'ui' });
            const res = await callAgentOp('ui.view', {});
            return txt(JSON.stringify(res, null, 2));
          } catch (err) {
            return fail('读取界面状态失败', err);
          }
        },
      },
      {
        name: 'ui_open',
        description: '在用户的 Bridge 界面中打开指定分页、文件预览或文件夹（page / session / file / folder 四选一；仅在用户要求引导或展示时使用）。file / folder 相对当前会话工作目录（也收绝对路径）；用户此刻在 Antigravity 页上时在他右侧工作区的文件卡里打开，在别的页面时带他去看。',
        schema: {
          page: z.enum(['home', 'claude', 'files', 'routines', 'settings', 'chatgpt', 'agy', 'dimensio', 'studio']).optional().describe('目标顶层分页'),
          module: z.enum(['image', 'video', 'voice', 'music']).optional().describe('Media Studio 子创作页'),
          section: z.string().max(40).optional().describe('settings 分页的子分区名，如 agy、account、extensions'),
          session: z.string().optional().describe('Claude 会话 id'),
          file: z.string().optional().describe('文件路径（打开预览）：相对当前会话工作目录，或绝对路径'),
          folder: z.string().optional().describe('文件夹路径（定位过去）：相对当前会话工作目录，或绝对路径；会话目录本身写 .'),
          client: z.string().optional().describe('指定客户端 id（见 ui_view 的 client），或 all'),
          device: z.string().max(64).optional().describe('指定手机设备句柄或名称'),
        },
        handler: async (args) => {
          try {
            const clean = cleanArgs(args);
            // 文件 / 文件夹要按这一轮的会话目录解析、在 agy 页的工作区卡片里打开：走服务端内部接口（它认得出是哪一轮）
            if (clean.file || clean.folder) {
              const r = await callInternal('/api/agy/internal/ui-open', clean);
              return txt(JSON.stringify(r?.data ?? r, null, 2));
            }
            await callInternal('/api/agy/internal/gate', { category: 'ui' });
            const res = await callAgentOp('ui.open', clean);
            return txt(JSON.stringify(res, null, 2));
          } catch (err) {
            return fail('打开界面目标失败', err);
          }
        },
      },
      {
        name: 'ui_toast',
        description: '在用户当前打开的 Bridge 界面底部弹出一条轻量短提示（toast）。',
        schema: {
          text: z.string().min(1).max(200).describe('提示文案'),
          client: z.string().optional().describe('指定客户端 id 或 all'),
          device: z.string().max(64).optional().describe('指定手机设备句柄或名称'),
        },
        handler: async (args) => {
          try {
            await callInternal('/api/agy/internal/gate', { category: 'ui' });
            const res = await callAgentOp('ui.notify', cleanArgs(args));
            return txt(JSON.stringify(res, null, 2));
          } catch (err) {
            return fail('发送界面提示失败', err);
          }
        },
      }
    );
  }

  if (active.has('phone')) {
    const callPhone = (op, args = {}, timeoutMs = 60_000) => callInternal('/api/agy/internal/phone', {
      op,
      args,
      timeoutMs,
      toolName: `phone_${op}`,
    }, { timeoutMs: timeoutMs + 5_000 });

    tools.push(
      {
        name: 'phone_list',
        description: '列出发起当前对话的手机上【已授权文件夹】内的一层目录内容。path 留空列出全部已授权根位置（如 @r1），传入 "@r1/子目录" 查看对应目录。无法访问 Android/data 等私有缓存。',
        schema: {
          path: z.string().optional().describe('留空列出全部已授权根位置，或传 "@rN/子路径"'),
        },
        handler: async (args) => {
          try {
            const r = await callPhone('list', { path: args.path || '' });
            const items = Array.isArray(r?.entries) ? r.entries : [];
            if (!items.length) return txt('（空目录或无可见内容）');
            return txt(items.map((e) => `${e.isDir ? '📁' : '📄'} ${e.name}` + (e.isDir ? '' : `  ${((e.size || 0) / 1024).toFixed(0)} KB`)).join('\n'));
          } catch (err) { return fail('手机目录读取失败', err); }
        },
      },
      {
        name: 'phone_read',
        description: '读取发起当前对话的手机上已授权范围内的文件内容（单文件上限 8MB）。默认 utf8 文本，二进制传 base64。',
        schema: {
          path: z.string().min(1).describe('手机端授权范围内的文件路径'),
          encoding: z.enum(['utf8', 'base64']).optional().describe('utf8（默认）或 base64'),
        },
        handler: async (args) => {
          try {
            const r = await callPhone('read', { path: args.path, encoding: args.encoding || 'utf8' });
            const body = typeof r?.content === 'string' ? r.content : '';
            return txt(`文件 ${args.path}（${r?.encoding || 'utf8'}${r?.truncated ? '，已截断' : ''}）：\n\n` + body);
          } catch (err) { return fail('手机文件读取失败', err); }
        },
      },
      {
        name: 'phone_write',
        description: '向发起当前对话的手机已授权范围内的文件写入内容（覆盖原内容，上限 8MB）。执行前请确认有必要修改用户手机文件。',
        schema: {
          path: z.string().min(1).describe('手机端授权范围内的目标文件路径'),
          content: z.string().describe('要写入的内容'),
          encoding: z.enum(['utf8', 'base64']).optional().describe('utf8（默认）或 base64'),
        },
        handler: async (args) => {
          try {
            await callPhone('write', { path: args.path, content: String(args.content ?? ''), encoding: args.encoding || 'utf8' });
            return txt('已写入 ' + args.path);
          } catch (err) { return fail('手机文件写入失败', err); }
        },
      },
      {
        name: 'phone_scan',
        description: '递归扫描手机已授权目录，按体积降序找出大文件候选清单（只返回路径、大小、时间元数据；无法扫描 Android/data 等私有缓存）。',
        schema: {
          path: z.string().optional().describe('限定扫描的子目录，留空扫描全部授权目录'),
          minSizeMB: z.number().optional().describe('最小文件体积（MB），默认 20'),
          limit: z.number().optional().describe('最多返回条数，默认 100'),
        },
        handler: async (args) => {
          try {
            const r = await callPhone('scan', {
              path: args.path || '',
              minSizeMB: args.minSizeMB ?? 20,
              limit: Math.min(args.limit ?? 100, 500),
            }, 150_000);   // agy 单次工具调用 180 秒硬上限：留出余量，到点正常报「还没扫完」而不是被 agy 判超时
            return formatScanResult(r);
          } catch (err) { return fail('手机大文件扫描失败', err); }
        },
      },
      {
        name: 'phone_delete',
        description: '删除手机已授权范围内的指定文件（不可撤销）。调用前必须先向用户列出文件路径与体积并获得明确确认。',
        schema: {
          path: z.string().min(1).describe('要删除的手机文件路径'),
        },
        handler: async (args) => {
          try {
            await callPhone('delete', { path: args.path });
            return txt('已删除 ' + args.path);
          } catch (err) { return fail('手机文件删除失败', err); }
        },
      }
    );
  }

  return tools;
}

export function registerAgyBridgeTools(server, opts = {}) {
  const defs = buildAgyBridgeToolDefs(opts);
  for (const def of defs) {
    server.tool(def.name, def.description, def.schema, def.handler);
  }
  return defs.map((d) => d.name);
}
