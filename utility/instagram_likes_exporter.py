#!/usr/bin/env python3
"""Helper module to export Instagram post likers using Instaloader.

This module is driven by the instagram_likes_export CLI. It expects a JSON
configuration passed through the ``--config-json`` argument and streams the
result into CSV or JSONL outputs. It can also optionally download post media.
"""

import argparse
import csv
import datetime as dt
import fnmatch
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple
from types import SimpleNamespace


debug_enabled = False
quiet_mode = False
cookie_log_enabled = False
missing_index_token_warned = False

DEFAULT_DOWNLOAD_FILE_NAME_DELIMITER = "__"
DEFAULT_DOWNLOAD_FILE_NAME_FORMAT = [
    "timestamp",
    "id",
    "safe_title_or_desc",
    "safe_author",
    "index_or_empty",
]
VALID_DOWNLOAD_FILE_NAME_TOKENS = set(DEFAULT_DOWNLOAD_FILE_NAME_FORMAT)


class Instagram_login_required_error(RuntimeError):
    pass


def configure_logging(debug: bool, quiet: bool, debug_cookie: bool = False) -> None:
    global debug_enabled, quiet_mode, cookie_log_enabled
    debug_enabled = debug
    quiet_mode = quiet
    cookie_log_enabled = bool(debug_cookie)


def log(message: str, level: str = "info") -> None:
    """Print log messages to stderr to keep stdout clean for summaries."""
    if quiet_mode and level in {"info", "debug"}:
        return
    if level == "debug" and not debug_enabled:
        return
    sys.stderr.write(f"[{level.upper()}] {message}\n")
    sys.stderr.flush()


def log_cookie(message: str) -> None:
    if quiet_mode or not cookie_log_enabled:
        return
    sys.stderr.write(f"[COOKIE] {message}\n")
    sys.stderr.flush()


def sha256_hex_prefix(value: str, length: int = 12) -> str:
    if length < 1:
        return ""
    digest = hashlib.sha256(value.encode("utf-8", errors="ignore")).hexdigest()
    return digest[:length]


def sanitize_filename_component(value: Any, max_len: int = 0) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    safe_text = re.sub(r"[^a-zA-Z0-9._-]+", "_", text)
    safe_text = safe_text.strip("_")
    if max_len > 0 and len(safe_text) > max_len:
        safe_text = safe_text[:max_len].rstrip("_")
    return safe_text


def normalize_download_file_name_format(raw_value: Any) -> List[str]:
    if raw_value is None or raw_value == "":
        return list(DEFAULT_DOWNLOAD_FILE_NAME_FORMAT)

    candidates: List[str] = []
    if isinstance(raw_value, str):
        candidates = [token for token in re.split(r"[, +]+", raw_value) if token]
    elif isinstance(raw_value, list):
        for entry in raw_value:
            if entry is None:
                continue
            candidates.extend(
                [token for token in re.split(r"[, +]+", str(entry)) if token]
            )
    else:
        candidates = [str(raw_value)]

    seen: Set[str] = set()
    normalized: List[str] = []
    for token in candidates:
        value = token.strip().lower()
        if not value:
            continue
        if value not in VALID_DOWNLOAD_FILE_NAME_TOKENS:
            raise ValueError(
                "download_file_name_format tokens must be one of: "
                + ", ".join(sorted(VALID_DOWNLOAD_FILE_NAME_TOKENS))
                + f" (received '{value}')."
            )
        if value in seen:
            continue
        seen.add(value)
        normalized.append(value)

    return normalized if normalized else list(DEFAULT_DOWNLOAD_FILE_NAME_FORMAT)


def normalize_download_file_name_delimiter(raw_value: Any) -> str:
    if raw_value is None or raw_value == "":
        return DEFAULT_DOWNLOAD_FILE_NAME_DELIMITER
    delimiter = str(raw_value)
    if "/" in delimiter or "\\" in delimiter or "\0" in delimiter:
        raise ValueError(
            "download_file_name_delimiter must not contain path separators."
        )
    if not delimiter.strip():
        raise ValueError("download_file_name_delimiter must not be empty.")
    return delimiter


def collapse_whitespace(value: str) -> str:
    return " ".join(str(value or "").split())


def get_post_title_or_desc(post: Any) -> str:
    caption = getattr(post, "caption", None)
    if caption:
        return collapse_whitespace(str(caption))
    accessibility = getattr(post, "accessibility_caption", None)
    if accessibility:
        return collapse_whitespace(str(accessibility))
    return ""


def format_post_timestamp(post: Any) -> str:
    timestamp = getattr(post, "date_utc", None)
    if not timestamp:
        timestamp = getattr(post, "date_local", None)
    if not isinstance(timestamp, dt.datetime):
        return ""
    try:
        return timestamp.strftime("%Y-%m-%d_%H-%M-%S")
    except Exception:
        return ""


def build_download_file_stem(
    post: Any,
    tokens: List[str],
    delimiter: str,
    index: Optional[int],
) -> str:
    parts: List[str] = []
    for token in tokens:
        if token == "timestamp":
            parts.append(sanitize_filename_component(format_post_timestamp(post)))
        elif token == "id":
            parts.append(sanitize_filename_component(getattr(post, "mediaid", "")))
        elif token == "safe_title_or_desc":
            parts.append(
                sanitize_filename_component(get_post_title_or_desc(post), max_len=80)
            )
        elif token == "safe_author":
            parts.append(
                sanitize_filename_component(getattr(post, "owner_username", ""), max_len=80)
            )
        elif token == "index_or_empty":
            if index is not None:
                parts.append(sanitize_filename_component(str(index)))

    stem = delimiter.join([part for part in parts if part])
    if stem:
        return stem

    fallback = sanitize_filename_component(
        getattr(post, "shortcode", "") or getattr(post, "mediaid", "") or "post",
        max_len=120,
    )
    return fallback or "post"


def format_cookie_expires_utc(expires: Optional[int]) -> str:
    if not expires:
        return "<session>"
    try:
        return dt.datetime.fromtimestamp(expires, tz=dt.timezone.utc).isoformat()
    except Exception:
        return str(expires)


def parse_cookie_string(raw_value: Optional[str]) -> Dict[str, str]:
    if not raw_value:
        return {}
    cookies: Dict[str, str] = {}
    for chunk in str(raw_value).split(";"):
        if not chunk.strip():
            continue
        if "=" not in chunk:
            continue
        name, value = chunk.split("=", 1)
        name = name.strip()
        value = value.strip()
        if not name:
            continue
        cookies[name] = value
    return cookies


def parse_cookie_json_payload(payload: Any) -> Dict[str, str]:
    cookies: Dict[str, str] = {}
    if isinstance(payload, dict) and "cookies" in payload:
        payload = payload.get("cookies")
    if isinstance(payload, dict):
        name = str(payload.get("name", "") or "").strip()
        value = str(payload.get("value", "") or "").strip()
        if name:
            cookies[name] = value
        return cookies
    if not isinstance(payload, list):
        return cookies
    for entry in payload:
        if not isinstance(entry, dict):
            continue
        name = str(entry.get("name", "") or "").strip()
        value = str(entry.get("value", "") or "").strip()
        if not name:
            continue
        cookies[name] = value
    return cookies


def parse_netscape_cookie_text(text: str) -> Dict[str, str]:
    cookies: Dict[str, str] = {}
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split("\t")
        if len(parts) < 7:
            parts = re.split(r"\s+", stripped, maxsplit=6)
        if len(parts) < 7:
            continue
        name = parts[5].strip()
        value = parts[6].strip()
        if not name:
            continue
        cookies[name] = value
    return cookies


