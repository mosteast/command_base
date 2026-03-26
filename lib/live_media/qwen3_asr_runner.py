#!/usr/bin/env python3

import argparse
import os
import sys
import time
from typing import Any, Optional

from transcribe_output_utils import write_outputs

DEPENDENCY_ERROR_CODE = 20
TIMESTAMP_ERROR_CODE = 21
TASK_ERROR_CODE = 22
DEVICE_ERROR_CODE = 23
MODEL_INIT_RETRY_COUNT = 3


def fail(prefix: str, message: str, code: int) -> None:
    print(f"{prefix}:{message}", file=sys.stderr)
    raise SystemExit(code)


def import_dependencies():
    try:
        import torch
    except ModuleNotFoundError as error:
        fail(
            "TRANSCRIBE_DEPENDENCY_MISSING",
            f"qwen-asr dependency missing ({error.name}). Install with: pip install -U qwen-asr",
            DEPENDENCY_ERROR_CODE,
        )

    try:
        from qwen_asr import Qwen3ASRModel
    except ModuleNotFoundError as error:
        fail(
            "TRANSCRIBE_DEPENDENCY_MISSING",
            f"qwen-asr dependency missing ({error.name}). Install with: pip install -U qwen-asr",
            DEPENDENCY_ERROR_CODE,
        )

    return torch, Qwen3ASRModel


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Transcribe audio with Qwen3-ASR.")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--base-name", required=True)
    parser.add_argument("--formats", required=True)
    parser.add_argument("--language")
    parser.add_argument("--task", default="transcribe")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--dtype", default="auto")
    parser.add_argument("--backend", default="transformers")
    parser.add_argument("--aligner-model", default="Qwen/Qwen3-ForcedAligner-0.6B")
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--max-inference-batch-size", type=int, default=8)
    parser.add_argument("--gpu-memory-utilization", type=float, default=0.7)
    return parser.parse_args()


def resolve_device(requested_device: str, torch_module: Any) -> str:
    normalized = (requested_device or "auto").strip().lower()
    if normalized and normalized != "auto":
        return requested_device
    if torch_module.cuda.is_available():
        return "cuda:0"
    backends = getattr(torch_module, "backends", None)
    mps_backend = getattr(backends, "mps", None)
    if mps_backend and mps_backend.is_available():
        return "mps"
    return "cpu"


def resolve_dtype(requested_dtype: str, device: str, torch_module: Any):
    normalized = (requested_dtype or "auto").strip().lower()
    dtype_map = {
        "auto": None,
        "bfloat16": torch_module.bfloat16,
        "bf16": torch_module.bfloat16,
        "float16": torch_module.float16,
        "fp16": torch_module.float16,
        "float32": torch_module.float32,
        "fp32": torch_module.float32,
    }
    if normalized not in dtype_map:
        fail(
            "TRANSCRIBE_INVALID_ARGUMENT",
            f"Unsupported Qwen dtype '{requested_dtype}'.",
            DEVICE_ERROR_CODE,
        )
    if dtype_map[normalized] is not None:
        return dtype_map[normalized]
    if device.startswith("cuda"):
        return torch_module.bfloat16
    return torch_module.float32


def normalize_language(language: Optional[str]) -> Optional[str]:
    if language is None:
        return None
    normalized = language.strip().lower()
    if not normalized or normalized == "auto":
        return None
    language_map = {
        "ar": "Arabic",
        "arabic": "Arabic",
        "cs": "Czech",
        "czech": "Czech",
        "da": "Danish",
        "danish": "Danish",
        "de": "German",
        "german": "German",
        "el": "Greek",
        "greek": "Greek",
        "en": "English",
        "english": "English",
        "es": "Spanish",
        "spanish": "Spanish",
        "fa": "Persian",
        "persian": "Persian",
        "fi": "Finnish",
        "finnish": "Finnish",
        "fil": "Filipino",
        "filipino": "Filipino",
        "fr": "French",
        "french": "French",
        "hi": "Hindi",
        "hindi": "Hindi",
        "hu": "Hungarian",
        "hungarian": "Hungarian",
        "id": "Indonesian",
        "indonesian": "Indonesian",
        "it": "Italian",
        "italian": "Italian",
        "ja": "Japanese",
        "japanese": "Japanese",
        "ko": "Korean",
        "korean": "Korean",
        "mk": "Macedonian",
        "macedonian": "Macedonian",
        "ms": "Malay",
        "malay": "Malay",
        "nl": "Dutch",
        "dutch": "Dutch",
        "pl": "Polish",
        "polish": "Polish",
        "pt": "Portuguese",
        "portuguese": "Portuguese",
        "ro": "Romanian",
        "romanian": "Romanian",
        "ru": "Russian",
        "russian": "Russian",
        "sv": "Swedish",
        "swedish": "Swedish",
        "th": "Thai",
        "thai": "Thai",
        "tr": "Turkish",
        "turkish": "Turkish",
        "vi": "Vietnamese",
        "vietnamese": "Vietnamese",
        "yue": "Cantonese",
        "cantonese": "Cantonese",
        "zh": "Chinese",
        "zh-cn": "Chinese",
        "zh-hans": "Chinese",
        "chinese": "Chinese",
    }
    return language_map.get(normalized, language)


