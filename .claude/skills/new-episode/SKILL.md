---
name: new-episode
description: Curate a newly published 《次要人生》 episode into the star map — add the people, books, concepts (sub-topic stars), aliases and search words it brings, then check and publish. Use when the user says 整理 EP52, 整理新节目, or points at an「EPxx 待整理」issue.
---

# 整理新单集

新单集本身已经由 GitHub Actions 自动上线了：标题、章节、播放，以及靠现有别名连上的人物、书和概念。这个 skill 补上需要判断的那一半，也就是新出现的名字和概念，让它们也出现在星图、搜索和条目页里。

只改 `content/` 下手工维护的文件（人物照片还会写到 `public/people/`）。`public/data/v1/atlas.json` 和字体是生成文件，不提交。

## 1. 看清这一集

```bash
npm run data                       # 同步 Apple 目录，导出到本地 atlas
.venv/bin/python -m pipeline check --notes-dir var/notes
cat var/notes/EP52.md              # 已经连上的条目、书目里没匹配上的名字、全部章节
```

- 如果本地 atlas 已经包含这一集，check 就不会把它当成新单集，也不会写笔记。这时直接读仓库里的「EP52 待整理」issue，内容一样：`gh issue list --search "待整理 in:title"`。
- 本地数据库只存解析后的书目，不存简介全文。全文从 Apple 取：

  ```bash
  .venv/bin/python -c "import json, sys; from urllib.request import urlopen; from pipeline.catalog import APPLE_LOOKUP; rows = json.load(urlopen(APPLE_LOOKUP))['results']; print(next(r['description'] for r in rows if r.get('trackName', '').startswith(sys.argv[1] + '.')))" EP52
  ```

- 书目解析会在《》前切开，所以作者名常常被切成单独一行。例如 EP52 的「约翰」，原文是「约翰《迂回》」，指约翰·凯（John Kay）的 *Obliquity*。先回到简介里弄清楚碎片指的是什么，碎片本身不要当成条目加。

## 2. 决定改什么

先读 `content/entities.json` 和 `content/topics.json`，照着已有条目的格式和语气写。优先级从高到低：

1. **补别名。** 如果一个名字只是现有条目的另一种写法（「霍尼」对应 `horney`「霍妮」，英文原名，全名或简称），就加进那个条目的 `aliases`，不要新建条目。
2. **新书和新影片。**
   - `id` 用英文原名或拼音写成 kebab-case。
   - `name` 不带书名号。
   - `aliases` 至少包括中文名，有原名就加上原名。
   - `author`（书）或 `people`（影片）填人物 id，人物不存在就一起新建。
   - `note` 写一句话，客观、具体，40 字以内，不要宣传腔。
3. **新人物。**
   - `name` 用最常见的中文译名，中间用间隔号「·」。
   - `aliases` 收齐常见的不同译法和英文名。
   - `note` 写一句话：他是谁，和节目谈的内容有什么关系。
   - `wiki` 填英文维基百科的条目名。
   - 加完运行 `.venv/bin/python -m pipeline portraits`，抓取可自由使用的照片。
4. **新概念**，也就是一颗新的小主题星。门槛要高：
   - 必须是这一集围绕展开的、有名字的想法：至少一个章节标题或官方主题直接点了它的名。
   - 不能只是现有概念的近义词；是近义词的话就去补别名。
   - `topic` 是它所属的星云，只能是 `topics.json` 里那 7 个 id 之一，选最贴近这个概念被谈论方式的那个。
   - `people` 填相关人物，`note` 写一句白话定义。
   - 别名要足够具体，不能误配到无关的标题。
5. **搜索词**（`content/keywords.json`）。收听众会去搜的日常说法（例如「松弛」「着急」），而且要在标题或章节里真的出现过，否则导出时会被丢掉。
6. **背景音乐。** 问用户这一集是否自带背景音乐。如果有，在 `content/episodes.json` 里给它加 `"musicBed": true`。光看元数据判断不了，不要猜。

## 3. 检查

```bash
npm run data
```

- 导出不能报错。
- 用 `find_mentions` 看每个新别名配上了哪些单集和章节，确认没有误配。
- 打开开发服务器（`.claude/launch.json` 里的 `dev`），在浏览器里检查：
  - `/?episode=<id>` 能打开这一集；
  - 新概念出现在对应的星云里；
  - 搜索能搜到新搜索词；
  - 新人物和新书的条目页里有这一集。

## 4. 发布

- 把改动摘要给用户过目：新增和修改了哪些条目，各自连上了哪些单集。
- 用户同意后：
  1. 只提交 `content/`（以及 `public/people/` 里的新照片），提交信息照仓库的写法；
  2. 运行 `git push origin HEAD:main`，CI 会重新导出并部署；
  3. 部署通过后，用 `gh issue close <编号> --comment "<摘要>"` 关掉 issue。
- 作为定时任务运行、没有人可以问的时候：
  - 推到新分支 `curate/ep52` 并开 PR，正文写摘要，把是否有背景音乐列为待确认；
  - 不要直接推 main。
