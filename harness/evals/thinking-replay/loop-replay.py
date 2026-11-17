# 工具循环里的思考回传体检（模型自己生成的思考）：
#   第一步：让模型只在思考里想一个六位数、正文不写，先调工具；
#   第二步：把它自己第一步的思考按不同写法放回 assistant 消息，带上工具结果，让它说出那个数。
# 第一步的思考里出现了六位数、正文里没有，才算有效样本；第二步回答的数字出现在第一步思考里 = 用上了回传。
# 同一个第一步结果分给所有写法，写法之间可比。Key 不打印、不落盘。
# 用法：python -I loop-replay.py <plugin-providers.json> <输出 jsonl> [每格第一步次数] [只跑的线路,逗号分隔]
import json, re, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

import os
CROSS = os.environ.get("CROSS") == "1"
EXTRA = os.environ.get("EXTRA_CELLS")
src, out = sys.argv[1], sys.argv[2]
reps = int(sys.argv[3]) if len(sys.argv) > 3 else 3
only = set(sys.argv[4].split(",")) if len(sys.argv) > 4 and sys.argv[4] else None
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
d = json.load(open(src, encoding="utf-8"))
B = d.get("builtins") or {}
cards = {c["id"]: c for c in d.get("providers", [])}
LINES = {
    "百炼": (B["qwen"]["baseUrl"].rstrip("/"), B["qwen"]["key"]),
    "Kimi直连": (B["kimi"]["baseUrl"].rstrip("/"), B["kimi"]["key"]),
    "OpenRouter": (cards["custom-e6ca5af6"]["baseUrl"].rstrip("/"), ""),
    "fp8自建": (cards["custom-fc1d9424"]["baseUrl"].rstrip("/"), ""),
}
SECRETS = [v for v in (B["qwen"]["key"], B["kimi"]["key"]) if v]

E = lambda lv: {"reasoning_effort": lv}
CELLS = [
    ("百炼", "qwen4-max", {"enable_thinking": True, "reasoning_effort": "medium"}),
    ("百炼", "kimi-k3.1-pro", {"enable_thinking": True}),
    ("百炼", "glm-5.3", {"enable_thinking": True}),
    ("百炼", "glm-5.3-prime", {"enable_thinking": True}),
    ("百炼", "deepseek-v4.1-flash-1017", {"enable_thinking": True}),
    ("Kimi直连", "k3.1-pro", E("high")),
    ("OpenRouter", "anthropic/claude-opus-5.5", E("medium")),
    ("OpenRouter", "openai/gpt-6.1-sol", E("medium")),
    ("OpenRouter", "openai/gpt-6-astra", E("medium")),
    ("OpenRouter", "openai/gpt-6.1-terra", E("medium")),
    ("OpenRouter", "google/gemini-4-argon", E("medium")),
    ("OpenRouter", "x-ai/grok-4.7", E("medium")),
    ("OpenRouter", "deepseek/deepseek-v4.1-flash", E("high")),
    ("OpenRouter", "moonshotai/kimi-k3.1-pro", E("high")),
    ("OpenRouter", "qwen/qwen3.8-max-0902", E("medium")),
    ("OpenRouter", "z-ai/glm-5.3", E("high")),
    ("OpenRouter", "meta/muse-spark-1.3", E("medium")),
    ("OpenRouter", "tencent/hy4", E("high")),
    ("OpenRouter", "mistralai/mistral-large-4-0", E("medium")),
    ("fp8自建", "qwen3.8-flash-next-fp8", {"chat_template_kwargs": {"enable_thinking": True, "reasoning_effort": "low"}}),
]
if EXTRA:
    CELLS = json.loads(open(EXTRA, encoding="utf-8").read())
if only:
    CELLS = [c for c in CELLS if c[0] in only or c[1] in only]

WAYS = ["不回传", "reasoning_content", "reasoning", "reasoning_content+preserve", "reasoning_details"]
TOOLS = [{"type": "function", "function": {"name": "roll_dice", "description": "掷一个六面骰子，返回点数", "parameters": {"type": "object", "properties": {"note": {"type": "string", "description": "随便写点什么"}}, "required": []}}}]
ASK = ("做个记忆小游戏：请只在你的思考过程里随机想好一个六位数（不要用 123456 这类规律数），"
       "这一步的回复正文里绝对不要写出它，也不要把它写进工具参数。"
       "想好之后先调用一次 roll_dice 工具；拿到骰子结果之后，正文只回答你之前心里想好的那个六位数，不要别的字。")
SIX = re.compile(r"(?<!\d)\d{6}(?!\d)")


def scrub(s):
    for k in SECRETS:
        s = s.replace(k, "***")
    return s


def post(line, body):
    base, key = LINES[line]
    h = {"Content-Type": "application/json"}
    if key:
        h["Authorization"] = "Bearer " + key
    req = urllib.request.Request(base + "/chat/completions", data=json.dumps(body).encode(), method="POST", headers=h)
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return 200, json.loads(r.read().decode("utf-8")), round(time.time() - t0, 1)
    except urllib.error.HTTPError as e:
        return e.code, scrub(e.read().decode("utf-8", "replace"))[:300], round(time.time() - t0, 1)
    except Exception as e:
        return 0, str(e)[:200], round(time.time() - t0, 1)


