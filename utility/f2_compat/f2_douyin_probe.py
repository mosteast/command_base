#!/usr/bin/env python3
"""No-download Douyin post/like API probe for gather doctor.

Prints one JSON object on stdout. Never prints cookies, msToken, or a_bogus.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
import sys
from pathlib import Path

logging.getLogger("f2").setLevel(logging.ERROR)
logging.getLogger().setLevel(logging.ERROR)


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def load_cookie(config_path: str) -> str:
    import yaml

    parsed = yaml.safe_load(Path(config_path).read_text(encoding="utf-8")) or {}
    section = parsed.get("douyin") if isinstance(parsed, dict) else {}
    if not isinstance(section, dict):
        return ""
    return str(section.get("cookie") or "").strip()


def resolve_config_path(override: str) -> str:
    if override:
        return override
    import f2
    from f2.utils.utils import get_resource_path

    return str(get_resource_path(f2.APP_CONFIG_FILE_PATH))


def http_status_from_exc(exc: BaseException) -> int:
    status = getattr(exc, "status_code", None)
    if isinstance(status, int) and status > 0:
        return status
    response = getattr(exc, "response", None)
    nested = getattr(response, "status_code", None)
    if isinstance(nested, int) and nested > 0:
        return nested
    match = re.search(r"Status Code:\s*(\d+)", str(exc))
    if match:
        return int(match.group(1))
    match = re.search(r"\b(40[13])\b", str(exc))
    if match:
        return int(match.group(1))
    return 0


def classify_response(payload) -> dict:
    aweme_list = payload.get("aweme_list") if isinstance(payload, dict) else None
    count = len(aweme_list) if isinstance(aweme_list, list) else 0
    if count > 0:
        return {"status": "ok", "count": count}
    return {"status": "empty", "count": 0}


async def fetch_list(crawler, kind: str, sec_user_id: str) -> dict:
    from f2.apps.douyin.model import UserLike, UserPost
    from f2.exceptions.api_exceptions import APIError

    try:
        if kind == "post":
            payload = await crawler.fetch_user_post(
                UserPost(max_cursor=0, count=1, sec_user_id=sec_user_id)
            )
        else:
            payload = await crawler.fetch_user_like(
                UserLike(max_cursor=0, count=1, sec_user_id=sec_user_id)
            )
    except APIError as exc:
        http_status = http_status_from_exc(exc)
        if http_status:
            return {"status": "http_error", "http_status": http_status, "count": 0}
        return {"status": "error", "count": 0}
    except Exception:
        return {"status": "error", "count": 0}

    return classify_response(payload)


def apply_compat_patch() -> None:
    try:
        from f2_douyin_patch import apply_patch
    except ImportError:
        return
    apply_patch()


async def run_probe(url: str, config_path: str) -> dict:
    from f2.apps.douyin.crawler import DouyinCrawler
    from f2.apps.douyin.utils import ClientConfManager, SecUserIdFetcher

    apply_compat_patch()
    cookie = load_cookie(config_path)
    if not cookie:
        return {
            "ok": False,
            "error": "missing_cookie",
            "post": {"status": "error", "count": 0},
            "like": {"status": "error", "count": 0},
        }

    kwargs = {
        "cookie": cookie,
        "headers": {
            "User-Agent": ClientConfManager.user_agent(),
            "Referer": ClientConfManager.referer(),
        },
        "proxies": ClientConfManager.proxies() or {"http://": None, "https://": None},
        "max_retries": 1,
        "timeout": 15,
    }

    try:
        sec_user_id = await SecUserIdFetcher.get_sec_user_id(url)
    except Exception:
        return {
            "ok": False,
            "error": "sec_user_id",
            "post": {"status": "error", "count": 0},
            "like": {"status": "error", "count": 0},
        }

    async with DouyinCrawler(kwargs) as crawler:
        post = await fetch_list(crawler, "post", sec_user_id)
        like = await fetch_list(crawler, "like", sec_user_id)

    return {"ok": True, "post": post, "like": like}


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Probe Douyin post/like APIs without downloading")
    parser.add_argument("--url", required=True, help="Douyin user or short URL")
    parser.add_argument("--f2-config", default="", help="Optional f2 app.yaml path")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        config_path = resolve_config_path(args.f2_config)
        payload = asyncio.run(run_probe(args.url, config_path))
    except Exception:
        emit(
            {
                "ok": False,
                "error": "probe_failed",
                "post": {"status": "error", "count": 0},
                "like": {"status": "error", "count": 0},
            }
        )
        return 1
    emit(payload)
    return 0 if payload.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
