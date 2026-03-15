#!/usr/bin/env python3
"""
Benchmark Google vs Hugging Face back-translation providers.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import statistics
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Set, Tuple

from hf_backtranslation import MODEL_NAME as HF_MODEL_NAME
from hf_backtranslation import translate_to_english


PASS_THRESHOLD = 90.0
REVIEW_THRESHOLD = 80.0


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Benchmark back-translation providers on labeled rows.")
    p.add_argument("--translations-csv", default="data/validation/crowdin-xliff-merged.csv")
    p.add_argument("--labels-csv", default="data/validation/human-review-seed-es-AR.csv")
    p.add_argument("--source-col", default="en")
    p.add_argument("--target-col", default="es-AR")
    p.add_argument("--id-col", default="identifier")
    p.add_argument("--k-values", default="43,86,129")
    p.add_argument(
        "--providers",
        default="google,hf",
        help="Comma-separated providers: google,hf",
    )
    p.add_argument(
        "--google-api-url",
        default="https://levante-pitwall.vercel.app/api/google-translate",
        help="Baseline endpoint matching current validation path.",
    )
    p.add_argument(
        "--semantic-api-url",
        default="https://levante-pitwall.vercel.app/api/translation-semantic-score",
    )
    p.add_argument("--google-api-key", default="", help="Optional bearer key for google API endpoint.")
    p.add_argument("--output-prefix", default="data/validation/backtranslation-provider-benchmark-es-AR")
    return p.parse_args()


def canonical_lang(value: str) -> str:
    raw = str(value or "").strip().replace("_", "-")
    if not raw:
        return ""
    parts = raw.split("-")
    if len(parts) == 1:
        return parts[0].lower()
    return f"{parts[0].lower()}-{parts[1].upper()}"


def map_to_google_translate_code(lang_code: str) -> str:
    m = {
        "es-CO": "es",
        "es-AR": "es",
        "fr-CA": "fr",
        "de-CH": "de",
        "de-DE": "de",
        "en-US": "en",
        "en-GB": "en",
        "en-GH": "en",
    }
    c = canonical_lang(lang_code)
    return m.get(c, c.split("-")[0] if c else "")


def tokenize_validation_words(text: str) -> List[str]:
    out = "".join(ch if (ch.isalnum() or ch in " '-") else " " for ch in str(text or "").lower())
    return [w.strip() for w in out.split() if w.strip()]


def levenshtein_distance(a: str, b: str) -> int:
    s = str(a or "")
    t = str(b or "")
    m = len(s)
    n = len(t)
    if m == 0:
        return n
    if n == 0:
        return m
    dp = [[0] * (n + 1) for _ in range(m + 1)]
    for i in range(m + 1):
        dp[i][0] = i
    for j in range(n + 1):
        dp[0][j] = j
    for i in range(1, m + 1):
        for j in range(1, n + 1):
            cost = 0 if s[i - 1] == t[j - 1] else 1
            dp[i][j] = min(
                dp[i - 1][j] + 1,
                dp[i][j - 1] + 1,
                dp[i - 1][j - 1] + cost,
            )
    return dp[m][n]


def compute_lexical_score(original: str, back: str) -> float:
    src = str(original or "").strip().lower()
    bt = str(back or "").strip().lower()
    if not src or not bt:
        return 0.0
    if src == bt:
        return 100.0
    distance = levenshtein_distance(src, bt)
    max_len = max(len(src), len(bt), 1)
    score = 100.0 * (1.0 - (distance / max_len))
    return max(0.0, min(100.0, round(score, 2)))


def compute_legacy_overlap_score(original: str, back: str) -> float:
    o = tokenize_validation_words(original)
    b = tokenize_validation_words(back)
    if not o or not b:
        return 0.0
    bset = set(b)
    common = sum(1 for w in o if w in bset)
    similarity = common / max(len(o), len(b))
    return round(similarity * 100.0, 2)


def is_vocab_like_pair(original: str, translated: str) -> bool:
    o = tokenize_validation_words(original)
    t = tokenize_validation_words(translated)
    source_chars = len(str(original or "").strip())
    target_chars = len(str(translated or "").strip())
    return len(o) <= 3 and len(t) <= 3 and source_chars <= 40 and target_chars <= 60


def compute_composite_score(semantic_score: float, lexical_score: float, is_vocab_like: bool) -> float:
    sem = float(semantic_score) if isinstance(semantic_score, (int, float)) and math.isfinite(semantic_score) else 0.0
    lex = float(lexical_score) if isinstance(lexical_score, (int, float)) and math.isfinite(lexical_score) else 0.0
    weighted = (0.35 * sem + 0.65 * lex) if is_vocab_like else (0.80 * sem + 0.20 * lex)
    return max(0.0, min(100.0, round(weighted, 2)))


def status_from_score(score: float) -> str:
    if score >= PASS_THRESHOLD:
        return "pass"
    if score >= REVIEW_THRESHOLD:
        return "review"
    return "fail"


def parse_k_values(raw: str) -> List[int]:
    out = []
    for token in str(raw or "").split(","):
        token = token.strip()
        if not token:
            continue
        try:
            v = int(token)
            if v > 0:
                out.append(v)
        except Exception:
            continue
    return sorted(set(out))


def request_json(url: str, method: str = "GET", body: dict | None = None, headers: Dict[str, str] | None = None) -> dict:
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url=url, data=data, headers=req_headers, method=method)
    with urllib.request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8"))


def google_back_translate(text: str, source_lang: str, google_api_url: str, google_api_key: str) -> str:
    params = urllib.parse.urlencode({"text": text, "from": source_lang, "to": "en"})
    url = f"{google_api_url}?{params}"
    headers = {}
    if google_api_key:
        headers["Authorization"] = f"Bearer {google_api_key}"
    data = request_json(url, method="GET", headers=headers)
    return str(data.get("translatedText") or "").strip()


def semantic_score_from_api(original: str, back: str, lang: str, semantic_api_url: str) -> Tuple[float, str]:
    try:
        data = request_json(
            semantic_api_url,
            method="POST",
            body={"originalText": original, "backTranslation": back, "langCode": lang},
        )
        if data.get("ok") is True and isinstance(data.get("semantic_score"), (int, float)):
            return float(data["semantic_score"]), str(data.get("modelUsed") or "")
    except Exception:
        pass
    return compute_legacy_overlap_score(original, back), "word-overlap-fallback"


def load_labels(labels_csv: Path, target_col: str) -> Tuple[Dict[str, dict], Set[str]]:
    label_rows: Dict[str, dict] = {}
    human_positive: Set[str] = set()
    tc = canonical_lang(target_col)
    with labels_csv.open("r", encoding="utf-8", newline="") as f:
        rd = csv.DictReader(f)
        for row in rd:
            lang = canonical_lang(row.get("lang_code", ""))
            if lang != tc:
                continue
            item_id = str(row.get("item_id", "")).strip()
            if not item_id:
                continue
            label_rows[item_id] = row
            cohort = str(row.get("cohort", "")).strip().lower()
            needs_flag = str(row.get("needs_review_flag", "")).strip().lower()
            if cohort == "positive_needs_review" or needs_flag in {"1", "true"}:
                human_positive.add(item_id)
    return label_rows, human_positive


def load_translation_rows(translations_csv: Path, id_col: str, source_col: str, target_col: str) -> Dict[str, dict]:
    rows: Dict[str, dict] = {}
    with translations_csv.open("r", encoding="utf-8", newline="") as f:
        rd = csv.DictReader(f)
        for row in rd:
            item_id = str(row.get(id_col, "")).strip()
            if not item_id:
                continue
            src = str(row.get(source_col, "") or "").strip()
            tgt = str(row.get(target_col, "") or "").strip()
            if not src or not tgt:
                continue
            rows[item_id] = row
    return rows


def evaluate_topk(provider_rows: List[dict], human_positive: Set[str], k_values: List[int]) -> List[dict]:
    ranked = sorted(provider_rows, key=lambda r: float(r["composite_score"]))
    ranked_ids = [str(r["item_id"]) for r in ranked]
    ranked_set = set(ranked_ids)
    human_scored = human_positive & ranked_set
    out = []
    for k in k_values:
        kk = min(k, len(ranked_ids))
        top = set(ranked_ids[:kk])
        overlap = len(top & human_positive)
        overlap_scored = len(top & human_scored)
        precision = (overlap / kk) if kk else 0.0
        recall = (overlap / len(human_positive)) if human_positive else 0.0
        recall_scored = (overlap_scored / len(human_scored)) if human_scored else 0.0
        out.append(
            {
                "k": kk,
                "ranked_count": len(ranked_ids),
                "human_count": len(human_positive),
                "human_scored_count": len(human_scored),
                "overlap_count": overlap,
                "overlap_scored_count": overlap_scored,
                "precision": round(precision, 6),
                "recall": round(recall, 6),
                "recall_scored": round(recall_scored, 6),
            }
        )
    return out


def main() -> int:
    args = parse_args()
    translations_csv = Path(args.translations_csv)
    labels_csv = Path(args.labels_csv)
    output_prefix = Path(args.output_prefix)
    output_prefix.parent.mkdir(parents=True, exist_ok=True)
    providers = [p.strip().lower() for p in str(args.providers).split(",") if p.strip()]
    k_values = parse_k_values(args.k_values) or [43]

    label_rows, human_positive = load_labels(labels_csv, args.target_col)
    translation_rows = load_translation_rows(translations_csv, args.id_col, args.source_col, args.target_col)

    ids = sorted(set(label_rows.keys()) & set(translation_rows.keys()))
    if not ids:
        raise SystemExit("No overlapping ids between labels and translation CSV.")
    if not human_positive:
        raise SystemExit("No human positive needs-review ids found in labels CSV.")

    google_source_lang = map_to_google_translate_code(args.target_col)
    provider_rows_all: List[dict] = []

    for item_id in ids:
        row = translation_rows[item_id]
        source_text = str(row.get(args.source_col, "")).strip()
        translated_text = str(row.get(args.target_col, "")).strip()
        vocab_like = is_vocab_like_pair(source_text, translated_text)
        human_needs_review = 1 if item_id in human_positive else 0
        for provider in providers:
            if provider == "google":
                back_translation = google_back_translate(
                    text=translated_text,
                    source_lang=google_source_lang,
                    google_api_url=args.google_api_url,
                    google_api_key=args.google_api_key,
                )
                back_model = "google-translate-v2"
            elif provider == "hf":
                back_translation = translate_to_english(translated_text, source_locale=args.target_col)
                back_model = HF_MODEL_NAME
            else:
                continue

            lexical = compute_lexical_score(source_text, back_translation)
            semantic, semantic_model = semantic_score_from_api(
                original=source_text,
                back=back_translation,
                lang=args.target_col,
                semantic_api_url=args.semantic_api_url,
            )
            composite = compute_composite_score(semantic, lexical, vocab_like)
            provider_rows_all.append(
                {
                    "item_id": item_id,
                    "provider": provider,
                    "provider_model": back_model,
                    "source_text": source_text,
                    "translated_text": translated_text,
                    "back_translation": back_translation,
                    "lexical_score": round(lexical, 2),
                    "semantic_score": round(semantic, 2),
                    "semantic_model": semantic_model,
                    "composite_score": round(composite, 2),
                    "status": status_from_score(composite),
                    "human_needs_review": human_needs_review,
                }
            )

    provider_to_rows: Dict[str, List[dict]] = {}
    for r in provider_rows_all:
        provider_to_rows.setdefault(str(r["provider"]), []).append(r)

    topk_rows: List[dict] = []
    provider_summary_rows: List[dict] = []
    for provider, rows in provider_to_rows.items():
        topk = evaluate_topk(rows, human_positive, k_values)
        for tk in topk:
            topk_rows.append({"provider": provider, **tk})
        composites = [float(r["composite_score"]) for r in rows]
        provider_summary_rows.append(
            {
                "provider": provider,
                "count": len(rows),
                "composite_mean": round(statistics.mean(composites), 4) if composites else 0.0,
                "composite_median": round(statistics.median(composites), 4) if composites else 0.0,
                "pass_count": sum(1 for r in rows if r["status"] == "pass"),
                "review_count": sum(1 for r in rows if r["status"] == "review"),
                "fail_count": sum(1 for r in rows if r["status"] == "fail"),
            }
        )

    # Provider disagreement analysis (pairwise on same id).
    disagreement_rows: List[dict] = []
    if "google" in provider_to_rows and "hf" in provider_to_rows:
        g = {str(r["item_id"]): r for r in provider_to_rows["google"]}
        h = {str(r["item_id"]): r for r in provider_to_rows["hf"]}
        common = sorted(set(g.keys()) & set(h.keys()))
        for item_id in common:
            rg = g[item_id]
            rh = h[item_id]
            diff = float(rh["composite_score"]) - float(rg["composite_score"])
            status_disagree = int(str(rh["status"]) != str(rg["status"]))
            disagreement_rows.append(
                {
                    "item_id": item_id,
                    "human_needs_review": rg["human_needs_review"],
                    "google_composite": rg["composite_score"],
                    "hf_composite": rh["composite_score"],
                    "delta_hf_minus_google": round(diff, 4),
                    "google_status": rg["status"],
                    "hf_status": rh["status"],
                    "status_disagree": status_disagree,
                    "source_text": rg["source_text"],
                    "translated_text": rg["translated_text"],
                    "google_back_translation": rg["back_translation"],
                    "hf_back_translation": rh["back_translation"],
                }
            )

    disagreement_rows.sort(key=lambda r: abs(float(r["delta_hf_minus_google"])), reverse=True)
    disagreement_count = sum(int(r["status_disagree"]) for r in disagreement_rows)

    details_csv = output_prefix.with_name(output_prefix.name + "-details.csv")
    topk_csv = output_prefix.with_name(output_prefix.name + "-topk.csv")
    summary_csv = output_prefix.with_name(output_prefix.name + "-summary.csv")
    disagreement_csv = output_prefix.with_name(output_prefix.name + "-disagreements.csv")
    summary_json = output_prefix.with_name(output_prefix.name + "-summary.json")

    def write_csv(path: Path, rows: List[dict]) -> None:
        if not rows:
            return
        with path.open("w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
            w.writeheader()
            w.writerows(rows)

    write_csv(details_csv, provider_rows_all)
    write_csv(topk_csv, topk_rows)
    write_csv(summary_csv, provider_summary_rows)
    write_csv(disagreement_csv, disagreement_rows)

    out = {
        "translations_csv": str(translations_csv),
        "labels_csv": str(labels_csv),
        "target_col": args.target_col,
        "source_col": args.source_col,
        "providers": providers,
        "human_positive_count": len(human_positive),
        "scored_item_count": len(ids),
        "k_values": k_values,
        "topk": topk_rows,
        "provider_summary": provider_summary_rows,
        "disagreement_count": disagreement_count,
        "disagreement_examples": disagreement_rows[:25],
        "outputs": {
            "details_csv": str(details_csv),
            "topk_csv": str(topk_csv),
            "summary_csv": str(summary_csv),
            "disagreement_csv": str(disagreement_csv),
            "summary_json": str(summary_json),
        },
    }
    summary_json.write_text(json.dumps(out, indent=2), encoding="utf-8")

    print(f"wrote {details_csv}")
    print(f"wrote {topk_csv}")
    print(f"wrote {summary_csv}")
    print(f"wrote {disagreement_csv}")
    print(f"wrote {summary_json}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

