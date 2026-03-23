#!/usr/bin/env python3

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass
from pathlib import Path
import xml.etree.ElementTree as et


DEFAULT_WIDTH = 1920
DEFAULT_HEIGHT = 1080
DEFAULT_SCROLL_DURATION = 12.0
DEFAULT_STATIC_DURATION = 5.0
DEFAULT_FONT_NAME = "PingFang SC"
DEFAULT_BASE_FONT_SIZE = 36
DEFAULT_TRACK_STEP = 46
DEFAULT_TOP_MARGIN = 36
DEFAULT_BOTTOM_MARGIN = 36

SCROLL_MODES = {1, 2, 3}
BOTTOM_MODE = 4
TOP_MODE = 5
REVERSE_MODE = 6


@dataclass
class Danmaku_entry:
    start_time: float
    mode: int
    font_size: int
    color: int
    text: str


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="danmaku_xml_to_ass.py",
        description="Convert Bilibili danmaku XML files into ASS subtitle files.",
    )
    parser.add_argument("input_path", type=Path, help="Input danmaku XML file")
    parser.add_argument("output_path", type=Path, help="Output ASS file")
    parser.add_argument(
        "--width",
        type=int,
        default=DEFAULT_WIDTH,
        help=f"ASS PlayResX value (default: {DEFAULT_WIDTH})",
    )
    parser.add_argument(
        "--height",
        type=int,
        default=DEFAULT_HEIGHT,
        help=f"ASS PlayResY value (default: {DEFAULT_HEIGHT})",
    )
    parser.add_argument(
        "--font-name",
        default=DEFAULT_FONT_NAME,
        help=f"Font name for generated ASS styles (default: {DEFAULT_FONT_NAME})",
    )
    parser.add_argument(
        "--base-font-size",
        type=int,
        default=DEFAULT_BASE_FONT_SIZE,
        help=f"Base ASS style font size (default: {DEFAULT_BASE_FONT_SIZE})",
    )
    parser.add_argument(
        "--scroll-duration",
        type=float,
        default=DEFAULT_SCROLL_DURATION,
        help=f"Scroll danmaku duration in seconds (default: {DEFAULT_SCROLL_DURATION})",
    )
    parser.add_argument(
        "--static-duration",
        type=float,
        default=DEFAULT_STATIC_DURATION,
        help=f"Top/bottom danmaku duration in seconds (default: {DEFAULT_STATIC_DURATION})",
    )
    return parser


def ass_escape(text: str) -> str:
    return (
        text.replace("\\", r"\\")
        .replace("{", r"\{")
        .replace("}", r"\}")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\n", r"\N")
    )


