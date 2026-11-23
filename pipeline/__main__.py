"""Prepare locally reviewed podcast data for the public star map."""

import argparse
import contextlib
import hashlib
import os
import shutil
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .catalog import fetch_catalog
from .store import Store, read_json


ROOT = Path(__file__).resolve().parents[1]


def parser():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--db", type=Path, default=os.environ.get("BEIERSHUO_DB"))
    cli.add_argument("--work-dir", type=Path, default=os.environ.get("BEIERSHUO_WORK_DIR", ROOT / "var"))
    cli.add_argument("--content-dir", type=Path, default=ROOT / "content")
    commands = cli.add_subparsers(dest="command", required=True)
    sync = commands.add_parser("sync", help="Refresh the first-party Apple catalog")
    sync.add_argument("--from-file", type=Path, help="Read a saved Apple Lookup response")
    commands.add_parser("status", help="Show processing and review state")

    transcribe = commands.add_parser("transcribe", help="Run 留声 against an episode")
    transcribe.add_argument("episodes", nargs="*")
    transcribe.add_argument("--source", type=Path, help="Use local audio for a single episode")
    transcribe.add_argument("--redo", action="store_true")
    transcribe.add_argument("--recall-root", type=Path)
    transcribe.add_argument("--profile", type=Path)

    enroll = commands.add_parser("enroll", help="Create the local 贝儿 speaker profile")
    enroll.add_argument("samples", nargs="+", metavar="FILE@START:END")
    enroll.add_argument("--sample", dest="extra_samples", action="append", default=[])
    enroll.add_argument("--recall-root", type=Path)
    enroll.add_argument("--profile", type=Path)

    propose = commands.add_parser("propose", help="Ask Claude to propose topics and links for review")
    propose.add_argument("episodes", nargs="*", help="Episode numbers (EP45) or GUIDs; default is all")
    propose.add_argument("--catalog", action="store_true", help="Work from show notes and chapter titles")
    propose.add_argument("--from-file", type=Path, help="Import proposals written in a Claude Code session instead of calling the API")
    propose.add_argument("--redo", action="store_true", help="Ask again even if a proposal exists")
    propose.add_argument("--paths-only", action="store_true", help="Only propose cross-episode chapter links")
    propose.add_argument("--no-paths", action="store_true", help="Skip cross-episode chapter links")
    propose.add_argument("--workers", type=int, default=4)

    review = commands.add_parser("review", help="Open the local review page")
    review.add_argument("action", choices=["serve"])
    review.add_argument("--port", type=int, default=8787)

    for name in ("summarize", "relate"):
        commands.add_parser(name, help="Transcript stage (M2)").add_argument("episodes", nargs="*")

    portraits = commands.add_parser("portraits", help="Fetch free-licensed portraits and Wikipedia links for people")
    portraits.add_argument("--refresh", action="store_true")

    export = commands.add_parser("export", help="Atomically write a public-only atlas snapshot")
    export.add_argument("--output", type=Path, default=ROOT / "public/data/v1/atlas.json")
    export.add_argument("--fonts-dir", type=Path, default=ROOT / "public/fonts")
    export.add_argument("--serif-font", type=Path, help="Source Han Serif / Noto Serif SC file to subset")
    export.add_argument("--no-fonts", action="store_true")
    return cli


