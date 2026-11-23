"""Editorial steps: catalog topic proposals, local review and the public atlas export.

Stage M1 works from the show notes only (episode titles, official topics and
chapter titles). Transcript-level moments, summaries and relations come next.
"""

import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from .catalog import SHOW
from .store import read_json, revision, write_json


ROOT = Path(__file__).resolve().parents[1]
REVIEW_PAGE = Path(__file__).with_name("review.html")
PATH_KINDS = ("related", "perspective", "continues")
TOPIC_ID = re.compile(r"^[a-z][a-z0-9-]*$")
CHAPTER_REF = re.compile(r"^(EP\d+|S\d+)@(\d+)$")
SERIF_SOURCES = (
    Path.home() / "Library/Fonts/SourceHanSerif-VF.otf.ttc",
    Path("/Library/Fonts/SourceHanSerif-VF.otf.ttc"),
)
SERIF_WEIGHTS = (400, 600)


# ---------------------------------------------------------------- shared data

def load_topics(content_dir):
    topics = read_json(Path(content_dir) / "topics.json")
    seen = set()
    for topic in topics:
        if not TOPIC_ID.fullmatch(topic.get("id", "")) or topic["id"] in seen:
            raise ValueError(f"Invalid or duplicate topic id {topic.get('id')!r} in topics.json")
        if not topic.get("title") or not re.fullmatch(r"#[0-9a-fA-F]{6}", topic.get("color", "")):
            raise ValueError(f"Topic {topic['id']} needs a title and a #rrggbb color")
        if len(topic.get("position", [])) != 3:
            raise ValueError(f"Topic {topic['id']} needs a 3D position")
        seen.add(topic["id"])
    return topics


def episode_refs(episodes):
    """Short, human-readable references for prompts and the review page."""
    counts = Counter(episode.get("number") for episode in episodes)
    refs, extra = {}, 0
    for episode in episodes:
        number = episode.get("number")
        if number is not None and counts[number] == 1:
            refs[episode["id"]] = f"EP{number}"
        else:
            extra += 1
            refs[episode["id"]] = f"S{extra}"
    return refs


def chapter_topics(entry):
    """Chapter topic ids from a reviewed decision, falling back to the proposal."""
    if entry is None:
        return {}
    source = entry["decision"] if entry["status"] == "approved" and entry["decision"] else entry["proposal"]
    return {chapter["startSec"]: chapter["topicIds"] for chapter in source["chapters"]}


def published_decision(entry):
    """The last approved decision, kept while a newer proposal waits for review."""
    return entry["published"] if entry else None


def _dedupe(values, allowed, limit):
    result = []
    for value in values:
        if value in allowed and value not in result:
            result.append(value)
    return result[:limit]


# ---------------------------------------------------------------- prompts

def _topic_table(topics):
    return "\n".join(
        f"- {topic['id']}｜{topic['title']}：{topic['description']}（常见说法：{'、'.join(topic['aliases'])}）"
        for topic in topics
    )


def _catalog_system(topics):
    return (
        "你在为倪贝儿主持的心理播客《次要人生｜Flip Your Mind》整理主题索引。网站把节目内容画成一张星图，"
        "下面七颗星是已经确认的主题，只能使用这些 id：\n\n"
        f"{_topic_table(topics)}\n\n"
        "你只看得到节目目录：单集标题、官方主题和章节标题。只根据这些文字判断，不要补充或猜测没写出来的内容。"
    )


def _episode_prompt(episode, ref):
    chapters = "\n".join(f"{chapter['startSec']}｜{chapter['title']}" for chapter in episode["chapters"]) or "（这一集没有章节）"
    return (
        "请判断这一集和它的每个章节属于哪些主题。\n\n"
        "- episodeTopics：1–3 个，最主要的放第一个。reason 用一句中文（40 字以内）说明是哪些章节体现了这个主题。\n"
        "- chapters：每个章节都要出现一次，用给出的 startSec 对应。topicIds 给 0–2 个；开场寒暄、片尾、推荐书单、"
        "栏目介绍这类没有主题内容的章节给空列表。\n"
        "- unfit：这一集如果有明显的主题哪颗星都放不进去，给一个 2–6 字的主题名和一句理由；都放得进去就返回空列表。\n\n"
        f"单集：{ref}《{episode['title']}》\n"
        f"官方主题：{episode.get('officialTopic') or '（未写明）'}\n"
        f"章节（startSec｜标题）：\n{chapters}"
    )


