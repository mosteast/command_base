import asyncio
import json
import os
import subprocess
import tempfile
from pathlib import Path

HELPER_PATH = Path(__file__).resolve().parent / "f2_douyin_like_browser.js"
REPO_ROOT = Path(__file__).resolve().parents[2]
LIKE_CACHE = {}


def select_like_page(cache, max_cursor):
    cursor = int(max_cursor or 0)
    pages = cache.get("pages") if isinstance(cache, dict) else None
    if not isinstance(pages, list):
        return None
    for page in pages:
        if not isinstance(page, dict):
            continue
        if int(page.get("max_cursor_in") or 0) != cursor:
            continue
        return {
            "status_code": 0,
            "has_more": page.get("has_more", 0),
            "max_cursor": page.get("max_cursor", 0),
            "aweme_list": page.get("aweme_list") or [],
        }
    return None


def _cookie_from_crawler(crawler):
    headers = getattr(crawler, "headers", None) or {}
    if isinstance(headers, dict):
        cookie = headers.get("Cookie") or headers.get("cookie") or ""
        if cookie:
            return cookie
    kwargs = getattr(crawler, "kwargs", None) or {}
    if isinstance(kwargs, dict):
        return str(kwargs.get("cookie") or "")
    return ""


def _run_browser_helper(sec_user_id, cookie_header, limit=0):
    cookie_path = None
    try:
        with tempfile.NamedTemporaryFile("w", delete=False, encoding="utf-8") as handle:
            cookie_path = handle.name
            handle.write(cookie_header or "")
        command = [
            "node",
            str(HELPER_PATH),
            "--sec-user-id",
            str(sec_user_id),
            "--cookie-file",
            cookie_path,
            "--chrome-profile",
            os.environ.get("COMMAND_BASE_F2_CHROME_PROFILE", "nori"),
        ]
        if limit:
            command.extend(["--limit", str(int(limit))])
        result = subprocess.run(
            command,
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
            check=False,
        )
        lines = [line.strip() for line in (result.stdout or "").splitlines() if line.strip()]
        payload = json.loads(lines[-1]) if lines else {}
        if not payload.get("ok"):
            raise RuntimeError(payload.get("error") or result.stderr or "like browser helper failed")
        return payload
    finally:
        if cookie_path:
            try:
                os.unlink(cookie_path)
            except OSError:
                pass


async def fetch_like_via_browser(crawler, params):
    sec_user_id = getattr(params, "sec_user_id", "")
    max_cursor = getattr(params, "max_cursor", 0)
    cache = LIKE_CACHE.get(sec_user_id)
    if cache is None:
        cookie_header = _cookie_from_crawler(crawler)
        limit = int(os.environ.get("COMMAND_BASE_F2_LIKE_LIMIT") or 0)
        cache = await asyncio.to_thread(
            _run_browser_helper,
            sec_user_id,
            cookie_header,
            limit,
        )
        LIKE_CACHE[sec_user_id] = cache
    page = select_like_page(cache, max_cursor)
    if page is None:
        raise RuntimeError("like browser cache miss")
    return page