def load_cookies_from_file(cookie_file: Optional[Path]) -> Dict[str, str]:
    if not cookie_file:
        return {}
    if not cookie_file.exists():
        raise FileNotFoundError(f"Cookie file not found: {cookie_file}")
    log(f"Loading cookies from {cookie_file}", level="debug")
    text = cookie_file.read_text(encoding="utf-8", errors="ignore")
    stripped = text.lstrip()
    if stripped.startswith("{") or stripped.startswith("["):
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"Cookie JSON parse failed ({cookie_file}): {exc}"
            ) from exc
        return parse_cookie_json_payload(payload)
    return parse_netscape_cookie_text(text)


def load_session_from_cookies(
    loader,
    session_user: str,
    cookie_values: Dict[str, str],
    session_file: Optional[str],
    save_session: bool,
) -> None:
    if not cookie_values:
        raise RuntimeError("Cookie import was requested but no cookies were found.")
    log("Loading Instaloader session from imported cookies.", level="debug")
    try:
        loader.context.load_session(session_user, cookie_values)
    except KeyError as exc:
        raise RuntimeError(
            "Cookie import failed: missing required cookie (expected at least 'csrftoken', "
            "'sessionid', and 'ds_user_id')."
        ) from exc
    if not save_session:
        return
    try:
        resolved_session_file = (
            str(Path(session_file).expanduser())
            if session_file
            else None
        )
        loader.save_session_to_file(resolved_session_file)
        log(
            f"Saved Instaloader session to {resolved_session_file or 'default session file'}.",
            level="debug",
        )
    except Exception as exc:
        log(f"Failed to save session file from cookies: {exc}", level="warn")


def resolve_session_file_path(
    session_user: str, session_file: Optional[str]
) -> Optional[Path]:
    if session_file:
        return Path(session_file).expanduser()

    try:
        import instaloader.instaloader as instaloader_module

        default_path = Path(
            instaloader_module.get_default_session_filename(session_user)
        )
        if default_path.exists():
            return default_path

        legacy_path = Path(
            instaloader_module.get_legacy_session_filename(session_user)
        )
        if legacy_path.exists():
            return legacy_path

        return default_path
    except Exception:
        return None


def log_instaloader_cookie_snapshot(
    loader, session_user: str, session_file: Optional[str]
) -> None:
    if quiet_mode or not cookie_log_enabled:
        return

    log_cookie("Cookie snapshot is redacted; do not share these logs.")

    session_path = resolve_session_file_path(session_user, session_file)
    if session_path:
        try:
            stat = session_path.stat()
            mtime_utc = dt.datetime.fromtimestamp(
                stat.st_mtime, tz=dt.timezone.utc
            ).isoformat()
            log_cookie(
                f"session_file={session_path} size={stat.st_size} mtime_utc={mtime_utc}"
            )
        except Exception as exc:
            log_cookie(f"session_file={session_path} (stat_failed={exc})")

    context = getattr(loader, "context", None)
    session = getattr(context, "_session", None)
    cookie_jar = getattr(session, "cookies", None)
    if cookie_jar is None:
        log_cookie("No cookie jar found at loader.context._session.cookies")
        return

    cookies = list(cookie_jar)
    log_cookie(f"cookie_count={len(cookies)}")

    important_cookie_names = [
        "sessionid",
        "ds_user_id",
        "csrftoken",
        "mid",
        "ig_did",
        "rur",
    ]
    present_names = {cookie.name for cookie in cookies}
    presence_summary = ", ".join(
        f"{name}={'present' if name in present_names else 'missing'}"
        for name in important_cookie_names
    )
    log_cookie(f"important={presence_summary}")

    now_timestamp = int(dt.datetime.now(tz=dt.timezone.utc).timestamp())
    for cookie in sorted(
        cookies, key=lambda entry: (entry.domain or "", entry.name or "")
    ):
        name = getattr(cookie, "name", "")
        domain = getattr(cookie, "domain", "")
        cookie_path = getattr(cookie, "path", "")
        secure = bool(getattr(cookie, "secure", False))
        expires = getattr(cookie, "expires", None)
        expires_utc = format_cookie_expires_utc(expires)
        expired = (
            bool(expires) and isinstance(expires, int) and expires <= now_timestamp
        )
        value = str(getattr(cookie, "value", "") or "")
        value_len = len(value)
        value_hash = sha256_hex_prefix(value, 12) if value else ""

        log_cookie(
            f"name={name} domain={domain} path={cookie_path} secure={secure} "
            f"expires_utc={expires_utc} expired={expired} value_len={value_len} "
            f"value_sha256_12={value_hash}"
        )


def parse_datetime(date_str: Optional[str]) -> Optional[dt.datetime]:
    if not date_str:
        return None
    try:
        return dt.datetime.strptime(date_str, "%Y-%m-%d").replace(
            tzinfo=dt.timezone.utc
        )
    except ValueError as exc:
        raise ValueError(f"Invalid date value '{date_str}', use YYYY-MM-DD") from exc


def load_config() -> Dict:
    parser = argparse.ArgumentParser(
        description="Internal exporter, use via instagram_likes_export CLI."
    )
    parser.add_argument(
        "--config-json",
        required=True,
        help="JSON configuration payload generated by the CLI wrapper.",
    )
    args = parser.parse_args()
    try:
        return json.loads(args.config_json)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Invalid JSON passed to --config-json: {exc}") from exc


def ensure_instaloader():
    try:
        import instaloader  # noqa: F401
    except ImportError as exc:
        python_executable = sys.executable or "python3"
        raise RuntimeError(
            "Instaloader is not installed for this Python interpreter.\n"
            f"Python: {python_executable}\n"
            "\n"
            "Install with:\n"
            f"  {python_executable} -m pip install instaloader==4.15\n"
            "\n"
            "Or run the wrapper with a different interpreter:\n"
            "  instagram_likes_export --python /path/to/python3 <target_user>"
        ) from exc


def build_instaloader(
    debug: bool,
    quiet: bool,
    download_enabled: bool,
    download_dir: Optional[Path],
):
    import instaloader

    dirname_pattern = None
    if download_enabled and download_dir:
        dirname_pattern = str(download_dir.expanduser() / "{target}")

    return instaloader.Instaloader(
        quiet=quiet,
        dirname_pattern=dirname_pattern,
        download_pictures=bool(download_enabled),
        download_videos=bool(download_enabled),
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        post_metadata_txt_pattern="{caption}" if download_enabled else "",
        storyitem_metadata_txt_pattern="",
        max_connection_attempts=3 if debug else 1,
    )


def load_session(
    loader, session_user: str, session_file: Optional[str]
) -> None:
    session_file_path = (
        Path(session_file).expanduser() if session_file else None
    )
    if session_file_path:
        log(f"Loading session from {session_file_path}", level="debug")
    try:
        if session_file_path:
            loader.load_session_from_file(session_user, str(session_file_path))
        else:
            loader.load_session_from_file(session_user)
    except FileNotFoundError as exc:
        expected_path = resolve_session_file_path(session_user, session_file)
        python_executable = sys.executable or "python3"
        expected_hint = (
            f"Expected session file at: {expected_path}\n\n"
            if expected_path
            else ""
        )
        raise RuntimeError(
            "Session file not found.\n"
            + expected_hint
            + "Fix:\n"
            + "  1) Create the session file with Instaloader (use the same interpreter):\n"
            + f"     {python_executable} -m instaloader --login {session_user}\n"
            + "  2) If your session file lives somewhere else, pass it explicitly:\n"
            + "     instagram_likes_export --session-file /path/to/session-<user>\n"
        ) from exc