def _episode_schema(topic_ids):
    topic = {"type": "string", "enum": topic_ids}

    def strict(properties):
        return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}

    return strict({
        "episodeTopics": {"type": "array", "items": strict({"topicId": topic, "reason": {"type": "string"}})},
        "chapters": {"type": "array", "items": strict({
            "startSec": {"type": "integer"}, "topicIds": {"type": "array", "items": topic},
        })},
        "unfit": {"type": "array", "items": strict({"label": {"type": "string"}, "reason": {"type": "string"}})},
    })


def _paths_prompt(episodes, refs, entries):
    blocks = []
    for episode in episodes:
        if not episode["chapters"]:
            continue
        topics = chapter_topics(entries.get(episode["id"]))
        lines = [f"## {refs[episode['id']]}《{episode['title']}》（官方主题：{episode.get('officialTopic') or '未写明'}）"]
        for chapter in episode["chapters"]:
            tags = ",".join(topics.get(chapter["startSec"], [])) or "-"
            lines.append(f"{refs[episode['id']]}@{chapter['startSec']}｜{chapter['title']}｜{tags}")
        blocks.append("\n".join(lines))
    return (
        "下面是整档节目的章节目录，每行是「章节编号｜标题｜所属主题」。请找出最值得「听完这一段，接着去听那一段」的跨集连线，最多 30 条。\n\n"
        "- from 和 to 必须是不同单集里的章节编号，原样照抄。\n"
        "- kind：related（相似处境）、perspective（同一个问题的另一种看法）、continues（后一段把前一段往下推了一步）。\n"
        "- 优先连接两个不同主题的章节，这些连线会在星图上把两颗星连起来；同一主题内特别好的连线也可以。\n"
        "- reason 用一句中文（60 字以内），具体说出两段各自在讲什么、为什么值得连着听。只依据标题，不要编造标题里没有的内容。\n"
        "- 宁缺毋滥，没有把握的不要列。\n\n"
        + "\n\n".join(blocks)
    )


def _paths_schema():
    item = {
        "type": "object",
        "properties": {
            "from": {"type": "string"}, "to": {"type": "string"},
            "kind": {"type": "string", "enum": list(PATH_KINDS)}, "reason": {"type": "string"},
        },
        "required": ["from", "to", "kind", "reason"],
        "additionalProperties": False,
    }
    return {"type": "object", "properties": {"paths": {"type": "array", "items": item}},
            "required": ["paths"], "additionalProperties": False}


# ---------------------------------------------------------------- propose

def _normalize_episode(episode, raw, topic_ids, meta):
    episode_topics, seen = [], set()
    for item in raw["episodeTopics"]:
        if item["topicId"] in topic_ids and item["topicId"] not in seen:
            seen.add(item["topicId"])
            episode_topics.append({"topicId": item["topicId"], "reason": item["reason"].strip()})
    if not episode_topics:
        raise ValueError("Claude returned no valid episode topic")
    by_start = {}
    for item in raw["chapters"]:
        by_start.setdefault(item["startSec"], _dedupe(item["topicIds"], topic_ids, 2))
    chapters = [{"startSec": chapter["startSec"], "topicIds": by_start.get(chapter["startSec"], [])}
                for chapter in episode["chapters"]]
    return {
        "episodeTopics": episode_topics[:3],
        "chapters": chapters,
        "unfit": [{"label": item["label"].strip(), "reason": item["reason"].strip()} for item in raw["unfit"]],
        "unmatchedChapters": sum(1 for chapter in episode["chapters"] if chapter["startSec"] not in by_start),
        "model": meta,
    }


