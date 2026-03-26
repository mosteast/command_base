#!/usr/bin/env python3

import argparse
import sys
import wave
from typing import Any, Optional

from transcribe_output_utils import write_outputs

DEPENDENCY_ERROR_CODE = 20
TIMESTAMP_ERROR_CODE = 21
TASK_ERROR_CODE = 22


def fail(prefix: str, message: str, code: int) -> None:
    print(f"{prefix}:{message}", file=sys.stderr)
    raise SystemExit(code)


def import_dependencies():
    try:
        import torch
    except ModuleNotFoundError:
        torch = None

    try:
        from funasr import AutoModel
        from funasr.utils.postprocess_utils import rich_transcription_postprocess
    except ModuleNotFoundError as error:
        fail(
            "TRANSCRIBE_DEPENDENCY_MISSING",
            f"SenseVoice dependency missing ({error.name}). Install with: pip install -U funasr",
            DEPENDENCY_ERROR_CODE,
        )

    return torch, AutoModel, rich_transcription_postprocess


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio with SenseVoice.")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--base-name", required=True)
    parser.add_argument("--formats", required=True)
    parser.add_argument("--language")
    parser.add_argument("--task", default="transcribe")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--batch-size-s", type=int, default=60)
    parser.add_argument("--merge-length-s", type=int, default=15)
    parser.add_argument("--disable-vad", action="store_true")
    parser.add_argument("--disable-itn", action="store_true")
    return parser.parse_args()


def resolve_device(requested_device: str, torch_module: Any) -> str:
    normalized = (requested_device or "auto").strip().lower()
    if normalized and normalized != "auto":
        return requested_device
    if torch_module is not None and torch_module.cuda.is_available():
        return "cuda:0"
    backends = getattr(torch_module, "backends", None)
    mps_backend = getattr(backends, "mps", None)
    if mps_backend and mps_backend.is_available():
        return "mps"
    return "cpu"


def normalize_language(language: Optional[str]) -> str:
    if language is None:
        return "auto"
    normalized = language.strip().lower()
    if not normalized:
        return "auto"
    alias_map = {
        "auto": "auto",
        "zh": "zh",
        "zh-cn": "zh",
        "en": "en",
        "yue": "yue",
        "ja": "ja",
        "ko": "ko",
        "nospeech": "nospeech",
    }
    return alias_map.get(normalized, language)


def value_from_object(item: Any, *keys: str):
    for key in keys:
        if isinstance(item, dict) and key in item:
            return item[key]
        if hasattr(item, key):
            return getattr(item, key)
    return None


def parse_timestamp_item(item: Any) -> Optional[dict]:
    if item is None:
        return None
    if isinstance(item, (list, tuple)) and len(item) >= 3:
        start_time, end_time, text = item[0], item[1], item[2]
        return {"start": float(start_time), "end": float(end_time), "text": text}

    text = value_from_object(item, "text", "sentence", "token")
    start_time = value_from_object(item, "start", "start_time", "begin")
    end_time = value_from_object(item, "end", "end_time", "finish")
    if text is None or start_time is None or end_time is None:
        return None
    return {"start": float(start_time), "end": float(end_time), "text": text}


def resolve_audio_duration(audio_path: str) -> float:
    try:
        with wave.open(audio_path, "rb") as wave_file:
            frame_count = wave_file.getnframes()
            sample_rate = wave_file.getframerate()
            if sample_rate and frame_count:
                return float(frame_count) / float(sample_rate)
    except Exception:
        pass

    try:
        import torchaudio

        metadata = torchaudio.info(audio_path)
        if metadata.sample_rate and metadata.num_frames:
            return float(metadata.num_frames) / float(metadata.sample_rate)
    except Exception:
        return 0.0
    return 0.0


def extract_segments(
    result: dict,
    processed_text: str,
    needs_timestamps: bool,
    audio_path: str,
) -> list[dict]:
    if not needs_timestamps:
        return [{"start": 0.0, "end": 0.0, "text": processed_text}]

    for key in ("sentence_info", "sentence_timestamp", "segments", "timestamp", "timestamps"):
        candidate = result.get(key)
        if not isinstance(candidate, list):
            continue
        parsed_segments = []
        for item in candidate:
            parsed_segment = parse_timestamp_item(item)
            if parsed_segment:
                parsed_segments.append(parsed_segment)
        if parsed_segments:
            return parsed_segments
    duration = max(resolve_audio_duration(audio_path), 0.1)
    print(
        "TRANSCRIBE_TIMESTAMPS_FALLBACK:SenseVoice did not return timestamps; using a single full-length segment.",
        file=sys.stderr,
    )
    return [{"start": 0.0, "end": duration, "text": processed_text}]


def transcribe(args: argparse.Namespace) -> None:
    if (args.task or "transcribe").strip().lower() != "transcribe":
        fail(
            "TRANSCRIBE_UNSUPPORTED_TASK",
            "SenseVoice only supports transcription in this command.",
            TASK_ERROR_CODE,
        )

    torch_module, auto_model_cls, postprocess = import_dependencies()
    device = resolve_device(args.device, torch_module)
    language = normalize_language(args.language)
    needs_timestamps = any(
        fmt in {"srt", "vtt", "tsv", "json"} for fmt in args.formats
    )

    model_kwargs = {
        "model": args.model,
        "trust_remote_code": True,
        "device": device,
    }
    if not args.disable_vad:
        model_kwargs["vad_model"] = "fsmn-vad"
        model_kwargs["vad_kwargs"] = {"max_single_segment_time": 30000}

    model = auto_model_cls(**model_kwargs)
    generate_kwargs = {
        "input": args.audio,
        "cache": {},
        "language": language,
        "use_itn": not args.disable_itn,
    }
    if not args.disable_vad:
        generate_kwargs["batch_size_s"] = args.batch_size_s
        generate_kwargs["merge_vad"] = True
        generate_kwargs["merge_length_s"] = args.merge_length_s
    else:
        generate_kwargs["batch_size"] = 1

    results = model.generate(**generate_kwargs)
    if isinstance(results, list):
        result = results[0]
    else:
        result = results

    processed_text = postprocess(result.get("text", ""))
    segments = extract_segments(result, processed_text, needs_timestamps, args.audio)
    write_outputs(
        segments=segments,
        output_dir=args.output_dir,
        base_name=args.base_name,
        formats=args.formats,
    )


if __name__ == "__main__":
    parsed_args = parse_args()
    parsed_args.formats = [
        fmt.strip().lower() for fmt in parsed_args.formats.split(",") if fmt.strip()
    ]
    transcribe(parsed_args)
