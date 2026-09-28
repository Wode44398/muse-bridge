// P4（#15、#4）：共享 shell 分词器之上的三条判定——危险命令按命令位判（K5）、Bash 规则按子命令判（A5）、
// 纯读命令在 plan / read-only 档放行（C9）。表驱动，全部走对外入口（deniedCommand、decide）。
import assert from "node:assert/strict";
import test from "node:test";
import { decide, type PermissionRules } from "./agent/permissions.ts";
import { deniedCommand } from "./tools/bash.ts";
import { toolMap } from "./tools/registry.ts";
import { parseShell } from "./tools/shell-words.ts";

const tools = toolMap();
const rules = (r: Partial<PermissionRules>): PermissionRules => ({ allow: r.allow ?? [], deny: r.deny ?? [], ask: r.ask ?? [] });
const bash = (command: string, mode: "auto" | "plan" | "read-only" = "auto", r?: PermissionRules) =>
  decide(mode, "Bash", tools, { command }, r);

test("K5: dangerous commands are judged at command position, not by a regex over the whole string", () => {
  // kimi 实测表（§1.5）：参数里出现这些词不是在跑它们——以前是硬拒，用户批准也没用
  const allowed = [
    "grep -rn reboot src",
    "git log --grep=shutdown",
    'echo "format c: 说明"',
    "npm run reboot-server",
    "cat > f.sh <<'EOF'\nreboot\nEOF", // here-document 正文是数据
    "ls # reboot", // 注释
    "rm -rf build dist",
    "rm -- -rf", // `--` 之后是文件名
    "rm -rf \"~\"", // 引号里的 ~ 是个叫 ~ 的目录
    "ssh host 'rm -rf /'", // 别的机器
    "docker run --rm alpine rm -rf /", // 容器里
    "adb shell rm -rf /data/local/tmp/x", // 手机上
  ];
  for (const command of allowed) assert.equal(deniedCommand(command), null, command);

  // 以前漏掉的旗标写法，和藏在包装器、命令替换、here-document、别的 shell 方言里的
  const denied = [
    "rm -fr /",
    "rm -r -f ~",
    "rm --recursive --force /",
    "rm -rf -- /",
    "/bin/rm -Rf /usr",
    'rm -rf "$HOME"',
    "rm -rf 'C:/Users/someone'",
    'bash -c "rm -rf /"',
    "npm test && rm -rf ~",
    "sudo rm -rf /",
    "env FOO=1 rm -rf ~",
    "nice -n 10 ionice -c 3 rm -rf ~/.cache/x",
    "busybox rm -rf /",
    "echo $(rm -rf /)",
    "echo `reboot`",
    "timeout 5 shutdown -h now",
    "if [ -f x ]; then rm -rf /; fi",
    "bash <<'EOF'\nreboot\nEOF", // 喂给 shell 的 here-document 是脚本
    "cat <<EOF\n$(rm -rf /)\nEOF", // 未加引号的 here-document 会展开命令替换
    "$'\\x72\\x6d' -rf /", // $'…' 里拼出来的 rm
    "cmd //c 'rd /s /q C:\\'",
    "powershell -NoProfile -Command 'Remove-Item -Recurse -Force C:\\Windows'",
    `powershell -enc ${Buffer.from("Stop-Computer", "utf16le").toString("base64")}`,
    "reg delete HKCU\\Software\\Foo /f",
    "format c: /q",
    "mkfs.ext4 /dev/sdb1",
    "shutdown /s /t 0",
    ":(){ :|:& };:",
  ];
  for (const command of denied) assert.ok(deniedCommand(command), command);
});

test("K5: what cannot be analyzed, or may delete from the root at run time, is put to the user", () => {
  // 目标运行时才知道、变量为空就落到根上（Steam 那个 bug）：转问，卡片标明是内置复核
  const steam = bash('rm -rf "$DIR/"*');
  assert.equal(steam.effect, "ask");
  assert.match(steam.rule ?? "", /高危/);
  assert.match(steam.reason, /only known at run time/);
  // 分析不了（eval 拼了运行时的值）又带高危程序名：转问
  assert.equal(bash('eval "$CMD"; rm -rf x').effect, "ask");
  // 分析不了但没有高危程序名、或者能分析且无害：照旧放行
  assert.equal(bash('bash -c "$SCRIPT"').effect, "allow");
  assert.equal(bash("rm -rf build").effect, "allow");
  // 用户点过「本会话都允许」（整条命令一字不差的 allow）就不再问
  assert.equal(bash('rm -rf "$DIR/"*', "auto", rules({ allow: ['Bash(rm -rf "$DIR/"*)'] })).effect, "allow");
});

