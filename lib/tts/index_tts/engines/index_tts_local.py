#!/usr/bin/env python3
"""Thin wrapper to run IndexTTS2 inference from the text_to_speech CLI."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import List, Optional


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Execute IndexTTS2 locally for offline text-to-speech.",
    )
    parser.add_argument("--text", required=True, help="Text to synthesize.")
    parser.add_argument("--out", required=True, help="Destination WAV path.")
    parser.add_argument("--home", required=True, help="Path to the local index-tts checkout.")
    parser.add_argument("--checkpoints", required=True, help="IndexTTS checkpoints directory.")
    parser.add_argument("--config", required=True, help="Path to config.yaml.")
    parser.add_argument("--voice", required=True, help="Speaker reference WAV path.")
    parser.add_argument("--emo-audio", help="Optional emotion reference WAV path.")
    parser.add_argument("--emo-text", help="Optional emotion guidance text.")
    parser.add_argument("--emo-vector", help="Optional JSON or comma separated emotion vector (8 floats).")
    parser.add_argument("--emo-alpha", type=float, default=1.0, help="Blend strength for emotion prompts (0-1).")
    parser.add_argument("--use-fp16", action="store_true", help="Enable FP16 when supported.")
    parser.add_argument("--use-deepspeed", action="store_true", help="Enable DeepSpeed acceleration.")
    parser.add_argument("--use-cuda-kernel", action="store_true", help="Enable CUDA fused kernels when available.")
    parser.add_argument("--use-random", action="store_true", help="Enable stochastic sampling.")
    parser.add_argument(
        "--max-text-segment",
        type=int,
        default=120,
        help="Maximum text tokens per segment during inference.",
    )
    parser.add_argument(
        "--more-segment-before",
        type=int,
        default=0,
        help="Advanced segmentation knob forwarded to IndexTTS.",
    )
    parser.add_argument("--verbose", action="store_true", help="Print verbose inference diagnostics.")
    parser.add_argument("--device", help="Explicit torch device override (cuda:0, cpu, mps, ...).")
    return parser.parse_args()


def ensure_path(path: Path, description: str, is_dir: bool = False) -> Path:
    if is_dir:
        if not path.is_dir():
            raise FileNotFoundError(f"{description} '{path}' is not a directory.")
    else:
        if not path.is_file():
            raise FileNotFoundError(f"{description} '{path}' does not exist.")
    return path


def parse_emo_vector(raw: Optional[str]) -> Optional[List[float]]:
    if not raw:
        return None
    raw = raw.strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        parsed = [token for token in raw.replace("[", "").replace("]", "").split(",") if token.strip()]
    if not isinstance(parsed, list):
        raise ValueError("Emotion vector must decode to a list of floats.")
    floats: List[float] = []
    for item in parsed:
        try:
            floats.append(float(item))
        except (TypeError, ValueError) as error:
            raise ValueError("Emotion vector contains non-numeric values.") from error
    if len(floats) != 8:
        raise ValueError("Emotion vector must contain exactly 8 numeric entries.")
    return floats


def bootstrap_environment(home: Path) -> None:
    if str(home) not in sys.path:
        sys.path.insert(0, str(home))
    src_dir = home / "src"
    if src_dir.exists() and str(src_dir) not in sys.path:
        sys.path.insert(0, str(src_dir))


def main() -> None:
    try:
        args = parse_arguments()
        run(args)
    except KeyboardInterrupt:
        print("IndexTTS: interrupted", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:  # noqa: BLE001
        print(f"IndexTTS error: {exc}", file=sys.stderr)
        sys.exit(1)


def run(args: argparse.Namespace) -> None:
    text = args.text.strip()
    if not text:
        raise ValueError("Text prompt is empty.")

    home = ensure_path(Path(args.home).expanduser().resolve(), "IndexTTS home", is_dir=True)
    checkpoints = ensure_path(Path(args.checkpoints).expanduser().resolve(), "IndexTTS checkpoints", is_dir=True)
    config = ensure_path(Path(args.config).expanduser().resolve(), "IndexTTS config")
    voice = ensure_path(Path(args.voice).expanduser().resolve(), "Speaker reference")
    emo_audio = Path(args.emo_audio).expanduser().resolve() if args.emo_audio else None
    if emo_audio:
        ensure_path(emo_audio, "Emotion reference")

    if not 0.0 <= args.emo_alpha <= 1.0:
        raise ValueError("--emo-alpha must be between 0.0 and 1.0.")
    if args.max_text_segment <= 0:
        raise ValueError("--max-text-segment must be greater than zero.")

    emo_vector = parse_emo_vector(args.emo_vector)
    use_emo_text = bool(args.emo_text and args.emo_text.strip())

    output_path = Path(args.out).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    bootstrap_environment(home)

    try:
        from indextts.infer_v2 import IndexTTS2  # type: ignore
    except ImportError as error:  # pragma: no cover - depends on user environment
        raise RuntimeError(
            "IndexTTS2 dependencies are missing. Run `uv sync --all-extras` inside the index-tts repo."
        ) from error

    os.environ.setdefault("HF_HOME", str(checkpoints / "hf_cache"))
    os.environ.setdefault("HF_HUB_CACHE", str(checkpoints / "hf_cache"))
    os.environ.setdefault("HUGGINGFACE_HUB_CACHE", str(checkpoints / "hf_cache"))

    tts = IndexTTS2(
        cfg_path=str(config),
        model_dir=str(checkpoints),
        use_fp16=bool(args.use_fp16),
        device=args.device,
        use_cuda_kernel=bool(args.use_cuda_kernel),
        use_deepspeed=bool(args.use_deepspeed),
    )

    infer_kwargs = {
        "spk_audio_prompt": str(voice),
        "text": text,
        "output_path": str(output_path),
        "emo_audio_prompt": str(emo_audio) if emo_audio else None,
        "emo_alpha": float(args.emo_alpha),
        "emo_vector": emo_vector,
        "use_emo_text": use_emo_text,
        "emo_text": args.emo_text.strip() if use_emo_text else None,
        "use_random": bool(args.use_random),
        "interval_silence": 200,
        "verbose": bool(args.verbose),
        "max_text_tokens_per_segment": int(args.max_text_segment),
        "more_segment_before": int(args.more_segment_before),
    }

    print("IndexTTS: starting inference", file=sys.stderr)
    result = tts.infer(**infer_kwargs)
    if not result:
        raise RuntimeError("IndexTTS did not return an audio artifact.")
    print(f"IndexTTS: wrote {output_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