def load_checkpoint(checkpoint_path: Optional[Path]) -> Dict:
    if not checkpoint_path or not checkpoint_path.exists():
        return {"processed_posts": []}
    try:
        with checkpoint_path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as exc:  # pragma: no cover - defensive
        log(f"Failed to load checkpoint: {exc}", level="warn")
        return {"processed_posts": []}


def save_checkpoint(checkpoint_path: Optional[Path], processed_posts: Set[str]) -> None:
    if not checkpoint_path:
        return
    checkpoint_payload = {"processed_posts": sorted(processed_posts)}
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)
    with checkpoint_path.open("w", encoding="utf-8") as handle:
        json.dump(checkpoint_payload, handle, ensure_ascii=False, indent=2)


def load_processed_posts_from_per_post_output(
    per_post_path: Path, format_name: str
) -> Set[str]:
    processed_posts: Set[str] = set()
    if not per_post_path.exists():
        return processed_posts

    normalized_format = str(format_name or "csv").strip().lower()
    log(f"Scanning per_post output for exported posts: {per_post_path}", level="debug")

    try:
        if normalized_format == "csv":
            with per_post_path.open("r", encoding="utf-8", newline="") as handle:
                reader = csv.reader(handle)
                header = next(reader, None)
                if not header:
                    return processed_posts

                shortcode_index = 0
                for index, field_name in enumerate(header):
                    if str(field_name).strip() == "post_shortcode":
                        shortcode_index = index
                        break

                for row in reader:
                    if not row or shortcode_index >= len(row):
                        continue
                    shortcode = str(row[shortcode_index]).strip()
                    if shortcode:
                        processed_posts.add(shortcode)
        elif normalized_format == "jsonl":
            with per_post_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    text = line.strip()
                    if not text:
                        continue
                    try:
                        payload = json.loads(text)
                    except Exception:
                        continue
                    shortcode = payload.get("post_shortcode")
                    if shortcode:
                        processed_posts.add(str(shortcode).strip())
        else:
            log(
                f"Unsupported format '{format_name}' while scanning {per_post_path}; expected csv or jsonl.",
                level="warn",
            )
    except Exception as exc:
        log(f"Failed to scan per_post output {per_post_path}: {exc}", level="warn")

    log(
        f"Detected {len(processed_posts)} exported posts in per_post output.",
        level="debug",
    )
    return processed_posts


def date_within_bounds(
    post_date: dt.datetime,
    since: Optional[dt.datetime],
    until: Optional[dt.datetime],
) -> bool:
    if since and post_date < since:
        return False
    if until and post_date > until:
        return False
    return True


def matches_patterns(value: str, patterns: Optional[List[str]]) -> bool:
    if not patterns:
        return True
    return any(fnmatch.fnmatchcase(value, pattern) for pattern in patterns)


def prepare_writer(
    path: Optional[Path],
    format_name: str,
    headers: Iterable[str],
    append: bool = False,
) -> Tuple[Optional[csv.DictWriter], Optional[Path], Optional[object]]:
    if not path:
        return None, None, None
    path.parent.mkdir(parents=True, exist_ok=True)

    existed_before_open = path.exists()
    had_content_before_open = (
        existed_before_open and path.stat().st_size > 0
    )

    file_handle = path.open(
        "a" if append else "w", encoding="utf-8", newline=""
    )
    if format_name == "csv":
        writer = csv.DictWriter(file_handle, fieldnames=list(headers))
        if not append or not had_content_before_open:
            writer.writeheader()
        return writer, path, file_handle
    return None, path, file_handle


def write_jsonl_row(file_handle, payload: Dict) -> None:
    serialized = json.dumps(payload, ensure_ascii=False)
    file_handle.write(serialized + "\n")
    file_handle.flush()


def iter_liked_posts(
    context,
    max_attempts: int,
    backoff_seconds: int,
    session_user: str,
) -> Iterable[Any]:
    import instaloader
    import time

    max_id: Optional[str] = None
    page_index = 0

    while True:
        page_index += 1
        params: Dict[str, Any] = {"count": 50}
        if max_id:
            params["max_id"] = max_id

        log(
            f"Fetching liked posts page {page_index} (max_id={max_id or '<first>'})",
            level="debug",
        )

        attempt_index = 0
        while True:
            try:
                response = context.get_iphone_json(
                    "api/v1/feed/liked/", params=params
                )
                break
            except instaloader.exceptions.TooManyRequestsException:
                attempt_index += 1
                if attempt_index >= max_attempts:
                    raise
                log(
                    f"Rate limit hit while fetching liked posts, sleeping {backoff_seconds}s "
                    f"(attempt {attempt_index} of {max_attempts}).",
                    level="warn",
                )
                time.sleep(backoff_seconds)
            except instaloader.exceptions.ConnectionException as exc:
                error_text = str(exc)
                if is_instagram_retry_later_error(error_text):
                    attempt_index += 1
                    if attempt_index >= max_attempts:
                        raise RuntimeError(
                            render_instagram_retry_later_hint(
                                error_text, session_user=session_user
                            )
                        ) from exc
                    log(
                        "Instagram asked to wait before retrying liked feed. "
                        f"Sleeping {backoff_seconds}s (attempt {attempt_index} of {max_attempts}).",
                        level="warn",
                    )
                    time.sleep(backoff_seconds)
                    continue
                if is_login_required_error(error_text):
                    raise Instagram_login_required_error(
                        render_instagram_login_required_hint(
                            error_text, session_user=session_user
                        )
                    ) from exc
                attempt_index += 1
                if attempt_index >= max_attempts:
                    raise
                log(
                    f"Connection issue while fetching liked posts: {exc}. Sleeping {backoff_seconds}s "
                    f"(attempt {attempt_index} of {max_attempts}).",
                    level="warn",
                )
                time.sleep(backoff_seconds)

        items = response.get("items") or []
        if not isinstance(items, list):
            log(
                "Unexpected liked feed response shape; expected items[] list.",
                level="warn",
            )
            break

        for media in items:
            try:
                yield instaloader.Post.from_iphone_struct(context, media)
            except Exception as exc:
                log(f"Skipping liked post item due to parse error: {exc}", level="warn")

        if not response.get("more_available"):
            break
        next_max_id = response.get("next_max_id")
        if not next_max_id:
            break
        max_id = str(next_max_id)


