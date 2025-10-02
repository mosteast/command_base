#!/usr/bin/env python3

"""Local XTTS v2 synthesis entrypoint.

This wrapper is intentionally minimal so it can be invoked from Node without
relying on any hosted APIs or API keys.
"""

import argparse
import os
import sys
from importlib import import_module
from typing import Optional


MODEL_NAME = "tts_models/multilingual/multi-dataset/xtts_v2"




def _register_safe_globals():
    try:
        from torch.serialization import add_safe_globals  # type: ignore
    except Exception:
        return

    target_names = [
        "TTS.tts.configs.xtts_config.XttsConfig",
        "TTS.tts.configs.xtts_config.XttsAudioConfig",
        "TTS.tts.configs.xtts_config.XttsArgs",
        "TTS.tts.configs.xtts_config.XttsSpeakerConfig",
        "TTS.tts.models.xtts.XttsAudioConfig",
        "TTS.tts.models.xtts.XttsModel",
        "TTS.config.shared_configs.BaseDatasetConfig",
    ]

    safe_objects = []
    for dotted_name in target_names:
        try:
            module_name, attribute_name = dotted_name.rsplit(".", 1)
            module = import_module(module_name)
            candidate = getattr(module, attribute_name)
            safe_objects.append(candidate)
        except Exception:
            continue

    if not safe_objects:
        return

    try:
        add_safe_globals(safe_objects)
    except Exception:
        pass
def _resolve_device(device_option: str) -> str:
    normalized = (device_option or "").strip().lower()
    if not normalized or normalized == "auto":
        try:
            import torch  # type: ignore

            return "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            return "cpu"
    return device_option


def _load_tts(device_choice: str):
    try:
        from TTS.api import TTS  # type: ignore
    except ImportError as exc:  # pragma: no cover - environment specific
        raise RuntimeError(
            "Missing dependency: TTS. Install locally with `pip install TTS`."
        ) from exc

    _register_safe_globals()
    _ensure_generation_mixin()

    gpu_requested = device_choice.startswith("cuda")

    try:
        tts = TTS(model_name=MODEL_NAME, progress_bar=False, gpu=gpu_requested)
    except TypeError:
        # Older versions do not support the gpu kwarg.
        tts = TTS(model_name=MODEL_NAME, progress_bar=False)
    except Exception as exc:
        raise RuntimeError(f"Failed to load XTTS model: {exc}") from exc

    if device_choice and device_choice not in ("cpu", "auto"):
        # TTS instances expose either .to or .model.to depending on the version.
        moved = False
        for attr in ("to", "model"):
            target: Optional[object] = getattr(tts, attr, None)
            if target is None:
                continue
            try:
                if attr == "to":
                    target(device_choice)
                elif hasattr(target, "to"):
                    target.to(device_choice)
                moved = True
                break
            except Exception as exc:
                raise RuntimeError(
                    f"Failed to move XTTS model to device '{device_choice}': {exc}"
                ) from exc
        if not moved:
            raise RuntimeError(
                f"XTTS instance does not support moving to device '{device_choice}'."
            )

    return tts