def import_catalog(store, args):
    """Load proposals written outside the pipeline (e.g. in a Claude Code session).

    File shape:
      {"source": "...", "episodes": {"EP51": {"topics": [["boundaries", "reason"], ...],
                                              "chapters": {"140": ["boundaries"], ...},
                                              "unfit": [["label", "reason"]]}},
       "paths": [{"from": "EP51@2754", "to": "EP45@2941", "kind": "perspective", "reason": "..."}]}
    Chapters left out of "chapters" belong to no topic.
    """
    topics = load_topics(args.content_dir)
    topic_ids = {topic["id"] for topic in topics}
    all_episodes = store.episodes()
    refs = episode_refs(all_episodes)
    by_ref = {refs[episode["id"]]: episode for episode in all_episodes}
    data = read_json(args.from_file)
    meta = {"source": data.get("source", str(args.from_file)), "basis": data.get("basis")}
    existing = store.proposals("episode")
    problems, saved = [], 0
    for ref, entry in data.get("episodes", {}).items():
        episode = by_ref.get(ref)
        if episode is None:
            problems.append(f"{ref}: unknown episode")
            continue
        starts = {chapter["startSec"] for chapter in episode["chapters"]}
        unknown = [key for key in entry.get("chapters", {}) if int(key) not in starts]
        bad = [topic for topic, _ in entry["topics"] if topic not in topic_ids] + \
              [topic for ids in entry.get("chapters", {}).values() for topic in ids if topic not in topic_ids]
        if unknown or bad:
            problems.append(f"{ref}: unknown chapters {unknown} or topics {sorted(set(bad))}")
            continue
        if episode["id"] in existing and not args.redo:
            continue
        raw = {
            "episodeTopics": [{"topicId": topic, "reason": reason} for topic, reason in entry["topics"]],
            "chapters": [{"startSec": start, "topicIds": entry.get("chapters", {}).get(str(start), [])} for start in sorted(starts)],
            "unfit": [{"label": label, "reason": reason} for label, reason in entry.get("unfit", [])],
        }
        store.save_proposal("episode", episode["id"], _normalize_episode(episode, raw, topic_ids, meta))
        saved += 1
    print(f"Imported {saved} episode proposal(s) from {args.from_file}")
    if "paths" in data and not args.no_paths:
        _save_paths(store, all_episodes, refs, data["paths"], meta)
    for problem in problems:
        print(f"  {problem}", file=sys.stderr)
    report = write_coverage_report(store, topics, all_episodes, refs, args.work_dir)
    print(f"Coverage report: {report}")
    return len(problems)


def propose_catalog(store, args):
    from .llm import ModelError, structured

    topics = load_topics(args.content_dir)
    topic_ids = [topic["id"] for topic in topics]
    all_episodes = store.episodes()
    if not all_episodes:
        raise ValueError("No episodes stored yet. Run `sync` first.")
    refs = episode_refs(all_episodes)
    episodes = store.selected_episodes(args.episodes)
    existing = store.proposals("episode")
    todo = [episode for episode in episodes if args.redo or episode["id"] not in existing]
    system = _catalog_system(topics)
    schema = _episode_schema(topic_ids)
    failures = 0

    if not args.paths_only and todo:
        print(f"Proposing topics for {len(todo)} episode(s) with up to {args.workers} parallel requests…", flush=True)
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            jobs = {pool.submit(structured, system, _episode_prompt(episode, refs[episode["id"]]), schema,
                                max_tokens=16000): episode for episode in todo}
            for job in as_completed(jobs):
                episode = jobs[job]
                try:
                    raw, meta = job.result()
                    proposal = _normalize_episode(episode, raw, set(topic_ids), meta)
                    store.save_proposal("episode", episode["id"], proposal)
                    tags = "、".join(item["topicId"] for item in proposal["episodeTopics"])
                    print(f"  {refs[episode['id']]}: {tags}", flush=True)
                except (ModelError, ValueError, KeyError) as error:
                    failures += 1
                    print(f"  {refs[episode['id']]}: {error}", file=sys.stderr, flush=True)
    elif not args.paths_only:
        print("All selected episodes already have proposals. Use --redo to ask again.")

    if not args.no_paths and not args.episodes:
        failures += _propose_paths(store, all_episodes, refs, system)

    report = write_coverage_report(store, topics, all_episodes, refs, args.work_dir)
    print(f"Coverage report: {report}")
    return failures


def _propose_paths(store, episodes, refs, system):
    from .llm import ModelError, structured

    entries = store.proposals("episode")
    if not entries:
        print("Skipping cross-episode links: propose episode topics first.")
        return 0
    print("Proposing cross-episode chapter links…", flush=True)
    try:
        raw, meta = structured(system, _paths_prompt(episodes, refs, entries), _paths_schema(),
                               effort="high", max_tokens=32000)
    except ModelError as error:
        print(f"  links: {error}", file=sys.stderr)
        return 1
    _save_paths(store, episodes, refs, raw["paths"], meta)
    return 0