def iter_post_likers_via_iphone_endpoint(
    context,
    mediaid: str,
    max_attempts: int,
    backoff_seconds: int,
    session_user: str,
) -> Iterable[Any]:
    import instaloader
    import time

    max_id: Optional[str] = None
    page_index = 0
    seen_max_ids: Set[str] = set()

    while True:
        page_index += 1
        params: Dict[str, Any] = {}
        if max_id:
            params["max_id"] = max_id

        log(
            f"Fetching likers for media {mediaid} via iPhone endpoint "
            f"(page={page_index} max_id={max_id or '<first>'})",
            level="debug",
        )

        attempt_index = 0
        while True:
            try:
                response = context.get_iphone_json(
                    f"api/v1/media/{mediaid}/likers/", params=params
                )
                break
            except instaloader.exceptions.TooManyRequestsException:
                attempt_index += 1
                if attempt_index >= max_attempts:
                    raise
                log(
                    f"Rate limit hit while fetching likers (iPhone) for media {mediaid}, "
                    f"sleeping {backoff_seconds}s (attempt {attempt_index} of {max_attempts}).",
                    level="warn",
                )
                time.sleep(backoff_seconds)
            except instaloader.exceptions.ConnectionException as exc:
                error_text = str(exc)
                if is_instagram_retry_later_error(error_text):
                    attempt_index += 1
                    if attempt_index >= max_attempts:
                        raise RuntimeError(
                            render_instagram_retry_later_hint(
                                error_text, session_user=session_user
                            )
                        ) from exc
                    log(
                        "Instagram asked to wait before retrying media likers. "
                        f"Sleeping {backoff_seconds}s (attempt {attempt_index} of {max_attempts}).",
                        level="warn",
                    )
                    time.sleep(backoff_seconds)
                    continue
                if is_login_required_error(error_text):
                    raise Instagram_login_required_error(
                        render_instagram_login_required_hint(
                            error_text, session_user=session_user
                        )
                    ) from exc
                attempt_index += 1
                if attempt_index >= max_attempts:
                    raise
                log(
                    f"Connection issue while fetching likers (iPhone) for media {mediaid}: {exc}. "
                    f"Sleeping {backoff_seconds}s (attempt {attempt_index} of {max_attempts}).",
                    level="warn",
                )
                time.sleep(backoff_seconds)

        users = response.get("users") or []
        if not isinstance(users, list):
            raise RuntimeError(
                "Unexpected likers response from iPhone endpoint; expected users[] list."
            )

        for user_node in users:
            try:
                yield instaloader.Profile.from_iphone_struct(context, user_node)
            except Exception as exc:
                log(
                    f"Skipping liker item due to parse error on media {mediaid}: {exc}",
                    level="warn",
                )

        next_max_id = response.get("next_max_id")
        more_available = response.get("more_available")
        if not next_max_id:
            break
        if more_available is False:
            break

        next_max_id_text = str(next_max_id)
        if next_max_id_text in seen_max_ids:
            break
        seen_max_ids.add(next_max_id_text)
        max_id = next_max_id_text


def render_instagram_blocked_hint(error_text: str, session_user: str) -> str:
    normalized = error_text.lower()
    reason = "an Instagram safety check"
    for keyword in ("feedback_required", "checkpoint_required", "challenge_required"):
        if keyword in normalized:
            reason = keyword
            break

    return (
        "Instagram blocked this request ("
        + reason
        + "). This is usually not a cookie issue.\n"
        "\n"
        "Fix:\n"
        "  1) Open Instagram (app/web) and complete any prompts.\n"
        "  2) Recreate your Instaloader session:\n"
        f"     instaloader --login {session_user}\n"
        "  3) Retry with a small batch:\n"
        "     instagram_likes_export --max-posts 1 --content-type liked --likers-source iphone\n"
        "  4) If you just need downloads (likers omitted when blocked):\n"
        "     instagram_likes_export --max-posts 10 --content-type liked --on-block skip_post\n"
        "\n"
        f"Original error: {error_text}"
    )


def is_instagram_block_error(error_text: str) -> bool:
    normalized = str(error_text or "").lower()
    return any(
        keyword in normalized
        for keyword in (
            "feedback_required",
            "checkpoint_required",
            "challenge_required",
        )
    )


def is_instagram_retry_later_error(error_text: str) -> bool:
    normalized = str(error_text or "").lower()
    return "please wait a few minutes" in normalized


def render_instagram_retry_later_hint(error_text: str, session_user: str) -> str:
    return (
        "Instagram temporarily blocked requests from this session/IP with:\n"
        "  \"Please wait a few minutes before you try again.\"\n"
        "\n"
        "Fix:\n"
        "  1) Stop retrying for now (retries can extend the cooldown).\n"
        "  2) Wait a while, then retry with a small batch:\n"
        "     instagram_likes_export --max-posts 1 --content-type liked --likers-source iphone\n"
        "  3) If you must re-login, do it after the cooldown:\n"
        f"     instaloader --login {session_user}\n"
        "\n"
        f"Original error: {error_text}"
    )


def is_login_required_error(error_text: str) -> bool:
    normalized = str(error_text or "").lower()
    return "login_required" in normalized or "login required" in normalized


def render_instagram_login_required_hint(error_text: str, session_user: str) -> str:
    python_executable = sys.executable or "python3"
    return (
        "Instagram returned 'login_required' for an authenticated endpoint.\n"
        "\n"
        "This usually means your Instaloader session is expired, logged out, or belongs to a different account.\n"
        "\n"
        "Fix:\n"
        "  1) Recreate the Instaloader session (uses the same interpreter as this run):\n"
        f"     {python_executable} -m instaloader --login {session_user}\n"
        "     If Instaloader says 'Checkpoint required', open the printed /auth_platform/ URL in your browser\n"
        "     (prefix it with https://www.instagram.com), complete the prompts, then retry the login.\n"
        "     If Instagram says 'Please wait a few minutes before you try again', stop retrying for a while\n"
        "     (retries can extend the cooldown), then try again later.\n"
        "  2) Retry with a small batch:\n"
        f"     instagram_likes_export --user {session_user} --content-type liked --max-posts 1\n"
        "\n"
        "Note: logging into Instagram in Chrome does not update Instaloader's session file.\n"
        "\n"
        f"Original error: {error_text}"
    )


def compute_download_target(
    profile_username: str, session_user: str, source_content_type: str
) -> str:
    normalized_source = str(source_content_type or "").strip().lower()
    if normalized_source in ("liked", "saved"):
        return f"{session_user}.{normalized_source}"
    return profile_username


def resolve_download_target_dir(download_dir: Optional[Path], target: str) -> Path:
    if download_dir:
        return download_dir.expanduser() / str(target)
    return Path(str(target)).expanduser()


def download_post_media_with_custom_filename(
    loader,
    post,
    target_dir: Path,
    download_file_name_format: List[str],
    download_file_name_delimiter: str,
) -> None:
    global missing_index_token_warned
    target_dir.mkdir(parents=True, exist_ok=True)

    post_stem = build_download_file_stem(
        post=post,
        tokens=download_file_name_format,
        delimiter=download_file_name_delimiter,
        index=None,
    )
    post_base_path = target_dir / post_stem

    post_typename = getattr(post, "typename", "")
    if post_typename == "GraphSidecar" and "index_or_empty" not in download_file_name_format:
        if not missing_index_token_warned:
            log(
                "download_file_name_format is missing 'index_or_empty'; appending index for sidecar nodes to avoid collisions.",
                level="warn",
            )
            missing_index_token_warned = True
    if post_typename == "GraphSidecar":
        sidecar_nodes = list(post.get_sidecar_nodes())
        for index, node in enumerate(sidecar_nodes, start=1):
            node_stem = build_download_file_stem(
                post=post,
                tokens=download_file_name_format,
                delimiter=download_file_name_delimiter,
                index=index,
            )
            if "index_or_empty" not in download_file_name_format:
                node_stem = (
                    node_stem
                    + download_file_name_delimiter
                    + sanitize_filename_component(str(index))
                )
            node_base_path = target_dir / node_stem

            video_url = getattr(node, "video_url", None)
            display_url = getattr(node, "display_url", None)
            if video_url:
                if loader.download_pictures and loader.download_video_thumbnails:
                    if display_url:
                        loader.download_pic(
                            filename=str(node_base_path),
                            url=str(display_url),
                            mtime=post.date_local,
                        )
                if loader.download_videos:
                    loader.download_pic(
                        filename=str(node_base_path),
                        url=str(video_url),
                        mtime=post.date_local,
                    )
            else:
                if loader.download_pictures:
                    if display_url:
                        loader.download_pic(
                            filename=str(node_base_path),
                            url=str(display_url),
                            mtime=post.date_local,
                        )
    elif post_typename == "GraphImage":
        if loader.download_pictures:
            url = getattr(post, "url", None)
            if url:
                loader.download_pic(
                    filename=str(post_base_path),
                    url=str(url),
                    mtime=post.date_local,
                )
    elif post_typename == "GraphVideo":
        if loader.download_pictures and loader.download_video_thumbnails:
            url = getattr(post, "url", None)
            if url:
                loader.download_pic(
                    filename=str(post_base_path),
                    url=str(url),
                    mtime=post.date_local,
                )
    else:
        log(
            f"Warning: {post.shortcode} has unknown typename: {post_typename}",
            level="warn",
        )

    metadata_pattern = str(getattr(loader, "post_metadata_txt_pattern", "") or "")
    if metadata_pattern.strip():
        caption = str(getattr(post, "caption", "") or "").strip()
        if caption:
            loader.save_caption(
                filename=str(post_base_path),
                mtime=post.date_local,
                caption=caption,
            )

    if post_typename != "GraphSidecar" and getattr(post, "is_video", False):
        if loader.download_videos:
            video_url = getattr(post, "video_url", None)
            if video_url:
                loader.download_pic(
                    filename=str(post_base_path),
                    url=str(video_url),
                    mtime=post.date_local,
                )