def _resolve_speaker_choice(tts, requested: Optional[str], voice_path: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """Determine which speaker label to use for synthesis."""

    is_multi_speaker = bool(getattr(tts, "is_multi_speaker", False))

    speakers = _collect_available_speakers(tts)
    speaker_lookup = {name.lower(): name for name in speakers}

    if requested:
        normalized = requested.strip()
        lowered = normalized.lower()
        if lowered in speaker_lookup:
            resolved = speaker_lookup[lowered]
            if resolved != normalized:
                return resolved, f"Normalized speaker preset '{normalized}' to '{resolved}'."
            return resolved, None
        if speakers and is_multi_speaker:
            available = ", ".join(speakers)
            raise ValueError(
                f"Unknown XTTS speaker '{normalized}'. Available speakers: {available}",
            )
        return normalized or None, None

    if voice_path:
        return None, None

    if not is_multi_speaker:
        return None, None

    if speakers:
        default_speaker = speakers[0]
        return default_speaker, f"Auto-selecting default speaker '{default_speaker}'."

    raise ValueError(
        "XTTS model is multi-speaker but no speaker presets were discovered. Provide --speaker explicitly.",
    )


def _collect_available_speakers(tts) -> list[str]:
    """Return the known speaker labels exposed by the XTTS model."""

    collected: list[str] = []
    raw_speakers = getattr(tts, "speakers", None)
    if isinstance(raw_speakers, dict):
        collected.extend(str(name).strip() for name in raw_speakers.keys() if str(name).strip())
    elif isinstance(raw_speakers, (list, tuple, set)):
        collected.extend(str(name).strip() for name in raw_speakers if str(name).strip())

    if not collected:
        synthesizer = getattr(tts, "synthesizer", None)
        tts_model = getattr(synthesizer, "tts_model", None) if synthesizer else None
        manager = getattr(tts_model, "speaker_manager", None) if tts_model else None
        mapping = getattr(manager, "name_to_id", None) if manager else None

        if isinstance(mapping, dict):
            collected.extend(str(name).strip() for name in mapping.keys() if str(name).strip())
        elif mapping is not None:
            try:
                collected.extend(str(name).strip() for name in mapping if str(name).strip())
            except TypeError:
                pass

    sanitized = [name for name in collected if isinstance(name, str) and name]
    deduped: dict[str, str] = {}
    for name in sanitized:
        trimmed = name.strip()
        if trimmed and trimmed.lower() not in deduped:
            deduped[trimmed.lower()] = trimmed

    return list(deduped.values())


def _ensure_generation_mixin() -> None:
    """Inject GenerationMixin into legacy GPT inference layers when required."""

    try:
        from transformers.generation import GenerationMixin  # type: ignore
    except Exception:
        return

    target_modules = [
        "TTS.tts.layers.xtts.gpt_inference",
        "TTS.tts.layers.tortoise.autoregressive",
    ]

    for module_name in target_modules:
        try:
            module = import_module(module_name)
        except Exception:
            continue

        candidate = getattr(module, "GPT2InferenceModel", None)
        if candidate is None:
            continue

        if GenerationMixin in getattr(candidate, "__mro__", ()):  # already patched
            continue

        try:
            candidate.__bases__ = tuple(candidate.__bases__) + (GenerationMixin,)
        except Exception:
            continue


def main() -> int:
    parser = argparse.ArgumentParser(description="Synthesize speech with local XTTS v2.")
    parser.add_argument("--text", required=True, help="Text content to synthesize.")
    parser.add_argument("--out", required=True, help="Destination WAV file path.")
    parser.add_argument(
        "--lang",
        default="en",
        help="Language code understood by XTTS (for example: en, zh-cn).",
    )
    parser.add_argument(
        "--voice",
        default=None,
        help="Optional reference speaker WAV file for voice cloning.",
    )
    parser.add_argument(
        "--speaker",
        default=None,
        help="Named speaker preset for multi-speaker XTTS models.",
    )
    parser.add_argument("--speed", type=float, default=1.0, help="Playback speed multiplier.")
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.7,
        help="Sampling temperature for XTTS generation.",
    )
    parser.add_argument(
        "--device",
        default="auto",
        help="Device to use (auto, cpu, cuda:0, ...).",
    )

    args = parser.parse_args()

    text_payload = args.text.strip()
    if not text_payload:
        print("Provided text is empty after trimming.", file=sys.stderr)
        return 1

    output_dir = os.path.dirname(args.out) or "."
    try:
        os.makedirs(output_dir, exist_ok=True)
    except OSError as exc:
        print(f"Failed to prepare output directory '{output_dir}': {exc}", file=sys.stderr)
        return 1

    try:
        device_choice = _resolve_device(args.device)
        tts = _load_tts(device_choice)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    try:
        speaker_name, message = _resolve_speaker_choice(tts, args.speaker, args.voice)
        if message:
            print(f"[XTTS] {message}")

        tts.tts_to_file(
            text=text_payload,
            file_path=args.out,
            language=args.lang,
            speaker=speaker_name,
            speaker_wav=args.voice,
            speed=args.speed,
            temperature=args.temperature,
            split_sentences=True,
        )
    except Exception as exc:
        print(f"Synthesis failed: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
