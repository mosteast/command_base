import argparse
import json
import os
from pathlib import Path
from typing import Iterable

from faster_whisper import WhisperModel

SPEAKER_PREFIX = "Speaker 1: "


def format_timestamp(seconds: float, *, separator: str) -> str:
    milliseconds = int(round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    if separator == ',':
        return f"{hours:02}:{minutes:02}:{secs:02},{millis:03}"
    return f"{hours:02}:{minutes:02}:{secs:02}.{millis:03}"


def ensure_prefix(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("Speaker"):
        return stripped
    return f"{SPEAKER_PREFIX}{stripped}"


def write_srt(segments: Iterable[dict], path: Path) -> None:
    lines = []
    for idx, seg in enumerate(segments, start=1):
        lines.append(str(idx))
        lines.append(
            f"{format_timestamp(seg['start'], separator=',')} --> {format_timestamp(seg['end'], separator=',')}"
        )
        lines.append(ensure_prefix(seg['text']))
        lines.append("")
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def write_vtt(segments: Iterable[dict], path: Path) -> None:
    lines = ["WEBVTT", ""]
    for seg in segments:
        lines.append(
            f"{format_timestamp(seg['start'], separator='.') } --> {format_timestamp(seg['end'], separator='.') }"
        )
        lines.append(ensure_prefix(seg['text']))
        lines.append("")
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def write_txt(segments: Iterable[dict], path: Path) -> None:
    lines = [ensure_prefix(seg['text']) for seg in segments]
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def write_tsv(segments: Iterable[dict], path: Path) -> None:
    lines = [
        "\t".join(
            [
                format_timestamp(seg['start'], separator='.'),
                format_timestamp(seg['end'], separator='.'),
                ensure_prefix(seg['text']),
            ]
        )
        for seg in segments
    ]
    path.write_text("\n".join(lines).strip() + "\n", encoding="utf-8")


def write_json(segments: Iterable[dict], path: Path) -> None:
    payload = [
        {
            "start": seg['start'],
            "end": seg['end'],
            "text": seg['text'].strip(),
            "speaker": SPEAKER_PREFIX.rstrip(': '),
        }
        for seg in segments
    ]
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


WRITERS = {
    'srt': write_srt,
    'vtt': write_vtt,
    'txt': write_txt,
    'tsv': write_tsv,
    'json': write_json,
}


def transcribe(args: argparse.Namespace) -> None:
    device = args.device or 'cpu'
    compute_type = args.compute_type or 'int8'
    model = WhisperModel(
        args.model,
        device=device,
        compute_type=compute_type,
        download_root=args.model_dir,
    )

    segments_iter, _ = model.transcribe(
        args.audio,
        beam_size=args.beam_size or 5,
        temperature=args.temperature,
        language=args.language,
        task=args.task,
    )

    collected = [
        {
            'start': float(seg.start),
            'end': float(seg.end),
            'text': seg.text or '',
        }
        for seg in segments_iter
    ]

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    writers = [WRITERS[f] for f in args.formats if f in WRITERS]
    for fmt, writer in zip(args.formats, writers):
        out_path = output_dir / f"{args.base_name}.{fmt}"
        writer(collected, out_path)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description='Transcribe audio with faster-whisper')
    parser.add_argument('--audio', required=True)
    parser.add_argument('--model', required=True)
    parser.add_argument('--output-dir', required=True)
    parser.add_argument('--base-name', required=True)
    parser.add_argument('--formats', required=True)
    parser.add_argument('--device')
    parser.add_argument('--compute-type')
    parser.add_argument('--language')
    parser.add_argument('--task')
    parser.add_argument('--beam-size', type=int)
    parser.add_argument('--temperature', type=float)
    parser.add_argument('--model-dir')
    return parser.parse_args()


if __name__ == '__main__':
    arguments = parse_args()
    arguments.formats = [fmt.strip().lower() for fmt in arguments.formats.split(',') if fmt.strip()]
    transcribe(arguments)
