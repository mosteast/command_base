#!/usr/bin/env python3
"""Local VibeVoice inference wrapper for the text_to_speech CLI."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Dict, Tuple


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a VibeVoice model locally for text-to-speech synthesis.",
    )
    parser.add_argument("--text", required=True, help="Text to synthesize.")
    parser.add_argument("--out", required=True, help="Destination WAV path.")
    parser.add_argument("--model-dir", required=True, help="Directory containing VibeVoice model weights.")
    parser.add_argument("--processor-dir", required=True, help="Directory containing processor files.")
    parser.add_argument("--voice", required=True, help="Reference voice sample.")
    parser.add_argument("--device", default="auto", help="Execution device hint (auto, cpu, cuda, mps, ...).")
    parser.add_argument("--cfg-scale", type=float, default=3.0, help="Classifier-free guidance scale.")
    parser.add_argument("--max-new-tokens", type=int, help="Optional limit for generated tokens.")
    parser.add_argument("--ddpm-steps", type=int, help="Optional diffusion inference steps override.")
    parser.add_argument("--use-half", action="store_true", help="Enable FP16 when supported.")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress output from the model.")
    return parser.parse_args()


def ensure_directory(path: Path, description: str) -> Path:
    if not path.is_dir():
        raise FileNotFoundError(f"{description} '{path}' is not a directory.")
    return path


def ensure_file(path: Path, description: str) -> Path:
    if not path.is_file():
        raise FileNotFoundError(f"{description} '{path}' does not exist.")
    return path


def resolve_device(device_hint: str) -> Tuple[str, bool]:
    import torch  # Local import to defer dependency cost.

    normalized = (device_hint or "auto").strip().lower()
    if normalized in {"auto", ""}:
        if torch.cuda.is_available():
            return "cuda", True
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps", False
        return "cpu", False
    if normalized.startswith("cuda"):
        return normalized, True
    return normalized, normalized.startswith("cuda")


def build_model_and_processor(
    model_dir: Path,
    processor_dir: Path,
    device: str,
    use_half: bool,
    ddpm_steps: int | None,
) -> Tuple[object, object]:
    import torch
    from transformers import AutoModelForCausalLM
    from vibevoice.processor.vibevoice_processor import VibeVoiceProcessor

    dtype = torch.float16 if use_half and device.startswith("cuda") else torch.float32
    if use_half and not device.startswith("cuda"):
        print("VibeVoice: falling back to float32 because half precision is unavailable on this device.", file=sys.stderr)
        dtype = torch.float32

    processor = VibeVoiceProcessor.from_pretrained(str(processor_dir))

    model = AutoModelForCausalLM.from_pretrained(
        str(model_dir),
        trust_remote_code=True,
        torch_dtype=dtype,
    )
    model.to(device)
    model.eval()

    if ddpm_steps and hasattr(model, "set_ddpm_inference_steps"):
        try:
            model.set_ddpm_inference_steps(int(ddpm_steps))
        except Exception as error:  # noqa: BLE001
            print(f"VibeVoice: failed to configure diffusion steps ({error}).", file=sys.stderr)

    return model, processor


def prepare_inputs(
    processor,
    text: str,
    voice_path: Path,
    device: str,
) -> Tuple[Dict[str, object], Dict[str, object]]:
    import torch

    features = processor(
        text=text,
        voice_samples=[str(voice_path)],
        return_tensors="pt",
    )

    tensor_keys = {"input_ids", "attention_mask", "speech_tensors", "speech_masks", "speech_input_mask"}
    model_inputs: Dict[str, object] = {}
    for key, value in features.items():
        if key in tensor_keys and value is not None:
            model_inputs[key] = value.to(device)
    meta = {
        "parsed_scripts": features.get("parsed_scripts"),
        "all_speakers_list": features.get("all_speakers_list"),
    }
    if "speech_tensors" in model_inputs and hasattr(model_inputs["speech_tensors"], "to"):
        model_inputs["speech_tensors"] = model_inputs["speech_tensors"].to(device)
    if "speech_masks" in model_inputs and hasattr(model_inputs["speech_masks"], "to"):
        model_inputs["speech_masks"] = model_inputs["speech_masks"].to(device)
    if "speech_input_mask" in model_inputs and hasattr(model_inputs["speech_input_mask"], "to"):
        model_inputs["speech_input_mask"] = model_inputs["speech_input_mask"].to(device)

    return model_inputs, meta


def synthesize(args: argparse.Namespace) -> None:
    text = args.text.strip()
    if not text:
        raise ValueError("Text prompt is empty.")
    if args.cfg_scale <= 0:
        raise ValueError("--cfg-scale must be greater than zero.")
    if args.max_new_tokens is not None and args.max_new_tokens <= 0:
        raise ValueError("--max-new-tokens must be greater than zero when provided.")
    if args.ddpm_steps is not None and args.ddpm_steps <= 0:
        raise ValueError("--ddpm-steps must be greater than zero when provided.")

    model_dir = ensure_directory(Path(args.model_dir).expanduser().resolve(), "Model directory")
    processor_dir = ensure_directory(Path(args.processor_dir).expanduser().resolve(), "Processor directory")
    voice_path = ensure_file(Path(args.voice).expanduser().resolve(), "Reference voice")

    device, prefers_half = resolve_device(args.device)
    use_half = bool(args.use_half and prefers_half)

    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

    model, processor = build_model_and_processor(
        model_dir,
        processor_dir,
        device,
        use_half,
        args.ddpm_steps,
    )

    model_inputs, meta = prepare_inputs(processor, text, voice_path, device)

    generation_kwargs = {
        "return_speech": True,
        "cfg_scale": float(args.cfg_scale),
        "tokenizer": processor.tokenizer,
        "parsed_scripts": meta["parsed_scripts"],
        "all_speakers_list": meta["all_speakers_list"],
        "show_progress_bar": not bool(args.quiet),
    }
    if args.max_new_tokens is not None:
        generation_kwargs["max_new_tokens"] = int(args.max_new_tokens)

    import torch
    import soundfile as sf

    with torch.no_grad():
        outputs = model.generate(**model_inputs, **generation_kwargs)

    speech_outputs = getattr(outputs, "speech_outputs", None)
    if not speech_outputs:
        raise RuntimeError("VibeVoice did not return audio. Ensure weights are correctly converted.")

    audio_tensor = speech_outputs[0]
    if audio_tensor is None:
        raise RuntimeError("VibeVoice returned an empty audio tensor.")

    waveform = audio_tensor.detach().cpu().numpy().astype("float32").reshape(-1)
    sampling_rate = getattr(getattr(processor, "audio_processor", None), "sampling_rate", 24000)

    output_path = Path(args.out).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(output_path), waveform, sampling_rate)
    print(f"VibeVoice: wrote {output_path} ({sampling_rate} Hz)", file=sys.stderr)


def main() -> None:
    try:
        args = parse_arguments()
        synthesize(args)
    except KeyboardInterrupt:
        print("VibeVoice: interrupted", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:  # noqa: BLE001
        print(f"VibeVoice error: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