def value_from_object(item: Any, *keys: str):
    for key in keys:
        if isinstance(item, dict) and key in item:
            return item[key]
        if hasattr(item, key):
            return getattr(item, key)
    return None


def build_segments(result: Any, needs_timestamps: bool) -> list[dict]:
    text = value_from_object(result, "text") or ""
    timestamps = value_from_object(result, "time_stamps", "timestamps")

    if not needs_timestamps:
        return [{"start": 0.0, "end": 0.0, "text": text}]

    if not timestamps:
        fail(
            "TRANSCRIBE_TIMESTAMPS_UNAVAILABLE",
            "Qwen3-ASR did not return timestamps. Ensure the forced aligner is available.",
            TIMESTAMP_ERROR_CODE,
        )

    segments = []
    for item in timestamps:
      item_text = value_from_object(item, "text", "token", "sentence") or text
      start_time = value_from_object(item, "start_time", "start", "begin")
      end_time = value_from_object(item, "end_time", "end", "finish")
      if start_time is None or end_time is None:
          continue
      segments.append(
          {
              "start": float(start_time),
              "end": float(end_time),
              "text": item_text,
          }
      )

    if not segments:
        fail(
            "TRANSCRIBE_TIMESTAMPS_UNAVAILABLE",
            "Qwen3-ASR returned an empty timestamp list.",
            TIMESTAMP_ERROR_CODE,
        )

    return segments


def build_model(args: argparse.Namespace, torch_module: Any, qwen_model_cls: Any, device: str):
    dtype = resolve_dtype(args.dtype, device, torch_module)
    needs_timestamps = any(
        fmt in {"srt", "vtt", "tsv", "json"} for fmt in args.formats
    )

    if args.backend == "vllm":
        if not device.startswith("cuda"):
            fail(
                "TRANSCRIBE_INVALID_ARGUMENT",
                "Qwen3-ASR vLLM backend requires a CUDA device.",
                DEVICE_ERROR_CODE,
            )
        visible_device = device.split(":", 1)[1] if ":" in device else "0"
        os.environ["CUDA_VISIBLE_DEVICES"] = visible_device
        init_kwargs = {
            "model": args.model,
            "gpu_memory_utilization": args.gpu_memory_utilization,
            "max_inference_batch_size": args.max_inference_batch_size,
            "max_new_tokens": args.max_new_tokens,
        }
        if needs_timestamps:
            init_kwargs["forced_aligner"] = args.aligner_model
            init_kwargs["forced_aligner_kwargs"] = {
                "dtype": dtype,
                "device_map": "cuda:0",
            }
        return qwen_model_cls.LLM(**init_kwargs), needs_timestamps

    init_kwargs = {
        "dtype": dtype,
        "device_map": device,
        "max_inference_batch_size": args.max_inference_batch_size,
        "max_new_tokens": args.max_new_tokens,
    }
    if needs_timestamps:
        init_kwargs["forced_aligner"] = args.aligner_model
        init_kwargs["forced_aligner_kwargs"] = {
            "dtype": dtype,
            "device_map": device,
        }
    return qwen_model_cls.from_pretrained(args.model, **init_kwargs), needs_timestamps


def is_transient_model_download_error(error: Exception) -> bool:
    error_message = str(error)
    transient_markers = (
        "ChunkedEncodingError",
        "IncompleteRead",
        "Connection broken",
        "ReadTimeout",
        "Temporary failure in name resolution",
        "ConnectionResetError",
    )
    return any(marker in error_message for marker in transient_markers)


def build_model_with_retry(
    args: argparse.Namespace,
    torch_module: Any,
    qwen_model_cls: Any,
    device: str,
):
    last_error = None
    for attempt_index in range(1, MODEL_INIT_RETRY_COUNT + 1):
        try:
            return build_model(args, torch_module, qwen_model_cls, device)
        except Exception as error:
            last_error = error
            if (
                attempt_index >= MODEL_INIT_RETRY_COUNT
                or not is_transient_model_download_error(error)
            ):
                raise
            print(
                f"TRANSCRIBE_RETRY:Qwen3-ASR model download failed on attempt {attempt_index}; retrying...",
                file=sys.stderr,
            )
            time.sleep(attempt_index * 3)
    raise last_error


def transcribe(args: argparse.Namespace) -> None:
    if (args.task or "transcribe").strip().lower() != "transcribe":
        fail(
            "TRANSCRIBE_UNSUPPORTED_TASK",
            "Qwen3-ASR only supports transcription in this command.",
            TASK_ERROR_CODE,
    )

    torch_module, qwen_model_cls = import_dependencies()
    device = resolve_device(args.device, torch_module)
    model, needs_timestamps = build_model_with_retry(
        args,
        torch_module,
        qwen_model_cls,
        device,
    )
    language = normalize_language(args.language)
    results = model.transcribe(
        audio=args.audio,
        language=language,
        return_time_stamps=needs_timestamps,
    )
    result = results[0] if isinstance(results, list) else results
    segments = build_segments(result, needs_timestamps)
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
