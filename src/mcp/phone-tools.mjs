// 档 2「手机即远程文件系统」的 MCP 工具（手机端原生桥未就绪前的 PC 侧后端）。
//
// 5 个工具，每个把请求经 requestPhone() 下发到发起对话的那台手机，手机原生（SAF
// 授权文件夹）执行后回传，handler 把结果格式化给 Claude：
//   phone_list   列目录（name/isDir/size/mtime）
//   phone_read   读文件（文本，或二进制 base64；上限 PHONE_MAX_BYTES）
//   phone_write  写文件（覆盖；content 文本/base64）
//   phone_scan   递归扫描出「体积大的文件」清单（按大小降序）——清缓存/找大文件用例核心
//   phone_delete 删除文件（破坏性：工具描述要求先经 AskUserQuestion 让用户确认）
//
// 能力边界（写进描述 + PHONE_NUDGE，因为这是 Android 系统级硬限制、不是实现缺陷）：
//   · 只能访问用户授权过的文件夹 / 媒体库——看不到 app 私有缓存（Android/data、
//     Android/obb），那是「手机管家清缓存」的重灾区，任何普通 app 都碰不到。
//   · 路径都是手机端绝对路径或授权根的相对路径，由手机原生层最终裁决合法性。
//
// makePhoneMcp({ genKey }) 把工具绑定到一个 caller——命令只会下发到这个人自己的手机。
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { requestPhone } from '../runtime/phone-bridge.mjs';

const txt = (s) => ({ content: [{ type: 'text', text: s }] });
const errText = (e) => txt('手机文件操作失败：' + String(e?.message ?? e).slice(0, 240));

// 给 Claude 的 scan 结果：人类可读摘要（按大小）+ 结构化，方便它直接给"建议清理"清单。
function fmtScan(result) {
  const files = Array.isArray(result?.files) ? result.files : [];
  if (!files.length) return txt('扫描完成：在可访问范围内没有匹配的文件。');
  const totalMB = (files.reduce((s, f) => s + (f.size || 0), 0) / 1048576).toFixed(1);
  const lines = files.map((f) => {
    const mb = ((f.size || 0) / 1048576).toFixed(1);
    const when = f.mtime ? new Date(f.mtime).toISOString().slice(0, 10) : '?';
    return `${mb} MB  ${when}  ${f.path}`;
  });
  return txt(`扫描到 ${files.length} 个文件，合计约 ${totalMB} MB（按大小降序）：\n` + lines.join('\n')
    + (result.truncated ? '\n…（清单被截断，还有更多，可缩小范围或提高 minSizeMB 再扫）' : '')
    + '\n\n说明：以上仅是「体积较大」的候选，是否「没用」需你结合文件名/路径/时间判断，给用户列出建议清理项+理由+体积，并务必让用户确认后再用 phone_delete 删除。无法看到 app 缓存（Android/data）等系统保护区。');
}