def load_env(path):
    """Read KEY=VALUE lines from .env without overriding the real environment."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip().removeprefix("export ").strip()
        os.environ.setdefault(key, value.strip().strip('"').strip("'"))


def time_value(value):
    fields = value.split(":")
    if len(fields) > 3:
        raise ValueError(f"Invalid timestamp {value!r}")
    return sum(float(field) * 60**index for index, field in enumerate(reversed(fields)))


def sample_value(value):
    path, marker, times = value.rpartition("@")
    if not marker:
        raise ValueError(f"Use FILE@START:END for speaker sample {value!r}")
    separator = "-" if "-" in times else ":"
    start, end = times.split(separator, maxsplit=1)
    return Path(path).expanduser().resolve(), time_value(start), time_value(end)


def download_audio(url, folder):
    key = hashlib.sha256(url.encode()).hexdigest()[:24]
    suffix = Path(urlparse(url).path).suffix.lower()
    target = folder / f"source-{key}{suffix or '.m4a'}"
    if target.is_file() and target.stat().st_size:
        return target
    folder.mkdir(parents=True, exist_ok=True)
    request = Request(url, headers={"User-Agent": "Beiershuo-editor/1.0"})
    with urlopen(request, timeout=60) as response, tempfile.NamedTemporaryFile(dir=folder, delete=False) as output:
        path = Path(output.name)
        try:
            content_type = response.headers.get_content_type()
            if not (content_type.startswith(("audio/", "video/")) or content_type == "application/octet-stream"):
                raise ValueError(f"Unexpected media response {content_type}")
            shutil.copyfileobj(response, output)
            output.flush()
            declared_size = response.headers.get("Content-Length")
            if path.stat().st_size == 0 or (declared_size and path.stat().st_size != int(declared_size)):
                raise ValueError("The podcast audio download is incomplete")
            os.replace(path, target)
        finally:
            path.unlink(missing_ok=True)
    return target


def transcribe_command(store, args):
    from .liusheng import transcribe

    episodes = store.selected_episodes(args.episodes)
    if args.source and len(episodes) != 1:
        raise ValueError("--source requires a single episode")
    profile = args.profile or args.work_dir / "speaker-profile.json"
    if args.profile and not profile.is_file():
        raise ValueError(f"Missing speaker profile {profile}")
    failures = 0
    for episode in episodes:
        identifier = episode["id"]
        folder = args.work_dir / "transcribe" / identifier
        old = store.transcript(identifier)
        if old and not args.redo and not args.source and old["data"].get("sourceUrl") == episode["audioUrl"]:
            print(f"{episode['title']}: transcript already stored")
            continue
        store.job("transcribe", identifier, "running")
        try:
            if args.source:
                source = args.source.expanduser().resolve(strict=True)
            elif episode["audioUrl"]:
                source = download_audio(episode["audioUrl"], folder)
            else:
                raise ValueError("No public audio URL. Supply --source for this episode.")
            result = transcribe(
                source=source,
                work_dir=folder / "asr",
                profile_path=profile if profile.is_file() else None,
                recall_root=args.recall_root,
            )
            result["sourceUrl"] = None if args.source else episode["audioUrl"]
            store.save_transcript(identifier, result)
            store.job("transcribe", identifier, "complete")
            print(f"{episode['title']}: {len(result['segments'])} transcript chunks", flush=True)
        except Exception as error:
            failures += 1
            store.job("transcribe", identifier, "error", str(error))
            print(f"{episode['title']}: {error}", file=sys.stderr, flush=True)
    return bool(failures)


def status_command(store):
    episodes = store.episodes()
    transcripts = dict(store.transcripts())
    print(f"{len(episodes)} episodes · {len(transcripts)} transcripts")
    for kind in ("episode", "path"):
        counts = {}
        for entry in store.proposals(kind).values():
            counts[entry["status"]] = counts.get(entry["status"], 0) + 1
        label = "episode topics" if kind == "episode" else "chapter links"
        print(f"{label}: " + (", ".join(f"{count} {state}" for state, count in sorted(counts.items())) or "none"))
    for row in store.db.execute("SELECT kind, state, COUNT(*) AS n FROM jobs GROUP BY kind, state ORDER BY kind"):
        print(f"{row['kind']} jobs: {row['n']} {row['state']}")
    return 0


def main(argv=None):
    load_env(ROOT / ".env")
    cli = parser()
    args = cli.parse_args(argv)
    try:
        with contextlib.closing(Store(args.db or args.work_dir / "content.sqlite3")) as store:
            if args.command == "sync":
                if args.from_file:
                    from .catalog import normalize_catalog

                    episodes = normalize_catalog(read_json(args.from_file))
                else:
                    episodes = fetch_catalog()
                store.save_catalog(episodes)
                print(f"Synced {len(episodes)} episodes with {sum(len(row['chapters']) for row in episodes)} chapters")
            elif args.command == "transcribe":
                return int(transcribe_command(store, args))
            elif args.command == "enroll":
                from .liusheng import enroll

                profile = args.profile or args.work_dir / "speaker-profile.json"
                enroll([sample_value(sample) for sample in [*args.samples, *args.extra_samples]], profile, recall_root=args.recall_root)
                print(f"Speaker profile ready at {profile}")
            elif args.command == "portraits":
                from .portraits import run as fetch_portraits

                return fetch_portraits(args.content_dir, ROOT / "public", refresh=args.refresh)
            elif args.command == "status":
                return status_command(store)
            else:
                from .editorial import run

                return run(store, args)
    except (OSError, ValueError, RuntimeError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