def reasoning_text(msg):
    if isinstance(msg.get("reasoning_content"), str) and msg["reasoning_content"]:
        return msg["reasoning_content"]
    if isinstance(msg.get("reasoning"), str) and msg["reasoning"]:
        return msg["reasoning"]
    parts = []
    for x in msg.get("reasoning_details") or []:
        for k in ("text", "summary"):
            if isinstance(x.get(k), str):
                parts.append(x[k])
    return "\n".join(parts)


def step1(job):
    line, model, on, rep = job
    body = {"model": model, "messages": [{"role": "user", "content": ASK}], "tools": TOOLS, "max_tokens": 6000, **on}
    st, j, sec = post(line, body)
    rec = {"line": line, "model": model, "rep": rep, "s1_status": st, "s1_sec": sec}
    if st != 200:
        rec["s1_error"] = j if isinstance(j, str) else json.dumps(j, ensure_ascii=False)[:300]
        return rec, None
    msg = ((j.get("choices") or [{}])[0].get("message")) or {}
    rt = reasoning_text(msg)
    content = str(msg.get("content") or "")
    calls = msg.get("tool_calls") or []
    nums = set(SIX.findall(rt))
    leaked = set(SIX.findall(content + json.dumps(calls, ensure_ascii=False)))
    details = msg.get("reasoning_details") or []
    rec.update({
        "fields": [k for k in ("reasoning_content", "reasoning", "reasoning_details") if msg.get(k)],
        "detail_types": sorted({x.get("type", "?") for x in details}),
        "rlen": len(rt), "rnums": len(nums), "leak": bool(nums & leaked) or bool(leaked),
        "calls": len(calls),
        "rtok": ((j.get("usage") or {}).get("completion_tokens_details") or {}).get("reasoning_tokens"),
    })
    opaque = not nums and any(x.get("type") == "reasoning.encrypted" for x in details)
    valid = bool(calls) and (bool(nums) or opaque) and not leaked
    rec["valid"] = valid
    rec["opaque"] = opaque
    if not calls:
        rec["s1_content"] = content[:60]
    return rec, (msg, rt, nums, calls) if valid else None


def step2(job):
    line, model, on, rec, (msg, rt, nums, calls), way = job
    call = calls[0]
    a = {"role": "assistant", "content": msg.get("content") or "", "tool_calls": [call]}
    extra = {}
    if way == "reasoning_content":
        a["reasoning_content"] = rt
    elif way == "reasoning":
        a["reasoning"] = rt
    elif way == "reasoning_content+preserve":
        a["reasoning_content"] = rt
        extra = {"preserve_thinking": True}
    elif way == "reasoning_details":
        a["reasoning_details"] = msg.get("reasoning_details") or [{"type": "reasoning.text", "text": rt, "format": "unknown", "index": 0}]
    msgs = [{"role": "user", "content": ASK}, a, {"role": "tool", "tool_call_id": call.get("id") or "call_1", "content": "骰子点数：4"}]
    if CROSS:
        msgs += [{"role": "assistant", "content": "骰子是 4。"}, {"role": "user", "content": "好，现在只回答你最开始在思考里想好的那个六位数。"}]
    body = {"model": model, "messages": msgs, "tools": TOOLS, "max_tokens": 6000, **on, **extra}
    st, j, sec = post(line, body)
    r = {"line": line, "model": model, "rep": rec["rep"], "way": way, "status": st, "sec": sec}
    if st != 200:
        r["error"] = j if isinstance(j, str) else json.dumps(j, ensure_ascii=False)[:300]
        return r
    m2 = ((j.get("choices") or [{}])[0].get("message")) or {}
    ans = str(m2.get("content") or "")
    got = set(SIX.findall(ans))
    r.update({"hit": (bool(got & nums) if nums else None), "answer": ans.strip()[:40], "rtok2": ((j.get("usage") or {}).get("completion_tokens_details") or {}).get("reasoning_tokens"), "ptok2": (j.get("usage") or {}).get("prompt_tokens")})
    return r


jobs1 = [(l, m, on, r) for (l, m, on) in CELLS for r in range(1, reps + 1)]
with ThreadPoolExecutor(max_workers=10) as ex, open(out, "w", encoding="utf-8") as f:
    firsts = list(ex.map(step1, jobs1))
    for (rec, _), (l, m, on, r) in zip(firsts, jobs1):
        f.write(json.dumps({"kind": "s1", **rec}, ensure_ascii=False) + "\n")
    f.flush()
    jobs2 = []
    for (rec, got), (l, m, on, r) in zip(firsts, jobs1):
        if got:
            for w in WAYS:
                jobs2.append((l, m, on, rec, got, w))
    for r in ex.map(step2, jobs2):
        f.write(json.dumps({"kind": "s2", **r}, ensure_ascii=False) + "\n")
        f.flush()
print("done", len(jobs1), len(jobs2))