export function buildPhoneTools(genKey, getGen) {
  // 多对话并发：命令精确下发到发起调用的那一轮（getGen 闭包）；无 getGen 回落 key 查找。
  const phone = (o) => requestPhone({ genKey, gen: getGen ? getGen() : undefined, ...o });
  return [
    {
      name: 'phone_list',
      description: '列出手机上某个【已授权文件夹】里的内容（一层，不递归）。path 留空=列出所有「本地位置」（用户授权的各个文件夹，每项是一个可进入的根，name 形如 "@r1"、另带 label 显示名）；要浏览某个位置就把它的 name 当 path 传（如 "@r1" 或 "@r1/子目录"）。也兼容裸相对路径（不带位置前缀时落到第一个位置）。返回每项的 name/isDir/size(字节)/mtime。仅能访问用户通过系统选择器授权过的文件夹与媒体库，看不到 app 私有缓存。',
      schema: { path: z.string().optional().describe('留空=列出所有本地位置；或 "@rN/子路径" 进入某个位置') },
      handler: async (a) => {
        try {
          const r = await phone({ op: 'list', args: { path: a.path || '' } });
          const items = Array.isArray(r?.entries) ? r.entries : [];
          if (!items.length) return txt('（空目录或无可见内容）');
          return txt(items.map((e) => `${e.isDir ? '📁' : '📄'} ${e.name}` + (e.isDir ? '' : `  ${((e.size || 0) / 1024).toFixed(0)} KB`)).join('\n'));
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_read',
      description: '读取手机上某个文件的内容。默认按 UTF-8 文本返回；二进制文件传 encoding:"base64"。单文件上限 8MB，超出会被手机端拒绝（请改用范围/分块，或别读巨大文件）。仅限已授权范围。',
      schema: {
        path: z.string().describe('文件路径'),
        encoding: z.enum(['utf8', 'base64']).optional().describe('utf8(默认文本) | base64(二进制)'),
      },
      handler: async (a) => {
        try {
          const r = await phone({ op: 'read', args: { path: a.path, encoding: a.encoding || 'utf8' } });
          const body = typeof r?.content === 'string' ? r.content : '';
          return txt(`文件 ${a.path}（${r?.encoding || 'utf8'}${r?.truncated ? '，已截断' : ''}）：\n\n` + body);
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_write',
      description: '把内容写入手机上某个文件（覆盖原内容；目录须在已授权范围内）。content 默认按 UTF-8 文本写；二进制传 encoding:"base64"。内容上限 8MB。会真实改动用户手机文件，确认必要再写。',
      schema: {
        path: z.string().describe('目标文件路径（授权范围内）'),
        content: z.string().describe('要写入的内容'),
        encoding: z.enum(['utf8', 'base64']).optional().describe('utf8(默认) | base64'),
      },
      handler: async (a) => {
        try {
          await phone({ op: 'write', args: { path: a.path, content: String(a.content ?? ''), encoding: a.encoding || 'utf8' } });
          return txt('已写入 ' + a.path);
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_scan',
      description: '递归扫描手机已授权范围，找出【体积较大的文件】（按大小降序），用于「清理占地方的文件 / 找大文件」。可设 minSizeMB（默认 20，只列≥此大小的）、path（限定子目录）、limit（最多返回条数，默认 100）。只回路径/大小/时间元数据，不读内容。【重要边界】扫不到 app 私有缓存（Android/data、Android/obb）——那是手机管家清缓存的地方、任何普通 app 都访问不了；本工具只能看用户授权的文档/媒体区。',
      schema: {
        path: z.string().optional().describe('限定扫描的子目录，留空=整个授权范围'),
        minSizeMB: z.number().optional().describe('只列出 ≥ 此大小(MB)的文件，默认 20'),
        limit: z.number().optional().describe('最多返回条数，默认 100'),
      },
      handler: async (a) => {
        try {
          const r = await phone({
            op: 'scan',
            args: { path: a.path || '', minSizeMB: a.minSizeMB ?? 20, limit: Math.min(a.limit ?? 100, 500) },
            timeoutMs: 180_000,  // 全盘递归慢，放宽
          });
          return fmtScan(r);
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_pull',
      description: '把手机上的一个文件【完整拉取到电脑】：手机分块流式上传到 PC 的 uploads 目录，返回文件在电脑上的绝对路径。当你需要用【电脑侧工具】处理手机文件时用——典型场景：解压 rar/zip/7z 压缩包、格式转换、大文件分析、批量处理。与 phone_read 的区别：文件字节不进对话上下文、没有 8MB 限制（流式上限 2GB，大文件耗时取决于手机网速，最长等 10 分钟）。拿到返回的绝对路径后直接用 Bash / Read 处理。需要手机 App 在线（前台打开或正在本轮对话）。',
      schema: { path: z.string().describe('手机上的文件路径（"@rN/子路径" 进入某个已授权位置，或裸相对路径落首个位置）') },
      handler: async (a) => {
        try {
          const r = await phone({ op: 'pull', args: { path: a.path }, timeoutMs: 600_000 });
          const mb = ((r?.size || 0) / 1048576).toFixed(1);
          return txt(`已把手机文件拉到电脑：${r?.path}（${mb} MB）\n接下来直接用 Bash / Read 处理这个路径即可（解压、转换、分析等）。`);
        } catch (e) { return errText(e); }
      },
    },
    {
      name: 'phone_delete',
      description: '删除手机上某个文件（授权范围内）。这是【破坏性、不可撤销】操作：调用前【必须】先用 AskUserQuestion 把要删的文件（路径+体积）列给用户、得到明确确认，严禁未经确认批量删除。',
      schema: { path: z.string().describe('要删除的文件路径') },
      handler: async (a) => {
        try {
          await phone({ op: 'delete', args: { path: a.path } });
          return txt('已删除 ' + a.path);
        } catch (e) { return errText(e); }
      },
    },
  ];
}

// 绑定到一个 caller 的 phone MCP（命令只下发到这台设备）。
export function makePhoneMcp({ genKey = 'admin', getGen } = {}) {
  return createSdkMcpServer({
    name: 'phone',
    version: '1.0.0',
    tools: buildPhoneTools(genKey, getGen).map((t) => tool(t.name, t.description, t.schema, t.handler)),
  });
}

// systemPrompt 追加：告诉 Claude 有这套工具 + 何时用 + 硬边界。
export const PHONE_NUDGE = '\n\n你还有一组「手机文件」MCP 工具（mcp__phone__list / read / write / scan / delete / pull），可以操作用户手机上【经系统选择器授权过的文件夹与媒体库】里的文件。当用户要你查看/整理/编辑手机上的文件、或问「我手机里哪些大文件没用」这类问题时使用：用 phone_scan 找体积大的候选、phone_list/read 查看、phone_write 改写、phone_delete 删除（删除前【务必】用 AskUserQuestion 让用户逐项确认）。【需要用电脑工具处理手机文件时】——解压手机上的压缩包、转格式、分析大文件/二进制——用 phone_pull 把文件完整拉到电脑（返回 PC 绝对路径，流式无 8MB 限制），再对该路径用 Bash 处理；【不要】用 phone_read 读二进制或大文件（那会把 base64 灌进对话、8MB 封顶）。【硬边界｜务必如实告知用户】这些工具只能看用户授权的文档/媒体区，【看不到】app 私有缓存（Android/data 等）——那是「手机管家清缓存」的地方、受 Android 系统保护、任何普通 app 都访问不了；所以你能帮用户清理的是「文档区里的大文件」，清不了系统缓存垃圾，别承诺做不到的事。';