def _save_paths(store, episodes, refs, items, meta):
    lookup = {refs[episode["id"]]: episode for episode in episodes}
    chapters = {(episode["id"], chapter["startSec"]) for episode in episodes for chapter in episode["chapters"]}
    saved = 0
    for item in items:
        if item["kind"] not in PATH_KINDS:
            print(f"  skipped link with unknown kind {item['kind']!r}", file=sys.stderr)
            continue
        ends = []
        for value in (item["from"], item["to"]):
            match = CHAPTER_REF.fullmatch(value.strip())
            episode = lookup.get(match.group(1)) if match else None
            point = (episode["id"], int(match.group(2))) if episode else None
            ends.append(point if point in chapters else None)
        if None in ends or ends[0][0] == ends[1][0]:
            print(f"  skipped invalid link {item['from']} → {item['to']}", file=sys.stderr)
            continue
        (source_id, source_start), (target_id, target_start) = ends
        key = hashlib.sha256(f"{source_id}:{source_start}>{target_id}:{target_start}".encode()).hexdigest()[:16]
        store.save_proposal("path", key, {
            "sourceEpisodeId": source_id, "sourceStartSec": source_start,
            "targetEpisodeId": target_id, "targetStartSec": target_start,
            "kind": item["kind"], "reason": item["reason"].strip(), "model": meta,
        })
        saved += 1
    print(f"  {saved} link proposal(s) saved for review")


def write_coverage_report(store, topics, episodes, refs, work_dir):
    entries = store.proposals("episode")
    episode_count, chapter_count, unfit = Counter(), Counter(), defaultdict(list)
    for episode in episodes:
        entry = entries.get(episode["id"])
        if not entry:
            continue
        source = entry["decision"] if entry["status"] == "approved" and entry["decision"] else entry["proposal"]
        for topic in source["episodeTopics"]:
            episode_count[topic["topicId"] if isinstance(topic, dict) else topic] += 1
        for chapter in source["chapters"]:
            for topic_id in chapter["topicIds"]:
                chapter_count[topic_id] += 1
        for item in entry["proposal"].get("unfit", []):
            unfit[item["label"]].append(f"{refs[episode['id']]}：{item['reason']}")
    lines = ["# 目录主题覆盖", "", f"已提议 {len(entries)} / {len(episodes)} 集。", "",
             "| 主题 | 单集 | 章节 |", "| --- | ---: | ---: |"]
    for topic in topics:
        lines.append(f"| {topic['title']} | {episode_count[topic['id']]} | {chapter_count[topic['id']]} |")
    lines += ["", "## 七颗星放不进去的主题", ""]
    if unfit:
        for label, items in sorted(unfit.items(), key=lambda pair: -len(pair[1])):
            lines.append(f"- **{label}**（{len(items)} 集）")
            lines += [f"  - {item}" for item in items]
    else:
        lines.append("- 没有")
    path = Path(work_dir) / "reports" / "catalog-coverage.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    for topic in topics:
        print(f"  {topic['title']}: {episode_count[topic['id']]} 集 · {chapter_count[topic['id']]} 章节")
    if unfit:
        print(f"  放不进七颗星的主题: {'、'.join(sorted(unfit, key=lambda label: -len(unfit[label])))}")
    return path


# ---------------------------------------------------------------- review page

def _review_state(store, topics):
    episodes = store.episodes()
    refs = episode_refs(episodes)
    return {
        "topics": [{key: topic[key] for key in ("id", "title", "color", "description")} for topic in topics],
        "episodes": [{
            "id": episode["id"], "ref": refs[episode["id"]], "title": episode["title"],
            "officialTopic": episode.get("officialTopic"), "audioUrl": episode.get("audioUrl"),
            "xiaoyuzhouUrl": episode["xiaoyuzhouUrl"], "chapters": episode["chapters"],
        } for episode in episodes],
        "episodeProposals": store.proposals("episode"),
        "pathProposals": store.proposals("path"),
    }


