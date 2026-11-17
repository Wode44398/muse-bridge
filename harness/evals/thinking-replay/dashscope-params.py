# 百炼上各家型号认哪些思考参数：同一道小题，逐个参数写法看状态码与推理量（推理 token / 思考原文长度）。Key 不打印。
# 用法：python -I dashscope-params.py <plugin-providers.json> <输出 jsonl> [每格次数]
import json, sys, time, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

src, out = sys.argv[1], sys.argv[2]
reps = int(sys.argv[3]) if len(sys.argv) > 3 else 2
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
B = json.load(open(src, encoding="utf-8"))["builtins"]["qwen"]
BASE, KEY = B["baseUrl"].rstrip("/"), B["key"]
MODELS = ["qwen4-max", "kimi-k3.1-pro", "kimi/kimi-k3.1-pro-highspeed", "glm-5.3", "glm-5.3-prime", "ZHIPU/GLM-5.3",
          "ZHIPU/GLM-5.3-FlashX", "deepseek-v4.1-flash-1017", "vanchin/deepseek-v4.1-flash-1017"]
TOOLS = [{"type": "function", "function": {"name": "noop", "description": "不用调用", "parameters": {"type": "object", "properties": {}}}}]
CONFIGS = [
    ("不发", {}),
    ("enable_thinking:false", {"enable_thinking": False}),
    ("enable_thinking:true", {"enable_thinking": True}),
    ("reasoning_effort:low", {"reasoning_effort": "low"}),
    ("reasoning_effort:max", {"reasoning_effort": "max"}),
    ("reasoning_effort:none", {"reasoning_effort": "none"}),
    ("thinking.type:disabled", {"thinking": {"type": "disabled"}}),
    ("thinking_budget:1024", {"enable_thinking": True, "thinking_budget": 1024}),
    ("preserve_thinking:true", {"preserve_thinking": True}),
    ("enable_search+tools", {"enable_search": True, "tools": TOOLS}),
]
Q = "有一个三位数，各位数字之和是 15，百位比个位大 3，十位是个位的 2 倍。这个数是多少？只回答数字。"


def one(job):
    model, name, extra, rep = job
    body = {"model": model, "messages": [{"role": "user", "content": Q}], "max_tokens": 8000, "stream": True,
            "stream_options": {"include_usage": True}, **extra}
    req = urllib.request.Request(BASE + "/chat/completions", data=json.dumps(body).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "Authorization": "Bearer " + KEY})
    t0 = time.time()
    r = {"model": model, "cfg": name, "rep": rep}
    try:
        rl = cl = 0
        usage = None
        with urllib.request.urlopen(req, timeout=300) as resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    j = json.loads(data)
                except Exception:
                    continue
                if j.get("usage"):
                    usage = j["usage"]
                for ch in j.get("choices") or []:
                    dl = ch.get("delta") or {}
                    rl += len(dl.get("reasoning_content") or "")
                    cl += len(dl.get("content") or "")
        r.update({"status": 200, "rlen": rl, "clen": cl,
                  "rtok": ((usage or {}).get("completion_tokens_details") or {}).get("reasoning_tokens"),
                  "ctok": (usage or {}).get("completion_tokens")})
    except urllib.error.HTTPError as e:
        r.update({"status": e.code, "error": e.read().decode("utf-8", "replace").replace(KEY, "***")[:240]})
    except Exception as e:
        r.update({"status": 0, "error": str(e)[:160]})
    r["sec"] = round(time.time() - t0, 1)
    return r


jobs = [(m, n, x, i) for m in MODELS for (n, x) in CONFIGS for i in range(1, reps + 1)]
with ThreadPoolExecutor(max_workers=8) as ex, open(out, "w", encoding="utf-8") as f:
    for r in ex.map(one, jobs):
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
        f.flush()
print("done", len(jobs))
