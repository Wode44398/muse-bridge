# 说明书问答测试（给维护者）

Muse 回答用户的使用问题，靠的是安装包里的 `deploy/muse/MUSE.md` 和 `deploy/muse/guide/`。这里是一套典型用户问题
（`questions.json`）和一个跑分脚本，用来在发版前确认：只看这两份文档，模型能不能答对。

```bash
node deploy/muse/test/guide-qa/run.mjs                 # 默认用 sonnet 跑全部题目
node deploy/muse/test/guide-qa/run.mjs --model haiku   # 更严：小模型也答得上来，Muse 才稳
node deploy/muse/test/guide-qa/run.mjs --only q01,q07  # 只跑几道
```

- 用本机的 Claude Code 命令行（`claude -p`），走你登录 Claude Code 的账号，不需要 API key。只调三次模型
  （路由、回答、判分，每次都是全部题目一起），一次全量大约几分钟。
- 报告默认写到系统临时目录的 `muse-guide-qa-report.md`（`--out` 可改），列出答错的题、漏掉的要点、踩到的禁区和原回答。
- 回答通过率或「路由」正确率低于 `--threshold`（默认 0.85）时退出码为 1。路由 = 只给 `INDEX.md`，看模型会不会翻到对的章节。

## 题目格式（questions.json）

```json
{ "id": "q01", "q": "用户的原话（中英文都可以）",
  "chapters": ["02-claude-code.md"],
  "facts": ["必须讲到的要点（意思到了就算）"],
  "extra": ["加分要点：讲到更好，没讲到不判错"],
  "forbid": ["不能出现的说法（说了就判错）"] }
```

- `chapters`：答这题应该翻的章节（`guide/` 里的文件名，或 `MUSE.md`），给路由打分用。
- `facts` 只放答这个问题少了就不对的东西；顺带一提更好的（限制、细节、另一种做法）放 `extra`。这套题考的是说明书
  写得对不对、全不全，不考回答长短——把边角细节都塞进 `facts`，分数就只反映模型这次答得啰不啰嗦。
- 改了界面、改了说明书，顺手加一两道题；用户真问过、Muse 答错过的问题，最值得加进来。
- 题目里的「禁区」专门防 Muse 踩坑：在 VM 上跑 `claude login`、编造不存在的按钮、承诺做不到的事。

静态检查（不调模型）在 `deploy/muse/test/guide.test.mjs`：界面名字有没有编、子命令和 key 名有没有漏写、
章节链接是否有效、有没有个人信息。`release.yml` 发版前会跑它。