def download_post_media_with_retry(
    loader,
    post,
    target: str,
    download_dir: Optional[Path],
    download_file_name_format: List[str],
    download_file_name_delimiter: str,
    max_attempts: int,
    backoff_seconds: int,
    session_user: str,
) -> None:
    import instaloader
    import time

    attempt_index = 0
    target_dir = resolve_download_target_dir(download_dir, target)
    while True:
        attempt_index += 1
        try:
            download_post_media_with_custom_filename(
                loader=loader,
                post=post,
                target_dir=target_dir,
                download_file_name_format=download_file_name_format,
                download_file_name_delimiter=download_file_name_delimiter,
            )
            return
        except instaloader.exceptions.TooManyRequestsException:
            if attempt_index >= max_attempts:
                raise
            log(
                f"Rate limit hit while downloading {post.shortcode}, sleeping {backoff_seconds}s "
                f"(attempt {attempt_index} of {max_attempts}).",
                level="warn",
            )
            time.sleep(backoff_seconds)
        except instaloader.exceptions.ConnectionException as exc:
            error_text = str(exc)
            if is_instagram_retry_later_error(error_text):
                if attempt_index >= max_attempts:
                    raise RuntimeError(
                        render_instagram_retry_later_hint(
                            error_text, session_user=session_user
                        )
                    ) from exc
                log(
                    "Instagram asked to wait before retrying downloads. "
                    f"Sleeping {backoff_seconds}s (attempt {attempt_index} of {max_attempts}).",
                    level="warn",
                )
                time.sleep(backoff_seconds)
                continue
            if is_login_required_error(error_text):
                raise Instagram_login_required_error(
                    render_instagram_login_required_hint(
                        error_text, session_user=session_user
                    )
                ) from exc
            if attempt_index >= max_attempts:
                raise
            log(
                f"Connection issue while downloading {post.shortcode}: {exc}. Sleeping {backoff_seconds}s "
                f"(attempt {attempt_index} of {max_attempts}).",
                level="warn",
            )
            time.sleep(backoff_seconds)
        except instaloader.exceptions.AbortDownloadException as exc:
            raise RuntimeError(
                render_instagram_blocked_hint(str(exc), session_user=session_user)
            ) from exc