test("A5: Bash rules are judged per sub-command — deny/ask on any, allow only when every one is covered", () => {
  // allow 前缀规则不再连带放行后面串上的命令
  const push = rules({ allow: ["Bash(git push:*)"], ask: ["Bash"] });
  assert.equal(bash("git push origin main", "auto", push).effect, "allow");
  assert.equal(bash("git push && rm -rf build", "auto", push).effect, "ask");
  assert.equal(bash("sudo git push", "auto", push).effect, "ask", "提权的子命令只认一字不差的规则");

  // deny 规则咬住串在后面、藏在包装器里的子命令
  const noRm = rules({ deny: ["Bash(rm -rf:*)"] });
  assert.equal(bash("cd x && rm -rf y", "auto", noRm).effect, "deny");
  assert.equal(bash("sudo rm -rf y", "auto", noRm).effect, "deny");
  assert.equal(bash('bash -c "rm -rf y"', "auto", noRm).effect, "deny");

  // 每条子命令都被覆盖才放行
  const ci = rules({ allow: ["Bash(git status)", "Bash(npm test:*)", "Bash([:*)"], ask: ["Bash"] });
  assert.equal(bash("npm test && git status", "auto", ci).effect, "allow");
  assert.equal(bash("if [ -f x ]; then npm test; fi", "auto", ci).effect, "allow", "关键字不算进子命令");
  assert.equal(bash("npm test && npm publish", "auto", ci).effect, "ask");

  // 带运行时的值、写文件的重定向：前缀规则不算覆盖
  const commit = rules({ allow: ["Bash(git commit:*)", "Bash(cat:*)"], ask: ["Bash"] });
  assert.equal(bash('git commit -m "$(cat msg)"', "auto", commit).effect, "ask");
  const log = rules({ allow: ["Bash(git log:*)"], ask: ["Bash"] });
  assert.equal(bash("git log > out.txt", "auto", log).effect, "ask");
  assert.equal(bash("git log 2>/dev/null", "auto", log).effect, "allow", "丢弃输出不是写文件");

  // 「本会话都允许」写下的整条原文照旧放行（里面有 * 也一样）
  const session = rules({ allow: ["Bash(ls *.ts && echo done)"], ask: ["Bash"] });
  assert.equal(bash("ls *.ts && echo done", "auto", session).effect, "allow");
});

test("C9: plain read-only commands run in plan and read-only mode; anything that writes or runs a program does not", () => {
  const reads = [
    "git status",
    "git --no-pager log -3",
    "git diff HEAD~1 -- src",
    "git branch",
    "git config --get user.name",
    "ls -la src | grep ts",
    "grep -rn foo src 2>/dev/null",
    "find . -name '*.ts' | xargs grep -l foo",
    "[[ -f x ]] && cat x",
    "cat <<'EOF'\n$(rm -rf /)\nEOF",
  ];
  const writes = [
    "npm test",
    "cd sub && git log", // ZCode 的安全阀：cd 与 git 同现不算只读
    "git -C sub status",
    "git -c core.pager=less log",
    "git branch -vD x",
    "git stash",
    "git diff --output=x.patch",
    "find . -name x -delete",
    "sort -o out.txt in.txt",
    "echo hi > f.txt",
    "cat $(rm x)",
    "sudo ls",
    "echo 'unterminated",
  ];
  for (const mode of ["plan", "read-only"] as const) {
    for (const command of reads) assert.equal(bash(command, mode).effect, "allow", `${mode}: ${command}`);
    for (const command of writes) assert.equal(bash(command, mode).effect, "deny", `${mode}: ${command}`);
  }
  // 后台跑的不降级；拒绝理由告诉模型纯读命令可以跑
  assert.equal(decide("plan", "Bash", tools, { command: "git status", background: true }).effect, "deny");
  assert.match(bash("npm test", "plan").reason, /read-only commands such as git status/);
});

test("the shell tokenizer never throws and says so when it cannot see everything", () => {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const alphabet = ["a", " ", "'", '"', "`", "$", "(", ")", "{", "}", "<", ">", "|", "&", ";", "\\", "\n", "#", "*", "rm", "-rf", "/", "EOF", "<<", "%"];
  for (let i = 0; i < 400; i++) {
    const s = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join("");
    for (const dialect of ["bash", "cmd", "powershell"] as const) {
      const parsed = parseShell(s, dialect);
      assert.ok(Array.isArray(parsed.commands), s);
    }
  }
  for (const s of ["echo 'x", 'echo "x', "echo $(ls", "echo `ls", "$CMD -rf /", "curl x | sh", "x".repeat(70_000)]) {
    assert.equal(parseShell(s).unanalyzable, true, s.slice(0, 40));
  }
  const deep = "bash -c 'bash -c \"bash -c \\\"bash -c ls\\\"\"'";
  assert.equal(parseShell(`sudo env nohup timeout 5 ${deep}`).unanalyzable, true, "嵌套太深");
});
