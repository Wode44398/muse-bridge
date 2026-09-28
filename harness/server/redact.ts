// S4（#37）出口脱敏：Read / Grep / WebFetch / ReadPage / Eval / Bash 的结果交给模型之前统一过
// 这一遍——密钥守卫漏掉的（项目里某个配置文件、网页、命令输出里恰好有一把真令牌）在这里兜住。
// 只用高置信规则：源码里 `token = getToken()` 这类普通赋值一律不动，否则模型读到的文本和
// 磁盘对不上，Edit 的 old_string 就配不上了。
//   1. harness 进程里名字像密钥的环境变量的值（精确匹配，零误报）；
//   2. PEM 私钥块；
//   3. `Bearer <长令牌>`（含 JSON 里的 "Authorization": "Bearer …"）；
//   4. 知名前缀的令牌（Anthropic、GitHub、Slack、AWS、Google、OpenAI 形态）。
// Bash 另有自己更宽的一层（NAME=value 行），见 tools/bash.ts。

export const REDACTION_MARK = "[REDACTED";

const SECRET_ENV_NAME_RE = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE[_-]?KEY)/i;

const PEM_RE = /-----BEGIN ([A-Z0-9 ]*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{20,}/g;
const KNOWN_TOKEN_RE = new RegExp(
  [
    String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}`,
    String.raw`\bgithub_pat_[A-Za-z0-9_]{20,}`,
    String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}`,
    String.raw`\bxox[abeoprs]-[A-Za-z0-9-]{10,}`,
    String.raw`\bAKIA[0-9A-Z]{16}\b`,
    String.raw`\bAIza[0-9A-Za-z_-]{35}`,
    String.raw`\bsk-(?:proj-|kimi-)?[A-Za-z0-9_-]{32,}`,
  ].join("|"),
  "g",
);

function envSecretValues(): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 12 || !SECRET_ENV_NAME_RE.test(name)) continue;
    if (/^[a-z]+:\/\//i.test(value)) continue; // URL 形态的配置不是密钥
    out.push([name, value]);
  }
  // 长的先换：一个值是另一个值的子串时，别让短的把长的切碎。
  return out.sort((a, b) => b[1].length - a[1].length);
}

export function redactOutput(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [name, value] of envSecretValues()) {
    if (out.includes(value)) out = out.split(value).join(`[REDACTED:${name}]`);
  }
  out = out.replace(PEM_RE, "[REDACTED:PRIVATE_KEY]");
  out = out.replace(BEARER_RE, "$1 [REDACTED]");
  out = out.replace(KNOWN_TOKEN_RE, "[REDACTED:TOKEN]");
  return out;
}

// 写回磁盘前的保险（S4）：模型看到的是脱敏后的文本，它若把 [REDACTED…] 原样写进文件，
// 就把真密钥覆盖掉了。新内容里的标记比原文多，就拒绝。
export function introducesRedactionMark(before: string, after: string): boolean {
  const count = (s: string) => s.split(REDACTION_MARK).length - 1;
  return count(after) > count(before);
}

export const REDACTED_WRITE_HINT =
  "The text you are writing contains a [REDACTED…] marker. Tool output hides secrets that way, so writing it " +
  "back would replace the real secret in the file with the marker. Leave the lines that hold secrets untouched " +
  "(edit around them with a narrower old_string), or ask the user to change the secret themselves.";