def export_posts(
    loader,
    profile,
    content_types: List[str],
    session_user: str,
    modes: List[str],
    append_outputs: Optional[Dict[str, bool]],
    likers_source: str,
    on_block: str,
    output_paths: Dict[str, Optional[Path]],
    format_name: str,
    since: Optional[dt.datetime],
    until: Optional[dt.datetime],
    max_posts: Optional[int],
    post_filters: List[str],
    checkpoint_path: Optional[Path],
    refresh: bool,
    dry_run: bool,
    download_enabled: bool,
    download_dir: Optional[Path],
    download_file_name_format: List[str],
    download_file_name_delimiter: str,
    max_attempts: int,
    backoff_seconds: int,
) -> Dict:
    import instaloader
    import time

    warnings: List[str] = []
    append_outputs = append_outputs or {}
    likers_source_normalized = str(likers_source or "auto").strip().lower()
    if likers_source_normalized not in ("auto", "graphql", "iphone"):
        raise RuntimeError(
            "likers_source must be one of: auto, graphql, iphone "
            f"(received '{likers_source}')."
        )
    on_block_normalized = str(on_block or "abort").strip().lower()
    if on_block_normalized not in ("abort", "skip_post"):
        raise RuntimeError(
            "on_block must be one of: abort, skip_post "
            f"(received '{on_block}')."
        )
    graphql_likers_blocked = False

    processed_posts: Set[str] = set()
    checkpoint_data = load_checkpoint(checkpoint_path)
    if checkpoint_data.get("processed_posts"):
        processed_posts.update(checkpoint_data["processed_posts"])

    if not refresh:
        per_post_output_path = output_paths.get("per_post")
        checkpoint_has_posts = bool(checkpoint_data.get("processed_posts"))
        has_existing_per_post = bool(
            per_post_output_path
            and output_has_data_rows(per_post_output_path, format_name)
        )
        if has_existing_per_post and not checkpoint_has_posts:
            log(
                "Checkpoint is missing or empty; inferring exported posts from existing per_post output.",
                level="warn",
            )
            inferred_posts = load_processed_posts_from_per_post_output(
                per_post_output_path, format_name
            )
            if inferred_posts:
                processed_posts.update(inferred_posts)
                if checkpoint_path and not dry_run:
                    log(
                        f"Writing rebuilt checkpoint: {checkpoint_path}",
                        level="warn",
                    )
                    save_checkpoint(checkpoint_path, processed_posts)

    per_post_writer = None
    per_post_path = None
    per_post_handle = None
    unique_writer = None
    unique_path = None
    unique_handle = None
    ghost_writer = None
    ghost_path = None
    ghost_handle = None

    unique_likers: Dict[str, Dict] = {}
    processed_count = 0
    skipped_count = 0
    blocked_count = 0
    dry_run_posts: List[Dict] = []
    scanned_posts = 0
    downloaded_posts = 0

    def finalize_handles():
        for handle in [per_post_handle, unique_handle, ghost_handle]:
            if handle:
                handle.close()

    def iter_posts():
        seen_shortcodes: Set[str] = set()
        for content_type in content_types:
            if content_type == "saved" and profile.username != session_user:
                raise RuntimeError(
                    "Saved posts require --user to match --session-user."
                )
            if content_type == "liked" and profile.username != session_user:
                raise RuntimeError(
                    "Liked posts require --user to match --session-user."
                )

            try:
                if content_type == "posts":
                    iterator = profile.get_posts()
                elif content_type == "reels":
                    iterator = profile.get_reels()
                elif content_type == "igtv":
                    iterator = profile.get_igtv_posts()
                elif content_type == "tagged":
                    iterator = profile.get_tagged_posts()
                elif content_type == "saved":
                    iterator = profile.get_saved_posts()
                elif content_type == "liked":
                    iterator = iter_liked_posts(
                        loader.context,
                        max_attempts=max_attempts,
                        backoff_seconds=backoff_seconds,
                        session_user=session_user,
                    )
                else:
                    raise RuntimeError(
                        f"Unsupported content type '{content_type}'."
                    )
            except KeyError as exc:
                warnings.append(
                    f"Content source '{content_type}' is unavailable for {profile.username}: {exc}"
                )
                continue
            except Exception as exc:
                if isinstance(exc, Instagram_login_required_error):
                    raise
                warnings.append(
                    f"Failed to initialize content source '{content_type}': {exc}"
                )
                continue

            try:
                for post in iterator:
                    shortcode = getattr(post, "shortcode", None)
                    if not shortcode:
                        continue
                    if shortcode in seen_shortcodes:
                        continue
                    seen_shortcodes.add(shortcode)
                    yield post, content_type
            except KeyError as exc:
                warnings.append(
                    f"Content source '{content_type}' failed for {profile.username}: {exc}"
                )
                continue
            except Exception as exc:
                if isinstance(exc, Instagram_login_required_error):
                    raise
                warnings.append(
                    f"Content source '{content_type}' failed for {profile.username}: {exc}"
                )
                continue

    for post, source_content_type in iter_posts():
        scanned_posts += 1
        if max_posts and processed_count >= max_posts:
            log("Max post limit reached, stopping iteration.", level="debug")
            break

        if not date_within_bounds(post.date_utc, since, until):
            continue

        if not matches_patterns(post.shortcode, post_filters):
            skipped_count += 1
            continue

        if not refresh and post.shortcode in processed_posts:
            skipped_count += 1
            continue

        log(
            f"Processing post {post.shortcode} dated {post.date_utc.isoformat()} (source={source_content_type})",
            level="info",
        )

        if download_enabled and not dry_run:
            download_target = compute_download_target(
                profile.username,
                session_user=session_user,
                source_content_type=source_content_type,
            )
            log(
                f"Downloading post {post.shortcode} (target={download_target})",
                level="info",
            )
            try:
                download_post_media_with_retry(
                    loader=loader,
                    post=post,
                    target=download_target,
                    download_dir=download_dir,
                    download_file_name_format=download_file_name_format,
                    download_file_name_delimiter=download_file_name_delimiter,
                    max_attempts=max_attempts,
                    backoff_seconds=backoff_seconds,
                    session_user=session_user,
                )
                downloaded_posts += 1
            except Exception as exc:
                if isinstance(exc, Instagram_login_required_error):
                    raise
                warnings.append(f"Failed to download {post.shortcode}: {exc}")

        if not dry_run and "per_post" in modes and per_post_handle is None:
            log("Opening per_post output file...", level="debug")
            per_post_writer, per_post_path, per_post_handle = prepare_writer(
                output_paths.get("per_post"),
                format_name,
                [
                    "post_shortcode",
                    "post_date_utc",
                    "post_caption",
                    "liker_username",
                    "liker_id",
                ],
                append=append_outputs.get("per_post", False),
            )

        if dry_run:
            dry_run_posts.append(
                {
                    "post_shortcode": post.shortcode,
                    "post_date_utc": post.date_utc.isoformat(),
                    "like_count": getattr(post, "likes", None),
                }
            )
            processed_posts.add(post.shortcode)
            processed_count += 1
            continue

        per_post_seen_likers: Set[str] = set()
        new_unique_usernames: Set[str] = set()

        per_post_offset: Optional[int] = None
        if per_post_handle:
            try:
                per_post_offset = per_post_handle.tell()
            except Exception as exc:
                log(
                    f"Unable to record per_post output offset for {post.shortcode}: {exc}",
                    level="warn",
                )
                per_post_offset = None

        def rollback_post_outputs() -> None:
            nonlocal per_post_offset
            if per_post_handle is not None and per_post_offset is not None:
                try:
                    per_post_handle.flush()
                    per_post_handle.seek(per_post_offset)
                    per_post_handle.truncate(per_post_offset)
                    per_post_handle.flush()
                except Exception as exc:
                    log(
                        f"Failed to rollback per_post output for {post.shortcode}: {exc}",
                        level="warn",
                    )

            if new_unique_usernames:
                for liker_username in new_unique_usernames:
                    unique_likers.pop(liker_username, None)
                new_unique_usernames.clear()

        def yield_likers_via_graphql():
            likes_iterator = post.get_likes()
            if likes_iterator is None:
                return []
            return likes_iterator

        def yield_likers_via_iphone():
            mediaid = getattr(post, "mediaid", None)
            if not mediaid:
                raise RuntimeError(
                    f"Post {post.shortcode} is missing mediaid; cannot fetch likers via iPhone endpoint."
                )
            return iter_post_likers_via_iphone_endpoint(
                loader.context,
                str(mediaid),
                max_attempts=max_attempts,
                backoff_seconds=backoff_seconds,
                session_user=session_user,
            )

        def iter_likers(source_name: str):
            if source_name == "iphone":
                return yield_likers_via_iphone()
            return yield_likers_via_graphql()

        sources: List[str] = []
        if likers_source_normalized == "graphql":
            sources = ["graphql"]
        elif likers_source_normalized == "iphone":
            sources = ["iphone"]
        else:
            if graphql_likers_blocked:
                sources = ["iphone"]
            else:
                sources = ["graphql", "iphone"]

        last_like_error: Optional[Exception] = None
        skip_post_due_to_block = False
        for source_name in sources:
            liker_username = None
            try:
                for liker in iter_likers(source_name):
                    liker_username = getattr(liker, "username", None)
                    if liker_username:
                        if liker_username in per_post_seen_likers:
                            continue
                        per_post_seen_likers.add(liker_username)

                    liker_entry = {
                        "liker_username": liker_username,
                        "liker_id": getattr(liker, "userid", None),
                        "post_shortcode": post.shortcode,
                        "post_date_utc": post.date_utc.isoformat(),
                        "post_caption": post.caption or "",
                    }
                    if "per_post" in modes and per_post_handle:
                        if format_name == "csv":
                            per_post_writer.writerow(liker_entry)  # type: ignore[arg-type]
                        else:
                            write_jsonl_row(per_post_handle, liker_entry)

                    if "unique" in modes or "ghost" in modes:
                        if liker_username and liker_username not in unique_likers:
                            unique_likers[liker_username] = {
                                "liker_username": liker_username,
                                "liker_id": getattr(liker, "userid", None),
                                "first_seen_post": post.shortcode,
                            }
                            new_unique_usernames.add(liker_username)

                last_like_error = None
                break
            except instaloader.exceptions.AbortDownloadException as exc:
                last_like_error = exc
                error_text = str(exc)
                if source_name == "graphql" and likers_source_normalized == "auto":
                    if is_instagram_block_error(error_text) or is_instagram_retry_later_error(
                        error_text
                    ):
                        graphql_likers_blocked = True
                        warnings.append(
                            "GraphQL like list blocked by Instagram; switching to iPhone endpoint "
                            "(tip: rerun with --likers-source iphone)."
                        )
                        continue
                if on_block_normalized == "skip_post":
                    blocked_count += 1
                    skip_post_due_to_block = True
                    warnings.append(
                        f"Skipped {post.shortcode} like export because Instagram blocked the request ({error_text})."
                    )
                    break

                rollback_post_outputs()
                raise RuntimeError(
                    render_instagram_blocked_hint(error_text, session_user=session_user)
                ) from exc
            except instaloader.exceptions.QueryReturnedBadRequestException as exc:
                last_like_error = exc
                if source_name == "graphql" and likers_source_normalized == "auto":
                    error_text = str(exc)
                    if is_instagram_block_error(
                        error_text
                    ) or is_instagram_retry_later_error(error_text):
                        graphql_likers_blocked = True
                        warnings.append(
                            "GraphQL like list blocked by Instagram; switching to iPhone endpoint "
                            "(tip: rerun with --likers-source iphone)."
                        )
                        continue
                    warnings.append(
                        f"GraphQL like list failed for {post.shortcode}; trying iPhone endpoint: {exc}"
                    )
                    continue
                rollback_post_outputs()
                raise
            except instaloader.exceptions.ConnectionException as exc:
                last_like_error = exc
                if source_name == "graphql" and likers_source_normalized == "auto":
                    error_text = str(exc)
                    if is_instagram_block_error(
                        error_text
                    ) or is_instagram_retry_later_error(error_text):
                        graphql_likers_blocked = True
                        warnings.append(
                            "GraphQL like list blocked by Instagram; switching to iPhone endpoint "
                            "(tip: rerun with --likers-source iphone)."
                        )
                        continue
                    warnings.append(
                        f"GraphQL like list connection issue for {post.shortcode}; trying iPhone endpoint: {exc}"
                    )
                    continue
                rollback_post_outputs()
                raise
            except Exception as exc:  # pragma: no cover - defensive
                last_like_error = exc
                if source_name == "graphql" and likers_source_normalized == "auto":
                    warnings.append(
                        f"GraphQL like list failed for {post.shortcode}; trying iPhone endpoint: {exc}"
                    )
                    continue
                rollback_post_outputs()
                raise

        if skip_post_due_to_block:
            rollback_post_outputs()

        if last_like_error is not None and not skip_post_due_to_block:
            log(
                f"Failed to retrieve likes for {post.shortcode}: {last_like_error}",
                level="error",
            )

        processed_posts.add(post.shortcode)
        processed_count += 1

        if not dry_run and checkpoint_path:
            save_checkpoint(checkpoint_path, processed_posts)
            if per_post_handle:
                per_post_handle.flush()
            if unique_handle:
                unique_handle.flush()
            if ghost_handle:
                ghost_handle.flush()

    ghost_count = 0
    if not dry_run and "ghost" in modes:
        if ghost_handle is None:
            ghost_writer, ghost_path, ghost_handle = prepare_writer(
                output_paths.get("ghost"),
                format_name,
                ["username", "user_id"],
                append=append_outputs.get("ghost", False),
            )
        log("Computing ghost followers...", level="info")
        followers = profile.get_followers()
        for follower in followers:
            if follower.username not in unique_likers:
                ghost_entry = {
                    "username": follower.username,
                    "user_id": follower.userid,
                }
                if ghost_handle:
                    if format_name == "csv":
                        ghost_writer.writerow(ghost_entry)  # type: ignore[arg-type]
                    else:
                        write_jsonl_row(ghost_handle, ghost_entry)
                ghost_count += 1

    if not dry_run and "unique" in modes:
        if unique_handle is None:
            unique_writer, unique_path, unique_handle = prepare_writer(
                output_paths.get("unique"),
                format_name,
                ["liker_username", "liker_id", "first_seen_post"],
                append=append_outputs.get("unique", False),
            )
        log("Writing unique likers set...", level="debug")
        for payload in unique_likers.values():
            if unique_handle:
                if format_name == "csv":
                    unique_writer.writerow(payload)  # type: ignore[arg-type]
                else:
                    write_jsonl_row(unique_handle, payload)

    finalize_handles()

    if scanned_posts == 0:
        profile_mediacount = getattr(profile, "mediacount", "unknown")
        warnings.append(
            f"No media found for '{profile.username}' using content types: {', '.join(content_types)} "
            f"(profile.mediacount={profile_mediacount})."
        )
        if profile_mediacount == 0 and not any(
            value in content_types for value in ("saved", "liked")
        ):
            warnings.append(
                "Tip: if you meant posts you saved/liked (not posts you published), rerun with "
                "--content-type saved and/or --content-type liked (requires --user == --session-user)."
            )
    elif processed_count == 0 and skipped_count == 0:
        warnings.append(
            "No posts were processed. Check --since/--until, --post-filter, or --checkpoint, "
            "or run with --debug to inspect Instaloader visibility."
        )

    summary: Dict[str, Any] = {
        "processed_posts": processed_count,
        "skipped_posts": skipped_count,
        "dry_run": dry_run,
        "per_post_output": str(per_post_path) if per_post_handle else None,
        "unique_output": str(unique_path) if unique_handle else None,
        "ghost_output": str(ghost_path) if ghost_handle else None,
        "content_types": content_types,
        "scanned_posts": scanned_posts,
        "profile_mediacount": getattr(profile, "mediacount", None),
        "unique_likers": len(unique_likers),
        "ghost_followers": ghost_count,
        "blocked_posts": blocked_count,
        "dry_run_posts": dry_run_posts,
        "warnings": warnings,
    }

    if download_enabled:
        summary["downloaded_posts"] = downloaded_posts
        summary["download_dir"] = str(download_dir) if download_dir else None

    return summary


