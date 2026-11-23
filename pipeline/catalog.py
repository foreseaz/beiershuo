"""Fetch and normalize the first-party episode catalog."""

import json
import re
import unicodedata
from urllib.request import Request, urlopen


APPLE_SHOW_ID = "1868979722"
APPLE_LOOKUP = (
    "https://itunes.apple.com/lookup"
    f"?id={APPLE_SHOW_ID}&country=au&entity=podcastEpisode&limit=200"
)
SHOW = {
    "name": "次要人生｜Flip Your Mind",
    "host": "倪贝儿",
    "appleUrl": f"https://podcasts.apple.com/au/podcast/id{APPLE_SHOW_ID}",
    "xiaoyuzhouUrl": "https://www.xiaoyuzhoufm.com/podcast/6847be042278dd073b42f27c",
}
EPISODE_ID = re.compile(r"^[0-9a-f]{24}$")
CHAPTER_HEADING = re.compile(r"你会听到\s*[:：]?")
CHAPTER_END = re.compile(
    r"(?m)^[\s「『🎵🎧👩📖]*"
    r"(?:本期音乐|引用\s*&\s*延伸书目|音乐推荐|下次见|商务合作|小红书|"
    r"想要了解更多|想了解更多|次要人生.*(?:一周年|周年)|咨询师回信栏目|"
    r"本期文案|内耗急救心法|在迷雾里散步|成为我自己\s*」|想加入成长计划)"
)
TIMESTAMP = re.compile(r"(?<![0-9:])(?:(\d{1,2}):)?(\d{1,2}):([0-5]\d)(?![\d:])")
REFERENCE_START = re.compile(r"(延伸阅读|引用书籍|引用\s*&\s*延伸书目|本期提到[^\n:：]*[:：]|延伸影片)")
REFERENCE_END = re.compile(r"(联系方式|本期音乐|想要了解更多|想了解更多|下次见|下周见|小红书|商务合作)")
TAGGED_TOPIC = re.compile(r"本期主题\s*[：:｜|]?\s*[「『《]([^」』》\n]+)")
PLAIN_TOPIC = re.compile(r"(?m)本期主题\s*[：:｜|]\s*([^\n]+)")


def fetch_catalog():
    request = Request(APPLE_LOOKUP, headers={"User-Agent": "Beiershuo-catalog/1.0"})
    with urlopen(request, timeout=30) as response:
        return normalize_catalog(json.load(response))


def parse_chapters(description, duration):
    text = unicodedata.normalize("NFKC", description or "")
    heading = CHAPTER_HEADING.search(text)
    if not heading:
        return []
    block = CHAPTER_END.split(text[heading.end():], maxsplit=1)[0]
    matches = list(TIMESTAMP.finditer(block))
    chapters = {}
    for index, marker in enumerate(matches):
        hours, minutes, seconds = (int(value or 0) for value in marker.groups())
        start = hours * 3600 + minutes * 60 + seconds
        if start >= duration or (hours and minutes >= 60):
            continue
        end = matches[index + 1].start() if index + 1 < len(matches) else len(block)
        body = block[marker.end():end].strip(" \t\n\r|｜:：–—·")
        if body:
            title = body.splitlines()[0].strip()
            chapters.setdefault(start, title)
    return [{"startSec": start, "title": chapters[start]} for start in sorted(chapters)]


def parse_references(description):
    """Books, films and people listed in the show notes' reference section, one item per line."""
    text = unicodedata.normalize("NFKC", description or "")
    start = REFERENCE_START.search(text)
    if not start:
        return []
    block = text[start.start():]
    end = REFERENCE_END.search(block, 1)
    block = block[:end.start()] if end else block
    # Several notes run titles together on one line: split before each new 《title》 as well.
    items = re.split(r"\n+|(?=《)", block)
    return [item.strip(" \t/·-–—:：0123456789.、") for item in items if len(item.strip()) > 1][:40]


def normalize_catalog(payload):
    episodes = {}
    for row in payload.get("results", []):
        if row.get("kind") != "podcast-episode" or str(row.get("collectionId")) != APPLE_SHOW_ID:
            continue
        guid = row.get("episodeGuid", "")
        title = row.get("trackName", "").strip()
        duration = round(float(row.get("trackTimeMillis") or 0) / 1000, 3)
        if not EPISODE_ID.fullmatch(guid) or not title or duration <= 0 or not row.get("releaseDate"):
            raise ValueError(f"Apple returned an incomplete episode record: {guid or title!r}")
        number = re.match(r"EP\s*(\d+)\b", title, re.I)
        description = row.get("description") or ""
        topic = TAGGED_TOPIC.search(description) or PLAIN_TOPIC.search(description)
        audio = row.get("episodeUrl") or ""
        track_id = str(row.get("trackId") or "")
        if not track_id.isdecimal():
            raise ValueError(f"Apple episode {guid} is missing its track ID")
        episode = {
            "id": guid,
            "title": title,
            "number": int(number.group(1)) if number else None,
            "publishedAt": row["releaseDate"],
            "durationSec": duration,
            "playableDurationSec": duration,
            "audioUrl": audio if audio.startswith("https://") else None,
            "appleUrl": f"{SHOW['appleUrl']}?i={track_id}",
            "xiaoyuzhouUrl": f"https://www.xiaoyuzhoufm.com/episode/{guid}",
            "officialTopic": topic.group(1).strip() if topic else None,
            "chapters": parse_chapters(description, duration),
            "references": parse_references(description),
        }
        previous = episodes.setdefault(guid, episode)
        if previous != episode:
            raise ValueError(f"Apple returned conflicting rows for episode {guid}")
    if not episodes:
        raise ValueError("Apple lookup did not return episodes for this show")
    return sorted(episodes.values(), key=lambda episode: (episode["publishedAt"], episode["id"]))