def format_ass_timestamp(seconds: float) -> str:
    clamped = max(0.0, seconds)
    hours = int(clamped // 3600)
    minutes = int((clamped % 3600) // 60)
    whole_seconds = int(clamped % 60)
    centiseconds = int(round((clamped - math.floor(clamped)) * 100))
    if centiseconds == 100:
        whole_seconds += 1
        centiseconds = 0
    if whole_seconds == 60:
        minutes += 1
        whole_seconds = 0
    if minutes == 60:
        hours += 1
        minutes = 0
    return f"{hours}:{minutes:02d}:{whole_seconds:02d}.{centiseconds:02d}"


def bilibili_color_to_ass(color_value: int) -> str:
    red = (color_value >> 16) & 0xFF
    green = (color_value >> 8) & 0xFF
    blue = color_value & 0xFF
    return f"&H00{blue:02X}{green:02X}{red:02X}"


def estimate_text_width(text: str, font_size: int) -> int:
    logical_lines = text.replace(r"\N", "\n").splitlines() or [text]
    max_line_length = max((len(line) for line in logical_lines), default=1)
    return max(font_size, int(max_line_length * font_size * 0.58))


def parse_danmaku_entries(input_path: Path) -> list[Danmaku_entry]:
    root = et.parse(input_path).getroot()
    entries: list[Danmaku_entry] = []
    for node in root.findall("d"):
        raw_spec = node.get("p", "")
        text = ass_escape((node.text or "").strip())
        if not raw_spec or not text:
            continue
        parts = raw_spec.split(",")
        if len(parts) < 4:
            continue
        try:
            start_time = float(parts[0])
            mode = int(float(parts[1]))
            font_size = max(12, int(float(parts[2])))
            color = int(float(parts[3]))
        except ValueError:
            continue
        entries.append(
            Danmaku_entry(
                start_time=start_time,
                mode=mode,
                font_size=font_size,
                color=color,
                text=text,
            )
        )
    entries.sort(key=lambda item: item.start_time)
    return entries


def build_header(width: int, height: int, font_name: str, base_font_size: int) -> str:
    return "\n".join(
        [
            "[Script Info]",
            "ScriptType: v4.00+",
            "WrapStyle: 2",
            "ScaledBorderAndShadow: yes",
            f"PlayResX: {width}",
            f"PlayResY: {height}",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
            f"Style: Danmaku,{font_name},{base_font_size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,2,0,7,20,20,20,134",
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
        ]
    )


def find_track_index(track_free_times: list[float], start_time: float) -> int:
    for index, free_time in enumerate(track_free_times):
        if free_time <= start_time:
            return index
    return min(range(len(track_free_times)), key=lambda item: track_free_times[item])


def build_dialogues(
    entries: list[Danmaku_entry],
    width: int,
    height: int,
    scroll_duration: float,
    static_duration: float,
) -> list[str]:
    max_scroll_tracks = max(1, (height - DEFAULT_TOP_MARGIN - DEFAULT_BOTTOM_MARGIN) // DEFAULT_TRACK_STEP)
    max_top_tracks = max(1, height // (DEFAULT_TRACK_STEP * 2))
    max_bottom_tracks = max(1, height // (DEFAULT_TRACK_STEP * 2))

    scroll_track_free_times = [0.0] * max_scroll_tracks
    top_track_free_times = [0.0] * max_top_tracks
    bottom_track_free_times = [0.0] * max_bottom_tracks

    dialogues: list[str] = []
    for entry in entries:
        start_text = format_ass_timestamp(entry.start_time)
        color_text = bilibili_color_to_ass(entry.color)
        font_size = max(12, entry.font_size)
        text_width = estimate_text_width(entry.text, font_size)
        override_prefix = f"{{\\fs{font_size}\\c{color_text}}}"

        if entry.mode in SCROLL_MODES:
            track_index = find_track_index(scroll_track_free_times, entry.start_time)
            y_pos = DEFAULT_TOP_MARGIN + track_index * DEFAULT_TRACK_STEP
            end_time = entry.start_time + scroll_duration
            scroll_track_free_times[track_index] = end_time
            start_x = width + text_width
            end_x = -text_width
            override = f"{override_prefix}{{\\an7\\move({start_x},{y_pos},{end_x},{y_pos})}}"
        elif entry.mode == BOTTOM_MODE:
            track_index = find_track_index(bottom_track_free_times, entry.start_time)
            y_pos = height - DEFAULT_BOTTOM_MARGIN - track_index * DEFAULT_TRACK_STEP
            end_time = entry.start_time + static_duration
            bottom_track_free_times[track_index] = end_time
            override = f"{override_prefix}{{\\an2\\pos({width // 2},{y_pos})}}"
        elif entry.mode == TOP_MODE:
            track_index = find_track_index(top_track_free_times, entry.start_time)
            y_pos = DEFAULT_TOP_MARGIN + track_index * DEFAULT_TRACK_STEP
            end_time = entry.start_time + static_duration
            top_track_free_times[track_index] = end_time
            override = f"{override_prefix}{{\\an8\\pos({width // 2},{y_pos})}}"
        elif entry.mode == REVERSE_MODE:
            track_index = find_track_index(scroll_track_free_times, entry.start_time)
            y_pos = DEFAULT_TOP_MARGIN + track_index * DEFAULT_TRACK_STEP
            end_time = entry.start_time + scroll_duration
            scroll_track_free_times[track_index] = end_time
            start_x = -text_width
            end_x = width + text_width
            override = f"{override_prefix}{{\\an7\\move({start_x},{y_pos},{end_x},{y_pos})}}"
        else:
            track_index = find_track_index(top_track_free_times, entry.start_time)
            y_pos = DEFAULT_TOP_MARGIN + track_index * DEFAULT_TRACK_STEP
            end_time = entry.start_time + static_duration
            top_track_free_times[track_index] = end_time
            override = f"{override_prefix}{{\\an8\\pos({width // 2},{y_pos})}}"

        end_text = format_ass_timestamp(end_time)
        dialogues.append(
            f"Dialogue: 2,{start_text},{end_text},Danmaku,,0,0,0,,{override}{entry.text}"
        )
    return dialogues


def convert_file(
    input_path: Path,
    output_path: Path,
    width: int,
    height: int,
    font_name: str,
    base_font_size: int,
    scroll_duration: float,
    static_duration: float,
) -> None:
    entries = parse_danmaku_entries(input_path)
    ass_lines = [build_header(width, height, font_name, base_font_size)]
    ass_lines.extend(
        build_dialogues(entries, width, height, scroll_duration, static_duration)
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text("\n".join(ass_lines) + "\n", encoding="utf-8-sig")


def main() -> int:
    parser = build_argument_parser()
    args = parser.parse_args()
    convert_file(
        input_path=args.input_path,
        output_path=args.output_path,
        width=args.width,
        height=args.height,
        font_name=args.font_name,
        base_font_size=args.base_font_size,
        scroll_duration=args.scroll_duration,
        static_duration=args.static_duration,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