def output_has_data_rows(path: Path, format_name: str) -> bool:
    try:
        if not path.exists():
            return False
        with path.open("rb") as handle:
            sample = handle.read(65536)
        if not sample:
            return False
        text = sample.decode("utf-8", errors="ignore")
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        if format_name == "csv":
            return len(lines) > 1
        if format_name == "jsonl":
            return len(lines) > 0
        return True
    except Exception:
        return True


def main():
    config = load_config()
    ensure_instaloader()
    import instaloader

    original_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        debug_mode = bool(config.get("debug"))
        debug_cookie = bool(config.get("debug_cookie"))
        configure_logging(
            debug=debug_mode,
            quiet=bool(config.get("quiet")),
            debug_cookie=debug_cookie,
        )
        target_user = config.get("target_user")
        session_user = config.get("session_user")
        session_file = config.get("session_file")
        refresh = bool(config.get("refresh"))
        dry_run = bool(config.get("dry_run"))
        download_enabled = bool(config.get("download"))
        download_dir = (
            Path(config.get("download_dir")).expanduser()
            if config.get("download_dir")
            else None
        )
        download_file_name_format = normalize_download_file_name_format(
            config.get("download_file_name_format")
        )
        download_file_name_delimiter = normalize_download_file_name_delimiter(
            config.get("download_file_name_delimiter")
        )
        if download_enabled:
            log(
                "Download file naming: "
                + f"delimiter={download_file_name_delimiter!r} "
                + "format="
                + ",".join(download_file_name_format),
                level="debug",
            )
        format_name = config.get("format", "csv")
        modes = config.get("modes") or ["per_post"]
        output_path = (
            Path(config.get("output_path")).expanduser()
            if config.get("output_path")
            else None
        )
        unique_output_path = (
            Path(config.get("unique_output_path")).expanduser()
            if config.get("unique_output_path")
            else None
        )
        ghost_output_path = (
            Path(config.get("ghost_output_path")).expanduser()
            if config.get("ghost_output_path")
            else None
        )
        checkpoint_path = (
            Path(config.get("checkpoint_path")).expanduser()
            if config.get("checkpoint_path")
            else None
        )
        since = parse_datetime(config.get("since"))
        until = parse_datetime(config.get("until"))
        max_posts = config.get("max_posts")
        post_filters = config.get("post_filters") or []
        content_types = config.get("content_types") or ["posts", "reels"]
        likers_source = config.get("likers_source") or "auto"
        on_block = config.get("on_block") or "abort"
        append_outputs = config.get("append_outputs") or {}
        check_login = bool(config.get("check_login"))
        cookie_file = config.get("cookie_file")
        cookie_string = config.get("cookie_string")
        save_session = bool(config.get("save_session"))
        extra_warnings: List[str] = []

        if not target_user or not session_user:
            raise RuntimeError("Both target_user and session_user are required.")

        if format_name not in ("csv", "jsonl"):
            raise RuntimeError("format must be either 'csv' or 'jsonl'.")

        if not refresh and not dry_run:
            for existing_output in [
                output_path,
                unique_output_path,
                ghost_output_path,
            ]:
                if existing_output and existing_output.exists():
                    output_name = "per_post"
                    if existing_output == unique_output_path:
                        output_name = "unique"
                    elif existing_output == ghost_output_path:
                        output_name = "ghost"

                    if bool(append_outputs.get(output_name)):
                        continue

                    if not output_has_data_rows(existing_output, format_name):
                        log(
                            f"Ignoring empty existing output file {existing_output}.",
                            level="warn",
                        )
                        continue

                    raise RuntimeError(
                        f"Output file {existing_output} already exists. Use --refresh to regenerate."
                    )

        if download_enabled and download_dir:
            log(f"Ensuring download directory exists: {download_dir}", level="debug")
            download_dir.mkdir(parents=True, exist_ok=True)

        loader = build_instaloader(
            debug=debug_mode,
            quiet=quiet_mode,
            download_enabled=download_enabled,
            download_dir=download_dir,
        )

        rate_controller = instaloader.RateController(loader.context)
        loader.context.rate_controller = rate_controller

        cookie_values: Dict[str, str] = {}
        cookie_file_path = (
            Path(cookie_file).expanduser() if cookie_file else None
        )
        if cookie_file_path:
            cookie_values.update(load_cookies_from_file(cookie_file_path))
        if cookie_string:
            if cookie_values:
                log(
                    "Cookie string overrides/extends cookies loaded from file.",
                    level="warn",
                )
            cookie_values.update(parse_cookie_string(cookie_string))

        if cookie_values:
            load_session_from_cookies(
                loader,
                session_user=str(session_user),
                cookie_values=cookie_values,
                session_file=session_file,
                save_session=save_session,
            )
        else:
            load_session(loader, session_user, session_file)
        log_instaloader_cookie_snapshot(
            loader, session_user=str(session_user), session_file=session_file
        )

        should_check_login = check_login or debug_mode or debug_cookie
        if should_check_login:
            log("Testing Instaloader session login...", level="debug")
            login_username = None
            login_test_error = None
            try:
                login_username = loader.test_login()
            except Exception as exc:
                login_test_error = str(exc)
                log(f"Failed to test login: {exc}", level="warn")

            content_requires_login = any(
                value in ("saved", "liked") for value in content_types
            )

            context_is_logged_in = bool(
                getattr(getattr(loader, "context", None), "is_logged_in", False)
            )
            if cookie_log_enabled:
                log_cookie(
                    f"test_login={login_username or '<none>'} "
                    f"context_is_logged_in={context_is_logged_in}"
                )

            if not login_username and not context_is_logged_in and not login_test_error:
                login_message = (
                    "Instaloader session appears logged out; re-login with:\n"
                    f"  instaloader --login {session_user}"
                )
                if content_requires_login:
                    raise RuntimeError(login_message)
                log(login_message, level="warn")
            elif not login_username and login_test_error and content_requires_login:
                log(
                    "Unable to verify session login (test_login failed); saved/liked exports may fail. "
                    f"Error: {login_test_error}",
                    level="warn",
                )
            elif login_username and str(login_username) != str(session_user):
                python_executable = sys.executable or "python3"
                log(
                    f"Session belongs to '{login_username}', expected '{session_user}'. "
                    "Recreate your Instaloader session with:\n"
                    f"  {python_executable} -m instaloader --login {session_user}",
                    level="warn",
                )

        content_types_normalized = [
            str(value or "").strip().lower() for value in content_types
        ]
        modes_normalized = [str(value or "").strip().lower() for value in modes]

        profile = None
        try:
            log(f"Loading profile for {target_user}", level="debug")
            profile = instaloader.Profile.from_username(loader.context, target_user)
            log(
                f"Profile loaded: username={profile.username} mediacount={getattr(profile, 'mediacount', None)} "
                f"is_private={getattr(profile, 'is_private', None)}",
                level="debug",
            )
        except Exception as exc:
            error_text = str(exc)
            liked_only = set(content_types_normalized) == {"liked"}
            needs_followers = "ghost" in modes_normalized

            if liked_only and not needs_followers:
                if str(target_user) != str(session_user):
                    raise RuntimeError(
                        "Liked posts require target_user to match session_user."
                    ) from exc

                profile = SimpleNamespace(
                    username=str(target_user),
                    mediacount=None,
                    is_private=None,
                )
                extra_warnings.append(
                    "Unable to load profile metadata (GraphQL blocked); proceeding with iPhone endpoints for liked feed."
                )
                log(extra_warnings[-1] + f" Error: {error_text}", level="warn")

                if str(likers_source).strip().lower() == "auto":
                    likers_source = "iphone"
                    extra_warnings.append(
                        "Forcing likers_source=iphone because GraphQL requests are blocked."
                    )
            else:
                if is_instagram_retry_later_error(error_text):
                    raise RuntimeError(
                        render_instagram_retry_later_hint(
                            error_text, session_user=str(session_user)
                        )
                    ) from exc
                if is_login_required_error(error_text):
                    raise RuntimeError(
                        render_instagram_login_required_hint(
                            error_text, session_user=str(session_user)
                        )
                    ) from exc
                if is_instagram_block_error(error_text):
                    raise RuntimeError(
                        render_instagram_blocked_hint(
                            error_text, session_user=str(session_user)
                        )
                    ) from exc
                raise

        summary = export_posts(
            loader=loader,
            profile=profile,
            content_types=[str(value) for value in content_types],
            session_user=str(session_user),
            modes=modes,
            append_outputs={
                "per_post": bool(append_outputs.get("per_post")),
                "unique": bool(append_outputs.get("unique")),
                "ghost": bool(append_outputs.get("ghost")),
            },
            likers_source=str(likers_source),
            on_block=str(on_block),
            output_paths={
                "per_post": output_path,
                "unique": unique_output_path,
                "ghost": ghost_output_path,
            },
            format_name=format_name,
            since=since,
            until=until,
            max_posts=int(max_posts) if max_posts is not None else None,
            post_filters=post_filters,
            checkpoint_path=checkpoint_path,
            refresh=refresh,
            dry_run=dry_run,
            download_enabled=download_enabled,
            download_dir=download_dir,
            download_file_name_format=download_file_name_format,
            download_file_name_delimiter=download_file_name_delimiter,
            max_attempts=int(config.get("max_attempts") or 3),
            backoff_seconds=int(config.get("backoff_seconds") or 120),
        )

        if extra_warnings:
            warnings = summary.get("warnings")
            if isinstance(warnings, list):
                warnings.extend(extra_warnings)
            else:
                summary["warnings"] = list(extra_warnings)
    finally:
        sys.stdout = original_stdout

    original_stdout.write(json.dumps(summary, ensure_ascii=False) + "\n")
    original_stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        log(str(error), level="error")
        sys.exit(1)
