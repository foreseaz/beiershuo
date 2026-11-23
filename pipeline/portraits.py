"""Free-licensed portraits and Wikipedia links for the people in content/entities.json.

For each person with a `wiki` title, take the article's lead image only when it lives on
Wikimedia Commons under a public-domain or Creative Commons licence, save a small copy under
public/people/ (Wikimedia is not reachable everywhere the site is read), and record the author,
licence and source for the credit line. Results go to content/portraits.json, which the export
merges into the atlas.
"""

import html
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote, urlencode
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from .store import read_json, write_json

AGENT = "BeiershuoAtlas/1.0 (podcast topic map; build-time portrait lookup)"
FREE = re.compile(r"^(public domain|pd\b|cc0|cc[ -]by)", re.I)


def _fetch(url):
    """GET politely: pause between requests and back off when Wikimedia asks us to slow down."""
    for attempt in range(5):
        time.sleep(1.2)
        try:
            with urlopen(Request(url, headers={"User-Agent": AGENT}), timeout=60) as response:
                return response.headers.get_content_type(), response.read()
        except HTTPError as error:
            if error.code != 429 or attempt == 4:
                raise
            time.sleep(int(error.headers.get("Retry-After") or 0) or 10 * (attempt + 1))


def _get_json(url, params):
    return json.loads(_fetch(f"{url}?{urlencode(params)}")[1])


def _plain(value):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", "", value or ""))).strip()


def lookup(title):
    """Return (zh_title or None, commons file name or None) for an English Wikipedia title."""
    data = _get_json("https://en.wikipedia.org/w/api.php", {
        "action": "query", "titles": title, "prop": "pageimages|langlinks", "piprop": "name",
        "lllang": "zh", "redirects": 1, "format": "json", "formatversion": 2,
    })
    page = data["query"]["pages"][0]
    if page.get("missing"):
        return None, None, None
    zh = (page.get("langlinks") or [{}])[0].get("title")
    return page["title"], zh, page.get("pageimage")


def commons_image(name, width):
    """Return thumbnail URL, licence, author and file page for a Commons file, or None."""
    data = _get_json("https://commons.wikimedia.org/w/api.php", {
        "action": "query", "titles": f"File:{name}", "prop": "imageinfo", "iiprop": "url|extmetadata",
        "iiurlwidth": width, "format": "json", "formatversion": 2,
    })
    page = data["query"]["pages"][0]
    # Non-free images live on the local wiki, not on Commons, and are skipped here.
    if page.get("missing") or not page.get("imageinfo"):
        return None
    info = page["imageinfo"][0]
    meta = info.get("extmetadata", {})
    licence = _plain(meta.get("LicenseShortName", {}).get("value"))
    if not FREE.match(licence):
        return None
    return {
        "thumb": info.get("thumburl") or info["url"],
        "licence": licence,
        "author": _plain(meta.get("Artist", {}).get("value")) or "佚名",
        "page": info.get("descriptionurl"),
    }


def run(content_dir, public_dir, refresh=False, width=320):
    entities = read_json(Path(content_dir) / "entities.json")
    target = Path(content_dir) / "portraits.json"
    found = {} if refresh or not target.is_file() else read_json(target)
    folder = Path(public_dir) / "people"
    folder.mkdir(parents=True, exist_ok=True)
    for person in entities["people"]:
        if not person.get("wiki") or (person["id"] in found and not refresh):
            continue
        try:
            title, zh, image = lookup(person["wiki"])
            if title is None:
                print(f"  {person['name']}: no Wikipedia page", file=sys.stderr)
                continue
            entry = {"link": {
                "href": f"https://zh.wikipedia.org/wiki/{quote(zh)}" if zh else f"https://en.wikipedia.org/wiki/{quote(title)}",
                "label": "维基百科",
            }}
            free = commons_image(image, width) if image else None
            if free:
                suffix = Path(free["thumb"].split("?")[0]).suffix.lower() or ".jpg"
                path = folder / f"{person['id']}{suffix}"
                kind, body = _fetch(free["thumb"])
                if not kind.startswith("image/"):
                    raise ValueError("Commons returned a non-image response")
                path.write_bytes(body)
                entry["image"] = {
                    "src": f"/people/{path.name}",
                    "credit": f"{free['author']} · {free['licence']}",
                    "source": free["page"],
                }
            found[person["id"]] = entry
            print(f"  {person['name']}: {'photo' if free else 'no free photo'} · {entry['link']['href'][:48]}")
        except (OSError, ValueError, KeyError) as error:
            print(f"  {person['name']}: {error}", file=sys.stderr)
    write_json(target, found)
    print(f"Wrote {target} · {sum('image' in item for item in found.values())} photos for {len(found)} people")
    return 0
