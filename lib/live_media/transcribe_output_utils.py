import json
from pathlib import Path
from typing import Iterable

SPEAKER_PREFIX = "Speaker 1: "
TIMED_FORMATS = {"srt", "vtt", "tsv", "json"}


def format_timestamp(seconds: float, *, separator: str) -> str:
    milliseconds = int(round(float(seconds) * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    if separator == ",":
        return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"
    return f"{hours:02}:{minutes:02}:{secs:02}.{millis:03}"


def ensure_prefix(text: str) -> str:
    stripped = (text or "").strip()
    if not stripped:
        return ""
    if stripped.startswith("Speaker"):
        return stripped
    return f"{SPEAKER_PREFIX}{stripped}"


def validate_segments(segments: Iterable[dict], formats: list[str]) -> list[dict]:
    collected = []
    require_timestamps = any(fmt in TIMED_FORMATS for fmt in formats)
    for segment in segments:
        if not segment:
            continue
        text = ensure_prefix(segment.get("text", ""))
        if not text:
            continue
        start = segment.get("start")
        end = segment.get("end")
        if require_timestamps and (start is None or end is None):
            raise ValueError(
                "Timestamped transcript formats require segment start/end times."
            )
        collected.append(
            {
                "start": float(start) if start is not None else None,
                "end": float(end) if end is not None else None,
                "text": text,
            }
        )
    if not collected:
        raise ValueError("No transcript segments were produced.")
    return collected


def write_srt(segments: list[dict], path: Path) -> None:
    lines = []
    for idx, segment in enumerate(segments, start=1):
        lines.append(str(idx))
        lines.append(
            f"{format_timestamp(segment['start'], separator=',')} --> {format_timestamp(segment['end'], separator=',')}"
        )
        lines.append(segment["text"])
        lines.append("")
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def write_vtt(segments: list[dict], path: Path) -> None:
    lines = ["WEBVTT", ""]
    for segment in segments:
        lines.append(
            f"{format_timestamp(segment['start'], separator='.')} --> {format_timestamp(segment['end'], separator='.')}"
        )
        lines.append(segment["text"])
        lines.append("")
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def write_txt(segments: list[dict], path: Path) -> None:
    lines = [segment["text"] for segment in segments]
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def write_tsv(segments: list[dict], path: Path) -> None:
    lines = [
        "\t".join(
            [
                format_timestamp(segment["start"], separator="."),
                format_timestamp(segment["end"], separator="."),
                segment["text"],
            ]
        )
        for segment in segments
    ]
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def write_json(segments: list[dict], path: Path) -> None:
    payload = [
        {
            "start": segment["start"],
            "end": segment["end"],
            "text": segment["text"],
            "speaker": SPEAKER_PREFIX.rstrip(": "),
        }
        for segment in segments
    ]
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


WRITERS = {
    "json": write_json,
    "srt": write_srt,
    "tsv": write_tsv,
    "txt": write_txt,
    "vtt": write_vtt,
}


def write_outputs(
    *,
    segments: Iterable[dict],
    output_dir: str,
    base_name: str,
    formats: list[str],
) -> None:
    normalized_formats = [fmt.strip().lower() for fmt in formats if fmt.strip()]
    validated_segments = validate_segments(segments, normalized_formats)
    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    for fmt in normalized_formats:
        writer = WRITERS.get(fmt)
        if not writer:
            continue
        writer(validated_segments, target_dir / f"{base_name}.{fmt}")
