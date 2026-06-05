#!/usr/bin/env python3
"""
Tiered translation grading pipeline for Levante.

Pipeline stages:
1) Cross-lingual consistency outlier detection (LaBSE / multilingual-e5).
2) Optional reference-free QE (COMET / xCOMET when package is installed).
3) Optional Gemini LLM-as-judge direct assessment for suspicious rows.
4) Review triage output (CSV + JSON summary).
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import re
import statistics
import urllib.error
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np


HTML_TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")


@dataclass
class RowTranslation:
    item_id: str
    row_index: int
    source_text: str
    target_lang: str
    target_text: str
    ambiguity_note: str = ""
    scores: Dict[str, float] = field(default_factory=dict)
    notes: List[str] = field(default_factory=list)
    needs_review: bool = False
    review_reasons: List[str] = field(default_factory=list)
    metadata: Dict[str, object] = field(default_factory=dict)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run tiered translation grading pipeline.")
    parser.add_argument(
        "--input-mode",
        default="csv",
        choices=["csv", "crowdin"],
        help="Input source mode: local CSV or Crowdin approved export endpoint.",
    )
    parser.add_argument("--input-csv", default="", help="CSV with source + target language columns (required for --input-mode csv).")
    parser.add_argument(
        "--crowdin-base-url",
        default="https://levante-cockpit.vercel.app",
        help="Base URL used for /api/crowdin-approved-translations when --input-mode crowdin.",
    )
    parser.add_argument("--item-id-col", default="item_id", help="Item id column name.")
    parser.add_argument("--source-col", default="en", help="Source text column (default: en).")
    parser.add_argument(
        "--target-cols",
        default="",
        help="Comma-separated target columns. If empty, auto-detect all non-meta columns.",
    )
    parser.add_argument(
        "--ignore-cols",
        default="",
        help="Comma-separated columns to ignore when auto-detecting target columns.",
    )
    parser.add_argument(
        "--ambiguity-col",
        default="",
        help="Optional ambiguity/context note column to include in LLM judging.",
    )
    parser.add_argument("--max-rows", type=int, default=0, help="Limit source rows (0 = all).")
    parser.add_argument("--strip-html", action="store_true", help="Strip HTML tags before scoring.")

    parser.add_argument("--embedding-model", default="sentence-transformers/LaBSE", help="SentenceTransformer model.")
    parser.add_argument("--embedding-device", default="auto", choices=["auto", "cpu", "cuda"], help="Embedding device.")
    parser.add_argument("--embedding-batch-size", type=int, default=128, help="Embedding batch size.")
    parser.add_argument("--consistency-threshold", type=float, default=0.78, help="Outlier threshold for centroid cosine.")

    parser.add_argument("--run-comet", action="store_true", help="Enable COMET/xCOMET stage if package is installed.")
    parser.add_argument(
        "--comet-model",
        default="Unbabel/wmt22-cometkiwi-da",
        help="COMET model name (example: Unbabel/wmt22-cometkiwi-da, Unbabel/XCOMET-XL).",
    )
    parser.add_argument("--comet-batch-size", type=int, default=32, help="COMET prediction batch size.")
    parser.add_argument("--comet-threshold", type=float, default=0.62, help="Review threshold for COMET score.")

    parser.add_argument("--run-llm-judge", action="store_true", help="Enable Gemini direct-assessment stage.")
    parser.add_argument("--gemini-api-key-env", default="GEMINI_API_KEY", help="Env var containing Gemini API key.")
    parser.add_argument("--gemini-model", default="gemini-2.5-pro", help="Gemini model slug.")
    parser.add_argument("--gemini-threshold", type=float, default=75.0, help="Review threshold for LLM final score (0-100).")
    parser.add_argument(
        "--llm-only-flagged",
        action="store_true",
        help="Only call LLM judge for rows flagged by previous stages.",
    )
    parser.add_argument("--llm-max-calls", type=int, default=0, help="Cap total LLM calls (0 = no cap).")

    parser.add_argument("--output-csv", default="data/validation/translation-grading-report.csv")
    parser.add_argument("--summary-json", default="data/validation/translation-grading-summary.json")
    return parser.parse_args()


def normalize_text(value: str, strip_html: bool) -> str:
    text = str(value or "")
    if strip_html:
        text = HTML_TAG_RE.sub(" ", text)
    return SPACE_RE.sub(" ", text).strip()


def parse_csv_list(raw: str) -> List[str]:
    return [c.strip() for c in str(raw or "").split(",") if c.strip()]


def maybe_prefix_e5(model_name: str, texts: Sequence[str], prefix: str) -> List[str]:
    if "e5" not in str(model_name or "").lower():
        return list(texts)
    return [f"{prefix}: {text}" for text in texts]


def cosine(u: np.ndarray, v: np.ndarray) -> float:
    denom = float(np.linalg.norm(u) * np.linalg.norm(v))
    if denom == 0:
        return 0.0
    return float(np.dot(u, v) / denom)


def auto_target_cols(fieldnames: Iterable[str], source_col: str, id_col: str, ambiguity_col: str, ignore_cols: Sequence[str]) -> List[str]:
    ignored = {source_col, id_col, ambiguity_col, *ignore_cols}
    ignored = {c for c in ignored if c}
    out: List[str] = []
    for name in fieldnames:
        n = str(name or "").strip()
        if not n or n in ignored:
            continue
        if n.startswith("_"):
            continue
        out.append(n)
    return out


def normalize_lang_code(value: str) -> str:
    raw = str(value or "").strip().replace("_", "-")
    if not raw:
        return ""
    lower = raw.lower()
    aliases = {
        "de-de": "de",
        "de-ch": "de-CH",
        "en-us": "en-US",
        "en-gb": "en-GB",
        "en-gh": "en-GH",
        "es-co": "es-CO",
        "es-ar": "es-AR",
        "fr-ca": "fr-CA",
        "pt-br": "pt-BR",
        "pt-pt": "pt-PT",
    }
    return aliases.get(lower, raw)


def parse_crowdin_csv_bytes(payload: bytes) -> List[dict]:
    text = payload.decode("utf-8-sig", errors="replace")
    reader = csv.DictReader(io.StringIO(text))
    out: List[dict] = []
    for row in reader:
        if isinstance(row, dict):
            out.append({str(k): (v if v is not None else "") for k, v in row.items()})
    return out


def parse_crowdin_xliff_bytes(payload: bytes, zip_path: str) -> List[dict]:
    try:
        root = ET.fromstring(payload)
    except Exception:
        return []

    rows: List[dict] = []
    root_tag = str(root.tag)
    is_xliff2 = root_tag.endswith("xliff") and ("2.0" in root_tag or str(root.attrib.get("version", "")).startswith("2"))

    if is_xliff2:
        for unit in root.iter():
            if not str(unit.tag).endswith("unit"):
                continue
            unit_id = str(unit.attrib.get("id", "")).strip()
            for seg in unit.iter():
                if not str(seg.tag).endswith("segment"):
                    continue
                src_text = ""
                tgt_text = ""
                for child in seg:
                    if str(child.tag).endswith("source"):
                        src_text = "".join(child.itertext()).strip()
                    elif str(child.tag).endswith("target"):
                        tgt_text = "".join(child.itertext()).strip()
                if src_text or tgt_text:
                    rows.append({"item_id": f"{zip_path}::{unit_id or 'segment'}", "en": src_text, "_xliff_target": tgt_text})
        return rows

    # XLIFF 1.2 style.
    for tu in root.iter():
        if not str(tu.tag).endswith("trans-unit"):
            continue
        unit_id = str(tu.attrib.get("id", "")).strip()
        src_text = ""
        tgt_text = ""
        for child in tu:
            if str(child.tag).endswith("source"):
                src_text = "".join(child.itertext()).strip()
            elif str(child.tag).endswith("target"):
                tgt_text = "".join(child.itertext()).strip()
        if src_text or tgt_text:
            rows.append({"item_id": f"{zip_path}::{unit_id or 'trans-unit'}", "en": src_text, "_xliff_target": tgt_text})
    return rows


def infer_lang_from_path(path: str) -> str:
    parts = [p for p in str(path or "").replace("\\", "/").split("/") if p]
    for p in parts:
        lp = p.lower()
        if re.fullmatch(r"[a-z]{2}(?:-[a-z0-9]{2,8})?", lp):
            return normalize_lang_code(p)
    return ""


def fetch_crowdin_approved_rows(base_url: str) -> List[dict]:
    endpoint = f"{base_url.rstrip('/')}/api/crowdin-approved-translations"
    req = urllib.request.Request(endpoint, method="GET")
    with urllib.request.urlopen(req, timeout=90) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    zip_url = str(payload.get("zipUrl", "")).strip()
    if not zip_url:
        raise RuntimeError(f"Crowdin endpoint did not return zipUrl: {payload}")

    with urllib.request.urlopen(zip_url, timeout=180) as zresp:
        zip_bytes = zresp.read()

    merged: Dict[str, dict] = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            name = str(info.filename or "")
            lower = name.lower()
            if info.is_dir():
                continue
            if not (lower.endswith(".csv") or lower.endswith(".xlf") or lower.endswith(".xliff")):
                continue
            if "/archive/" in lower:
                continue

            file_data = zf.read(info)
            if lower.endswith(".csv"):
                rows = parse_crowdin_csv_bytes(file_data)
                for idx, row in enumerate(rows):
                    rid = str(row.get("item_id") or row.get("identifier") or row.get("id") or f"{name}::{idx}").strip()
                    if not rid:
                        continue
                    existing = merged.get(rid, {})
                    row["_path"] = name
                    merged[rid] = {**existing, **row}
            else:
                lang = infer_lang_from_path(name)
                xliff_rows = parse_crowdin_xliff_bytes(file_data, name)
                for row in xliff_rows:
                    rid = str(row.get("item_id", "")).strip()
                    if not rid:
                        continue
                    existing = merged.get(rid, {})
                    existing["item_id"] = existing.get("item_id") or rid
                    existing["en"] = existing.get("en") or row.get("en", "")
                    if lang and row.get("_xliff_target"):
                        existing[lang] = row["_xliff_target"]
                    existing["_path"] = existing.get("_path") or name
                    merged[rid] = existing
    return list(merged.values())


def load_rows(args: argparse.Namespace) -> Tuple[List[RowTranslation], List[str]]:
    if args.input_mode == "crowdin":
        source_rows = fetch_crowdin_approved_rows(args.crowdin_base_url)
        if not source_rows:
            raise RuntimeError("No rows loaded from Crowdin approved export.")
        fieldnames = sorted({k for row in source_rows for k in row.keys()})
        target_cols = parse_csv_list(args.target_cols)
        if not target_cols:
            target_cols = auto_target_cols(
                fieldnames=fieldnames,
                source_col=args.source_col,
                id_col=args.item_id_col,
                ambiguity_col=args.ambiguity_col,
                ignore_cols=parse_csv_list(args.ignore_cols) + ["_path", "_sourcePaths", "_xliff_target", "identifier", "labels", "contentType"],
            )
        rows: List[RowTranslation] = []
        for idx, row in enumerate(source_rows, start=2):
            source = normalize_text(row.get(args.source_col, ""), strip_html=args.strip_html)
            item_id = normalize_text(row.get(args.item_id_col, ""), strip_html=False) or normalize_text(row.get("identifier", ""), strip_html=False) or f"row-{idx}"
            ambiguity = normalize_text(row.get(args.ambiguity_col, ""), strip_html=args.strip_html) if args.ambiguity_col else ""
            if not source:
                continue
            for target_col in target_cols:
                target = normalize_text(row.get(target_col, ""), strip_html=args.strip_html)
                if not target:
                    continue
                rows.append(
                    RowTranslation(
                        item_id=item_id,
                        row_index=idx,
                        source_text=source,
                        target_lang=target_col,
                        target_text=target,
                        ambiguity_note=ambiguity,
                    )
                )
                if args.max_rows > 0 and len(rows) >= args.max_rows:
                    break
            if args.max_rows > 0 and len(rows) >= args.max_rows:
                break
        return rows, target_cols

    if not args.input_csv:
        raise ValueError("--input-csv is required when --input-mode csv")

    input_path = Path(args.input_csv).expanduser().resolve()
    if not input_path.exists():
        raise FileNotFoundError(f"Input CSV not found: {input_path}")

    rows: List[RowTranslation] = []
    with input_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            raise ValueError("CSV is missing header row.")

        target_cols = parse_csv_list(args.target_cols)
        if not target_cols:
            target_cols = auto_target_cols(
                fieldnames=reader.fieldnames,
                source_col=args.source_col,
                id_col=args.item_id_col,
                ambiguity_col=args.ambiguity_col,
                ignore_cols=parse_csv_list(args.ignore_cols),
            )
        if not target_cols:
            raise ValueError("No target columns detected. Pass --target-cols explicitly.")

        for idx, row in enumerate(reader, start=2):
            source = normalize_text(row.get(args.source_col, ""), strip_html=args.strip_html)
            item_id = normalize_text(row.get(args.item_id_col, ""), strip_html=False) or f"row-{idx}"
            ambiguity = normalize_text(row.get(args.ambiguity_col, ""), strip_html=args.strip_html) if args.ambiguity_col else ""
            if not source:
                continue

            for target_col in target_cols:
                target = normalize_text(row.get(target_col, ""), strip_html=args.strip_html)
                if not target:
                    continue
                rows.append(
                    RowTranslation(
                        item_id=item_id,
                        row_index=idx,
                        source_text=source,
                        target_lang=target_col,
                        target_text=target,
                        ambiguity_note=ambiguity,
                    )
                )
                if args.max_rows > 0 and len(rows) >= args.max_rows:
                    break
            if args.max_rows > 0 and len(rows) >= args.max_rows:
                break
    return rows, target_cols


def run_consistency_stage(rows: List[RowTranslation], args: argparse.Namespace) -> None:
    try:
        from sentence_transformers import SentenceTransformer
    except Exception as exc:  # pragma: no cover
        print(f"[consistency] skipped: sentence-transformers unavailable ({exc})")
        return

    if not rows:
        return

    model_name = args.embedding_model
    device = None if args.embedding_device == "auto" else args.embedding_device
    model = SentenceTransformer(model_name, device=device)

    # Encode all source/target texts once to avoid repeated model calls per item.
    target_texts = [r.target_text for r in rows]
    source_texts = [r.source_text for r in rows]
    tgt_inputs = maybe_prefix_e5(model_name, target_texts, "passage")
    src_inputs = maybe_prefix_e5(model_name, source_texts, "query")
    tgt_emb_all = model.encode(
        tgt_inputs,
        batch_size=args.embedding_batch_size,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    )
    src_emb_all = model.encode(
        src_inputs,
        batch_size=args.embedding_batch_size,
        convert_to_numpy=True,
        normalize_embeddings=True,
        show_progress_bar=False,
    )

    per_item_indices: Dict[str, List[int]] = {}
    for idx, r in enumerate(rows):
        per_item_indices.setdefault(r.item_id, []).append(idx)

    for _, item_indices in per_item_indices.items():
        for idx in item_indices:
            row = rows[idx]
            self_vec = tgt_emb_all[idx]
            other_vecs = [tgt_emb_all[j] for j in item_indices if j != idx]
            if other_vecs:
                centroid = np.mean(np.array(other_vecs), axis=0)
                score = cosine(self_vec, centroid)
                basis = "target-centroid"
            else:
                score = cosine(self_vec, src_emb_all[idx])
                basis = "source-fallback"

            row.scores["consistency"] = score
            row.metadata["consistency_basis"] = basis
            if score < args.consistency_threshold:
                row.needs_review = True
                row.review_reasons.append(f"consistency<{args.consistency_threshold:.2f}")


def run_comet_stage(rows: List[RowTranslation], args: argparse.Namespace) -> None:
    if not args.run_comet or not rows:
        return
    try:
        from comet import download_model, load_from_checkpoint
    except Exception as exc:  # pragma: no cover
        print(f"[comet] skipped: unbabel-comet unavailable ({exc})")
        return

    model_path = download_model(args.comet_model)
    model = load_from_checkpoint(model_path)
    comet_inputs = [{"src": row.source_text, "mt": row.target_text} for row in rows]

    # Keep GPU optional; COMET decides if CUDA is available.
    output = model.predict(comet_inputs, batch_size=args.comet_batch_size, gpus=1 if os.environ.get("CUDA_VISIBLE_DEVICES", "") != "" else 0)
    seg_scores = list(output.scores or [])
    if len(seg_scores) != len(rows):
        print("[comet] warning: unexpected score count, skipping stage")
        return

    for row, score in zip(rows, seg_scores):
        score_f = float(score)
        row.scores["comet"] = score_f
        if score_f < args.comet_threshold:
            row.needs_review = True
            row.review_reasons.append(f"comet<{args.comet_threshold:.2f}")


def build_llm_prompt(row: RowTranslation) -> str:
    ambiguity = row.ambiguity_note.strip()
    ambiguity_block = (
        f"Task-specific constraint: {ambiguity}\n"
        if ambiguity
        else "Task-specific constraint: preserve intended meaning and pragmatics for child-facing benchmark prompts.\n"
    )
    return (
        "You are an expert translation quality assessor using MQM-style severity.\n"
        "Evaluate the translation directly (no back-translation), given source and target.\n"
        "Return strict JSON only.\n\n"
        f"Source language text (English): {row.source_text}\n"
        f"Target language ({row.target_lang}) translation: {row.target_text}\n\n"
        f"{ambiguity_block}\n"
        "Scoring instructions:\n"
        "- adequacy: 0..100\n"
        "- fluency: 0..100\n"
        "- naturalness: 0..100\n"
        "- ambiguity_preservation: 0..100\n"
        "- final_score: weighted overall 0..100\n"
        "- severity: one of critical|major|minor|none\n"
        "- issues: array of short issue objects with fields {type,severity,description}\n\n"
        "Return JSON object with keys: adequacy, fluency, naturalness, ambiguity_preservation, final_score, severity, issues, rationale_short."
    )


def call_gemini_json(prompt: str, model: str, api_key: str) -> Dict[str, object]:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        details = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(f"Gemini HTTP error {exc.code}: {details}") from exc
    except Exception as exc:
        raise RuntimeError(f"Gemini request failed: {exc}") from exc

    parsed = json.loads(raw)
    candidates = parsed.get("candidates", [])
    if not candidates:
        raise RuntimeError("Gemini returned no candidates.")
    text = (
        candidates[0]
        .get("content", {})
        .get("parts", [{}])[0]
        .get("text", "")
        .strip()
    )
    if not text:
        raise RuntimeError("Gemini candidate text was empty.")
    try:
        return json.loads(text)
    except Exception as exc:
        raise RuntimeError(f"Gemini did not return parseable JSON: {text[:200]}") from exc


def should_call_llm(row: RowTranslation, llm_only_flagged: bool) -> bool:
    if not llm_only_flagged:
        return True
    return row.needs_review


def run_llm_judge_stage(rows: List[RowTranslation], args: argparse.Namespace) -> None:
    if not args.run_llm_judge or not rows:
        return
    api_key = os.environ.get(args.gemini_api_key_env, "").strip()
    if not api_key:
        print(f"[llm] skipped: env var {args.gemini_api_key_env} is not set")
        return

    calls = 0
    for row in rows:
        if not should_call_llm(row, args.llm_only_flagged):
            continue
        if args.llm_max_calls > 0 and calls >= args.llm_max_calls:
            break
        prompt = build_llm_prompt(row)
        try:
            judged = call_gemini_json(prompt, args.gemini_model, api_key)
        except Exception as exc:
            row.notes.append(f"llm_error:{exc}")
            continue

        calls += 1
        final_score = float(judged.get("final_score", 0.0))
        severity = str(judged.get("severity", "none")).strip().lower()
        row.scores["llm_final"] = final_score
        row.metadata["llm"] = judged

        if final_score < args.gemini_threshold:
            row.needs_review = True
            row.review_reasons.append(f"llm<{args.gemini_threshold:.1f}")
        if severity in {"critical", "major"}:
            row.needs_review = True
            row.review_reasons.append(f"llm_severity:{severity}")


def summarize(rows: List[RowTranslation]) -> Dict[str, object]:
    consistency_scores = [r.scores["consistency"] for r in rows if "consistency" in r.scores]
    comet_scores = [r.scores["comet"] for r in rows if "comet" in r.scores]
    llm_scores = [r.scores["llm_final"] for r in rows if "llm_final" in r.scores]
    flagged = [r for r in rows if r.needs_review]
    out = {
        "rows_total": len(rows),
        "rows_flagged": len(flagged),
        "flag_rate": round((len(flagged) / len(rows)) if rows else 0.0, 4),
        "consistency": metric_summary(consistency_scores),
        "comet": metric_summary(comet_scores),
        "llm_final": metric_summary(llm_scores),
    }
    by_lang: Dict[str, Dict[str, int]] = {}
    for row in rows:
        lang = row.target_lang
        if lang not in by_lang:
            by_lang[lang] = {"total": 0, "flagged": 0}
        by_lang[lang]["total"] += 1
        if row.needs_review:
            by_lang[lang]["flagged"] += 1
    out["by_language"] = by_lang
    return out


def metric_summary(values: Sequence[float]) -> Dict[str, object]:
    if not values:
        return {"count": 0}
    return {
        "count": len(values),
        "mean": round(float(statistics.mean(values)), 4),
        "median": round(float(statistics.median(values)), 4),
        "min": round(float(min(values)), 4),
        "max": round(float(max(values)), 4),
        "p10": round(float(np.percentile(np.array(values, dtype=np.float32), 10)), 4),
        "p90": round(float(np.percentile(np.array(values, dtype=np.float32), 90)), 4),
    }


def write_outputs(rows: List[RowTranslation], args: argparse.Namespace) -> Tuple[Path, Path]:
    csv_path = Path(args.output_csv).expanduser().resolve()
    json_path = Path(args.summary_json).expanduser().resolve()
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.parent.mkdir(parents=True, exist_ok=True)

    fields = [
        "item_id",
        "row_index",
        "target_lang",
        "source_text",
        "target_text",
        "consistency_score",
        "comet_score",
        "llm_final_score",
        "needs_review",
        "review_reasons",
        "notes",
    ]

    with csv_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        for row in rows:
            writer.writerow(
                {
                    "item_id": row.item_id,
                    "row_index": row.row_index,
                    "target_lang": row.target_lang,
                    "source_text": row.source_text,
                    "target_text": row.target_text,
                    "consistency_score": row.scores.get("consistency", ""),
                    "comet_score": row.scores.get("comet", ""),
                    "llm_final_score": row.scores.get("llm_final", ""),
                    "needs_review": "yes" if row.needs_review else "no",
                    "review_reasons": ";".join(sorted(set(row.review_reasons))),
                    "notes": ";".join(row.notes),
                }
            )

    payload = {
        "summary": summarize(rows),
        "rows": [
            {
                "itemId": r.item_id,
                "rowIndex": r.row_index,
                "targetLang": r.target_lang,
                "scores": r.scores,
                "needsReview": r.needs_review,
                "reviewReasons": sorted(set(r.review_reasons)),
                "metadata": r.metadata,
            }
            for r in rows
        ],
    }
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return csv_path, json_path


def main() -> int:
    args = parse_args()
    rows, target_cols = load_rows(args)
    if not rows:
        print("No rows loaded after filtering missing source/target text.")
        return 1

    print(f"Loaded {len(rows)} source-target pairs across {len(target_cols)} target columns.")
    run_consistency_stage(rows, args)
    run_comet_stage(rows, args)
    run_llm_judge_stage(rows, args)
    csv_path, json_path = write_outputs(rows, args)

    summary = summarize(rows)
    print("Pipeline complete.")
    print(f"Report CSV: {csv_path}")
    print(f"Summary JSON: {json_path}")
    print(f"Flagged: {summary['rows_flagged']} / {summary['rows_total']} ({summary['flag_rate'] * 100:.1f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

