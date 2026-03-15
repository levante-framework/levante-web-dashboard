#!/usr/bin/env python3
"""
Hugging Face back-translation utilities using NLLB-200.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Dict, List, Optional

import torch
from transformers import AutoModelForSeq2SeqLM, AutoTokenizer

MODEL_NAME = "facebook/nllb-200-distilled-600M"
DEFAULT_MAX_LENGTH = 512
DEFAULT_MAX_NEW_TOKENS = 200
DEFAULT_NUM_BEAMS = 4
DEFAULT_SOURCE_NLLB = "eng_Latn"
DEFAULT_TARGET_NLLB = "eng_Latn"
LANG_MAP_PATH = Path(__file__).resolve().parent / "hf_lang_map.json"

_TOKENIZER = None
_MODEL = None
_DEVICE = None
_LANG_MAP: Optional[Dict[str, str]] = None


def load_lang_map() -> Dict[str, str]:
    global _LANG_MAP
    if _LANG_MAP is not None:
        return _LANG_MAP
    if not LANG_MAP_PATH.exists():
        _LANG_MAP = {}
        return _LANG_MAP
    _LANG_MAP = json.loads(LANG_MAP_PATH.read_text(encoding="utf-8"))
    return _LANG_MAP


def canonical_locale(locale: str) -> str:
    raw = str(locale or "").strip().replace("_", "-")
    if not raw:
        return ""
    if raw.lower() in {"en-us", "en-gb", "en-gh"}:
        return raw[:2].lower() + "-" + raw[3:].upper()
    if len(raw) == 2:
        return raw.lower()
    parts = raw.split("-")
    if len(parts) == 2:
        return f"{parts[0].lower()}-{parts[1].upper()}"
    return raw


def locale_to_nllb(locale: str) -> str:
    loc = canonical_locale(locale)
    lang_map = load_lang_map()
    if loc in lang_map:
        return lang_map[loc]
    base = loc.split("-")[0] if loc else ""
    if base in lang_map:
        return lang_map[base]
    return DEFAULT_SOURCE_NLLB if base == "en" else ""


def choose_device(device: str) -> str:
    wanted = str(device or "auto").lower()
    if wanted in {"cpu", "cuda"}:
        if wanted == "cuda" and not torch.cuda.is_available():
            return "cpu"
        return wanted
    return "cuda" if torch.cuda.is_available() else "cpu"


def ensure_model_loaded(device: str = "auto") -> None:
    global _TOKENIZER, _MODEL, _DEVICE
    if _TOKENIZER is not None and _MODEL is not None:
        return
    _DEVICE = choose_device(device)
    _TOKENIZER = AutoTokenizer.from_pretrained(MODEL_NAME)
    model_kwargs = {}
    if _DEVICE == "cuda":
        model_kwargs["torch_dtype"] = torch.float16
    _MODEL = AutoModelForSeq2SeqLM.from_pretrained(MODEL_NAME, **model_kwargs)
    _MODEL.to(_DEVICE)
    _MODEL.eval()


def _translate(
    text: str,
    source_nllb: str,
    target_nllb: str,
    max_length: int = DEFAULT_MAX_LENGTH,
    max_new_tokens: int = DEFAULT_MAX_NEW_TOKENS,
    num_beams: int = DEFAULT_NUM_BEAMS,
) -> str:
    if not str(text or "").strip():
        return ""
    ensure_model_loaded()
    assert _TOKENIZER is not None
    assert _MODEL is not None

    try:
        _TOKENIZER.src_lang = source_nllb
        inputs = _TOKENIZER(
            str(text),
            return_tensors="pt",
            truncation=True,
            padding=True,
            max_length=max_length,
        )
        inputs = {k: v.to(_DEVICE) for k, v in inputs.items()}
        forced_bos_token_id = _TOKENIZER.lang_code_to_id[target_nllb]
        with torch.no_grad():
            outputs = _MODEL.generate(
                **inputs,
                forced_bos_token_id=forced_bos_token_id,
                max_new_tokens=max_new_tokens,
                num_beams=num_beams,
                early_stopping=True,
            )
        return _TOKENIZER.decode(outputs[0], skip_special_tokens=True).strip()
    except torch.cuda.OutOfMemoryError:
        # Safe fallback for larger batches/texts.
        if _DEVICE == "cuda":
            torch.cuda.empty_cache()
        return _translate(
            text=text[:2000],
            source_nllb=source_nllb,
            target_nllb=target_nllb,
            max_length=min(max_length, 384),
            max_new_tokens=min(max_new_tokens, 128),
            num_beams=2,
        )


def translate_to_english(text: str, source_locale: str, max_length: int = DEFAULT_MAX_LENGTH) -> str:
    source_nllb = locale_to_nllb(source_locale)
    if not source_nllb:
        raise ValueError(f"No NLLB mapping for source locale '{source_locale}'")
    return _translate(
        text=text,
        source_nllb=source_nllb,
        target_nllb=DEFAULT_TARGET_NLLB,
        max_length=max_length,
    )


def back_translate_roundtrip(
    text: str,
    target_locale: str,
    source_locale: str = "en",
    max_length: int = DEFAULT_MAX_LENGTH,
) -> str:
    source_nllb = locale_to_nllb(source_locale)
    target_nllb = locale_to_nllb(target_locale)
    if not source_nllb:
        raise ValueError(f"No NLLB mapping for source locale '{source_locale}'")
    if not target_nllb:
        raise ValueError(f"No NLLB mapping for target locale '{target_locale}'")
    forward = _translate(text=text, source_nllb=source_nllb, target_nllb=target_nllb, max_length=max_length)
    backward = _translate(text=forward, source_nllb=target_nllb, target_nllb=source_nllb, max_length=max_length)
    return backward


def batch_translate_to_english(
    strings: List[str],
    source_locale: str,
    batch_size: int = 8,
    max_length: int = DEFAULT_MAX_LENGTH,
) -> List[str]:
    out: List[str] = []
    for i in range(0, len(strings), max(1, batch_size)):
        batch = strings[i : i + batch_size]
        for text in batch:
            out.append(translate_to_english(text=text, source_locale=source_locale, max_length=max_length))
    return out


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="HF NLLB back-translation helper.")
    p.add_argument("--mode", default="to-english", choices=["to-english", "roundtrip"])
    p.add_argument("--text", default="")
    p.add_argument("--text-stdin", action="store_true", help="Read text payload from stdin.")
    p.add_argument("--source-locale", default="en")
    p.add_argument("--target-locale", default="")
    p.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    p.add_argument("--max-length", type=int, default=DEFAULT_MAX_LENGTH)
    p.add_argument("--json", action="store_true", help="Emit JSON object.")
    return p.parse_args()


def main() -> int:
    args = parse_args()
    ensure_model_loaded(device=args.device)
    text_value = sys.stdin.read() if args.text_stdin else args.text

    if args.mode == "to-english":
        translated = translate_to_english(
            text=text_value,
            source_locale=args.source_locale,
            max_length=args.max_length,
        )
        if args.json:
            print(json.dumps({"translatedText": translated, "model": MODEL_NAME}))
        else:
            print(translated)
        return 0

    if not args.target_locale:
        raise SystemExit("--target-locale is required for roundtrip mode")
    translated = back_translate_roundtrip(
        text=text_value,
        target_locale=args.target_locale,
        source_locale=args.source_locale,
        max_length=args.max_length,
    )
    if args.json:
        print(json.dumps({"translatedText": translated, "model": MODEL_NAME}))
    else:
        print(translated)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        raise