def _validate_decision(store, topic_ids, body):
    kind, key, status = body["kind"], body["key"], body["status"]
    if status == "proposed":
        return None
    if kind == "episode":
        decision = body["decision"]
        episode = next((item for item in store.episodes() if item["id"] == key), None)
        if episode is None:
            raise ValueError("Unknown episode")
        episode_topics = _dedupe(decision["episodeTopics"], topic_ids, 3)
        if status == "approved" and not episode_topics:
            raise ValueError("Choose at least one topic before approving")
        starts = {chapter["startSec"] for chapter in episode["chapters"]}
        chapters = [{"startSec": int(item["startSec"]), "topicIds": _dedupe(item["topicIds"], topic_ids, 3)}
                    for item in decision["chapters"] if int(item["startSec"]) in starts]
        return {"episodeTopics": episode_topics, "chapters": chapters}
    if kind == "path":
        decision = body["decision"]
        reason = str(decision["reason"]).strip()
        if decision["kind"] not in PATH_KINDS or not 0 < len(reason) <= 200:
            raise ValueError("A link needs a kind and a reason of at most 200 characters")
        return {"kind": decision["kind"], "reason": reason}
    raise ValueError(f"Unknown proposal kind {kind!r}")


def serve_review(store, args):
    topics = load_topics(args.content_dir)
    topic_ids = {topic["id"] for topic in topics}
    page = REVIEW_PAGE.read_bytes()
    origins = {f"http://127.0.0.1:{args.port}", f"http://localhost:{args.port}"}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def _send(self, code, body, content_type="application/json; charset=utf-8"):
            data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path in ("/", "/index.html"):
                self._send(200, page, "text/html; charset=utf-8")
            elif self.path == "/api/state":
                self._send(200, _review_state(store, topics))
            else:
                self._send(404, {"error": "Not found"})

        def do_POST(self):
            origin = self.headers.get("Origin")
            if self.path != "/api/decide" or (origin and origin not in origins):
                self._send(403, {"error": "Forbidden"})
                return
            if not (self.headers.get("Content-Type") or "").startswith("application/json"):
                self._send(415, {"error": "Send JSON"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if not 0 < length <= 1_000_000:
                self._send(413, {"error": "Request too large"})
                return
            try:
                body = json.loads(self.rfile.read(length))
                decision = _validate_decision(store, topic_ids, body)
                store.decide(body["kind"], body["key"], body["status"], decision)
                self._send(200, {"ok": True})
            except (ValueError, KeyError, TypeError) as error:
                self._send(400, {"error": str(error)})

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Review page: http://127.0.0.1:{args.port}/   (Ctrl-C to stop)", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


# ---------------------------------------------------------------- people, books and concepts

ENTITY_KINDS = (("person", "people"), ("book", "books"), ("concept", "concepts"))


def load_entities(content_dir):
    path = Path(content_dir) / "entities.json"
    if not path.is_file():
        return []
    data = read_json(path)
    entities, seen = [], set()
    for kind, key in ENTITY_KINDS:
        for item in data.get(key, []):
            if not TOPIC_ID.fullmatch(item.get("id", "")) or item["id"] in seen:
                raise ValueError(f"Invalid or duplicate entity id {item.get('id')!r} in entities.json")
            if not item.get("name") or not item.get("aliases"):
                raise ValueError(f"Entity {item['id']} needs a name and at least one alias")
            seen.add(item["id"])
            entities.append({**item, "kind": kind})
    people = {item["id"] for item in entities if item["kind"] == "person"}
    for item in entities:
        linked = [item["author"]] if item.get("author") else item.get("people", [])
        if not set(linked) <= people:
            raise ValueError(f"Entity {item['id']} links to an unknown person: {sorted(set(linked) - people)}")
    return entities


def _fold(text):
    """Match names regardless of middle dots, spacing, punctuation width and case."""
    return re.sub(r"[\s·・•‧\-—_.,'’]", "", unicodedata.normalize("NFKC", text or "")).lower()


def find_mentions(entities, episodes):
    """Find each entity in episode titles, chapter titles and show-note references.

    Longer aliases win where they overlap, so 《笛卡尔的错误》 counts as the book
    rather than as a mention of 笛卡尔 himself.
    """
    aliases = sorted(((_fold(alias), item["id"]) for item in entities for alias in item["aliases"] if _fold(alias)),
                     key=lambda pair: -len(pair[0]))
    found = defaultdict(dict)
    for episode in episodes:
        sources = [("title", None, f"{episode['title']} {episode.get('officialTopic') or ''}")]
        sources += [("chapter", chapter["startSec"], chapter["title"]) for chapter in episode["chapters"]]
        sources += [("notes", None, line) for line in episode.get("references", [])]
        for via, start, text in sources:
            folded = _fold(text)
            taken = [False] * len(folded)
            for alias, entity_id in aliases:
                position = folded.find(alias)
                while position >= 0:
                    span = range(position, position + len(alias))
                    if not any(taken[index] for index in span):
                        for index in span:
                            taken[index] = True
                        found[entity_id].setdefault((episode["id"], start), via)
                    position = folded.find(alias, position + 1)
    mentions = {}
    for entity_id, points in found.items():
        chaptered = {episode_id for (episode_id, start) in points if start is not None}
        # An episode-level mention is redundant once a chapter in that episode names the entity.
        mentions[entity_id] = [{"episodeId": episode_id, "startSec": start, "via": via}
                               for (episode_id, start), via in points.items()
                               if start is not None or episode_id not in chaptered]
    return mentions


# ---------------------------------------------------------------- export

def moment_id(episode_id, title, occurrence):
    # Independent of timestamps: correcting a start point keeps shared links valid.
    return "m-" + hashlib.sha256(f"{episode_id}\0{title}\0{occurrence}".encode()).hexdigest()[:12]


def load_keywords(content_dir, episodes):
    """Curated search words, kept only if the show actually uses them, with how often it does."""
    path = Path(content_dir) / "keywords.json"
    words = read_json(path).get("keywords", []) if path.is_file() else []
    titles = [_fold(episode["title"]) for episode in episodes] + \
             [_fold(chapter["title"]) for episode in episodes for chapter in episode["chapters"]]
    counted = [{"text": word, "count": sum(_fold(word) in title for title in titles)} for word in dict.fromkeys(words)]
    return [item for item in counted if item["count"]]


def load_episode_overrides(content_dir):
    path = Path(content_dir) / "episodes.json"
    data = read_json(path) if path.is_file() else {}
    return {ref: fields for ref, fields in data.items() if not ref.startswith("_")}


def build_atlas(store, topics, entities=(), overrides=None, keywords=()):
    episodes = store.episodes()
    if not episodes:
        raise ValueError("No episodes stored yet. Run `sync` first.")
    refs = episode_refs(episodes)
    overrides = overrides or {}
    unknown = set(overrides) - set(refs.values())
    if unknown:
        raise ValueError(f"content/episodes.json names unknown episodes: {sorted(unknown)}")
    entries = store.proposals("episode")
    public_episodes, moments, chapter_tags, warnings = [], [], {}, []
    for episode in episodes:
        decision = published_decision(entries.get(episode["id"]))
        tags = {chapter["startSec"]: chapter["topicIds"] for chapter in decision["chapters"]} if decision else {}
        public_episodes.append({
            **{key: episode[key] for key in (
                "id", "title", "number", "publishedAt", "durationSec", "playableDurationSec", "audioUrl",
                "appleUrl", "xiaoyuzhouUrl", "officialTopic", "chapters")},
            "topicIds": decision["episodeTopics"] if decision else [],
            **({"musicBed": True} if overrides.get(refs[episode["id"]], {}).get("musicBed") else {}),
        })
        seen = Counter()
        for index, chapter in enumerate(episode["chapters"]):
            seen[chapter["title"]] += 1
            following = episode["chapters"][index + 1]["startSec"] if index + 1 < len(episode["chapters"]) else None
            chapter_tags[(episode["id"], chapter["startSec"])] = tags.get(chapter["startSec"], [])
            moments.append({
                "id": moment_id(episode["id"], chapter["title"], seen[chapter["title"]]),
                "episodeId": episode["id"],
                "topicIds": tags.get(chapter["startSec"], []),
                "kind": "chapter",
                "title": chapter["title"],
                "summary": "",
                "startSec": chapter["startSec"],
                "endSec": following if following is not None else episode["durationSec"],
                "speaker": None,
                "source": "show_notes",
            })

    chapter_paths = []
    for key, entry in sorted(store.proposals("path").items()):
        decision = published_decision(entry)
        if not decision:
            continue
        proposal = entry["proposal"]
        source = chapter_tags.get((proposal["sourceEpisodeId"], proposal["sourceStartSec"]))
        target = chapter_tags.get((proposal["targetEpisodeId"], proposal["targetStartSec"]))
        if not source or not target:
            warnings.append(f"Link {key} waits for both episodes' chapter topics to be approved")
            continue
        chapter_paths.append({
            "id": f"p-{key}",
            "sourceEpisodeId": proposal["sourceEpisodeId"], "sourceStartSec": proposal["sourceStartSec"],
            "targetEpisodeId": proposal["targetEpisodeId"], "targetStartSec": proposal["targetStartSec"],
            "topicIds": [source[0], next((topic for topic in target if topic != source[0]), target[0])],
            "kind": decision["kind"],
            "reason": decision["reason"],
        })

    moment_at = {(moment["episodeId"], moment["startSec"]): moment["id"] for moment in moments}
    episode_topics = {episode["id"]: episode["topicIds"] for episode in public_episodes}
    order = {episode["id"]: index for index, episode in enumerate(episodes)}
    mentions = find_mentions(entities, episodes)
    public_entities = []
    for item in entities:
        points = sorted(mentions.get(item["id"], []), key=lambda point: (order[point["episodeId"]], point["startSec"] or 0))
        # An entity's stars are the published topics of the places that mention it.
        tally = Counter()
        for point in points:
            key = (point["episodeId"], point["startSec"])
            tally.update(chapter_tags.get(key, []) if point["startSec"] is not None else episode_topics[point["episodeId"]])
        public_entities.append({
            "id": item["id"], "kind": item["kind"], "name": item["name"], "note": item.get("note", ""),
            "aliases": item["aliases"],
            **({"author": item["author"]} if item.get("author") else {}),
            **({"people": item["people"]} if item.get("people") else {}),
            "topicIds": [topic for topic, _ in tally.most_common(3)],
            "mentions": [{**point, "momentId": moment_at.get((point["episodeId"], point["startSec"]))} for point in points],
        })

    atlas = {
        "schemaVersion": 1,
        "contentRevision": "",
        "show": SHOW,
        "topics": topics,
        "episodes": public_episodes,
        "moments": moments,
        "relations": [],
        "chapterPaths": chapter_paths,
        "entities": public_entities,
        "keywords": list(keywords),
    }
    validate_atlas(atlas)
    atlas["contentRevision"] = revision({key: value for key, value in atlas.items() if key != "contentRevision"})[:16]
    return atlas, warnings


def validate_atlas(atlas):
    topic_ids = {topic["id"] for topic in atlas["topics"]}
    episode_ids = {episode["id"] for episode in atlas["episodes"]}
    moment_ids = [moment["id"] for moment in atlas["moments"]]
    problems = []
    if len(set(moment_ids)) != len(moment_ids):
        problems.append("duplicate moment ids")
    for episode in atlas["episodes"]:
        if not set(episode["topicIds"]) <= topic_ids:
            problems.append(f"episode {episode['id']} has unknown topics")
        for url in (episode["appleUrl"], episode["xiaoyuzhouUrl"], episode["audioUrl"] or "https://"):
            if not url.startswith("https://"):
                problems.append(f"episode {episode['id']} has a non-https link")
    chapters = set()
    for moment in atlas["moments"]:
        if moment["episodeId"] not in episode_ids:
            problems.append(f"moment {moment['id']} points to a missing episode")
        if not set(moment["topicIds"]) <= topic_ids:
            problems.append(f"moment {moment['id']} has unknown topics")
        chapters.add((moment["episodeId"], moment["startSec"]))
    for path in atlas["chapterPaths"]:
        if (path["sourceEpisodeId"], path["sourceStartSec"]) not in chapters or \
                (path["targetEpisodeId"], path["targetStartSec"]) not in chapters:
            problems.append(f"link {path['id']} points to a missing chapter")
        if not set(path["topicIds"]) <= topic_ids:
            problems.append(f"link {path['id']} has unknown topics")
    known_moments = set(moment_ids)
    people = {item["id"] for item in atlas.get("entities", []) if item["kind"] == "person"}
    for item in atlas.get("entities", []):
        for point in item["mentions"]:
            if point["episodeId"] not in episode_ids or (point["momentId"] and point["momentId"] not in known_moments):
                problems.append(f"entity {item['id']} mentions a missing episode or moment")
        if not set([item["author"]] if "author" in item else item.get("people", [])) <= people:
            problems.append(f"entity {item['id']} links to an unknown person")
    if problems:
        raise ValueError("Atlas validation failed:\n  " + "\n  ".join(problems[:20]))


def export_atlas(store, args):
    topics = load_topics(args.content_dir)
    atlas, warnings = build_atlas(store, topics, load_entities(args.content_dir), load_episode_overrides(args.content_dir),
                                  load_keywords(args.content_dir, store.episodes()))
    write_json(args.output, atlas)
    reviewed = sum(1 for episode in atlas["episodes"] if episode["topicIds"])
    print(f"Wrote {args.output} · revision {atlas['contentRevision']} · {len(atlas['episodes'])} episodes "
          f"({reviewed} reviewed) · {len(atlas['moments'])} chapter moments · {len(atlas['chapterPaths'])} links")
    for warning in warnings:
        print(f"  {warning}", file=sys.stderr)
    if not args.no_fonts:
        source = args.serif_font or next((path for path in SERIF_SOURCES if path.is_file()), None)
        if source is None:
            print("  No Source Han Serif found; the site falls back to system serif fonts. "
                  "Pass --serif-font to build the subset.", file=sys.stderr)
        else:
            build_serif_subset(Path(source), atlas, args.fonts_dir)
    return 0


# ---------------------------------------------------------------- fonts

def _serif_text(atlas):
    pieces = [atlas["show"]["name"], atlas["show"]["host"]]
    pieces += [value for topic in atlas["topics"] for value in (topic["title"], topic["description"])]
    pieces += [value for episode in atlas["episodes"] for value in (episode["title"], episode["officialTopic"] or "")]
    pieces += [moment["title"] for moment in atlas["moments"]]
    pieces += [path["reason"] for path in atlas["chapterPaths"]]
    pieces += [value for item in atlas.get("entities", []) for value in (item["name"], item["note"])]
    pieces += [item["text"] for item in atlas.get("keywords", [])]
    for source in (ROOT / "src").rglob("*.ts*"):
        pieces.append(source.read_text(encoding="utf-8"))
    characters = {character for piece in pieces for character in piece if ord(character) >= 0x2000}
    characters |= {chr(code) for code in range(0x20, 0x7F)}
    return "".join(sorted(characters))


def build_serif_subset(source, atlas, fonts_dir):
    from fontTools import subset
    from fontTools.ttLib import TTCollection, TTFont
    from fontTools.varLib import instancer

    text = _serif_text(atlas)
    index = 0
    if source.suffix.lower() in (".ttc", ".otc") or source.name.endswith(".ttc"):
        collection = TTCollection(str(source), lazy=True)
        names = [font["name"].getDebugName(1) or "" for font in collection.fonts]
        index = next((i for i, name in enumerate(names) if " SC" in f" {name} " or name.endswith(" SC")), None)
        if index is None:
            raise ValueError(f"No Simplified Chinese face in {source}: {names}")
    fonts_dir = Path(fonts_dir)
    fonts_dir.mkdir(parents=True, exist_ok=True)
    notice = None
    for weight in SERIF_WEIGHTS:
        font = TTFont(str(source), fontNumber=index, lazy=False)
        options = subset.Options()
        options.layout_features = ["*"]
        options.name_IDs = [0, 7, 8, 9, 11, 12, 13, 14]
        options.notdef_outline = True
        subsetter = subset.Subsetter(options)
        subsetter.populate(text=text)
        subsetter.subset(font)
        if "fvar" in font:
            font = instancer.instantiateVariableFont(font, {"wght": weight})
        family = "Beier Serif"
        style = "SemiBold" if weight >= 600 else "Regular"
        for record_id, value in ((1, family), (2, style), (4, f"{family} {style}"), (6, f"BeierSerif-{style}")):
            font["name"].setName(value, record_id, 3, 1, 0x409)
        font.flavor = "woff2"
        target = fonts_dir / f"beier-serif-{weight}.woff2"
        font.save(str(target))
        notice = notice or "\n".join(filter(None, (font["name"].getDebugName(i) for i in (0, 13, 14))))
        print(f"  {target} · {target.stat().st_size // 1024} KB · {len(text)} characters")
    (fonts_dir / "NOTICE.txt").write_text(
        "Beier Serif is a subset of Source Han Serif SC, renamed for web embedding.\n"
        "It is distributed under the SIL Open Font License 1.1.\n\n" + (notice or "") + "\n",
        encoding="utf-8",
    )


# ---------------------------------------------------------------- dispatch

def run(store, args):
    if args.command == "propose":
        if not args.catalog:
            raise RuntimeError("Transcript-level proposals arrive with the M2 pilot. Use `propose --catalog` for now.")
        if args.from_file:
            return int(bool(import_catalog(store, args)))
        return int(bool(propose_catalog(store, args)))
    if args.command == "review":
        serve_review(store, args)
        return 0
    if args.command == "export":
        return export_atlas(store, args)
    raise RuntimeError(f"`{args.command}` works on reviewed transcript moments and arrives with the M2 pilot.")
