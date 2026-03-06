#!/usr/bin/env python3
"""
Generate a PDF summary report for embedding model comparisons.

Inputs are the CSV/JSON outputs from embedding_multidataset_model_compare.py.
"""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

import matplotlib.pyplot as plt
from matplotlib.backends.backend_pdf import PdfPages


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Create PDF summary from embedding model compare outputs.")
    p.add_argument(
        "--compare-prefix",
        default="data/validation/embedding-model-compare",
        help="Output prefix used by the compare script.",
    )
    p.add_argument(
        "--output-pdf",
        default="",
        help="Optional PDF output path (defaults to <compare-prefix>-summary.pdf).",
    )
    return p.parse_args()


def read_csv(path: Path) -> List[Dict[str, str]]:
    with path.open("r", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def safe_float(value: str) -> float | None:
    if value is None:
        return None
    value = value.strip()
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def unique_order(values: Iterable[str]) -> List[str]:
    seen = set()
    ordered: List[str] = []
    for value in values:
        if value in seen:
            continue
        seen.add(value)
        ordered.append(value)
    return ordered


def build_matrix(
    rows: List[Dict[str, str]],
    metric: str,
) -> Tuple[List[str], List[str], List[List[float | None]]]:
    models = unique_order([r["model"] for r in rows if r.get("model")])
    targets = unique_order([r["target_col"] for r in rows if r.get("target_col")])
    matrix: List[List[float | None]] = []
    for model in models:
        row_vals: List[float | None] = []
        for target in targets:
            match = next(
                (r for r in rows if r.get("model") == model and r.get("target_col") == target),
                None,
            )
            row_vals.append(safe_float(match.get(metric)) if match else None)
        matrix.append(row_vals)
    return models, targets, matrix


def format_percent(value: float | None) -> str:
    if value is None:
        return "—"
    return f"{value * 100:.2f}%"


def format_float(value: float | None) -> str:
    if value is None:
        return "—"
    return f"{value:.4f}"


def add_table_page(
    pdf: PdfPages,
    title: str,
    models: List[str],
    targets: List[str],
    matrix: List[List[float | None]],
    formatter,
    footnote: str | None = None,
) -> None:
    fig, ax = plt.subplots(figsize=(11, 8.5))
    ax.axis("off")
    cell_text = [[formatter(v) for v in row] for row in matrix]
    table = ax.table(
        cellText=cell_text,
        rowLabels=models,
        colLabels=targets,
        cellLoc="center",
        loc="center",
    )
    table.auto_set_font_size(False)
    table.set_fontsize(9)
    table.scale(1, 1.4)
    ax.set_title(title, fontsize=14, pad=20)
    if footnote:
        fig.text(0.5, 0.03, footnote, ha="center", fontsize=9)
    pdf.savefig(fig, bbox_inches="tight")
    plt.close(fig)


def add_text_page(pdf: PdfPages, title: str, lines: List[str]) -> None:
    fig, ax = plt.subplots(figsize=(11, 8.5))
    ax.axis("off")
    ax.set_title(title, fontsize=16, pad=20)
    fig.text(0.08, 0.85, "\n".join(lines), ha="left", va="top", fontsize=11)
    pdf.savefig(fig, bbox_inches="tight")
    plt.close(fig)


def load_summary_json(path: Path) -> Dict[str, object]:
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def main() -> None:
    args = parse_args()
    compare_prefix = Path(args.compare_prefix).expanduser().resolve()
    output_pdf = (
        Path(args.output_pdf).expanduser().resolve()
        if args.output_pdf
        else Path(str(compare_prefix) + "-summary.pdf")
    )

    surveys_summary_csv = Path(str(compare_prefix) + "-surveys-summary.csv")
    itembank_summary_csv = Path(str(compare_prefix) + "-itembank-summary.csv")
    surveys_summary_json = Path(str(compare_prefix) + "-surveys-summary.json")
    itembank_summary_json = Path(str(compare_prefix) + "-itembank-summary.json")
    rollup_summary_json = Path(str(compare_prefix) + "-rollup-summary.json")

    if not surveys_summary_csv.exists() and not itembank_summary_csv.exists():
        raise FileNotFoundError(
            "No summary CSVs found. Expected at least one of: "
            f"{surveys_summary_csv} or {itembank_summary_csv}"
        )

    with PdfPages(output_pdf) as pdf:
        title_lines = [
            "Embedding Model Compare",
            f"Prefix: {compare_prefix}",
        ]
        if rollup_summary_json.exists():
            rollup = load_summary_json(rollup_summary_json)
            datasets = ", ".join(rollup.get("datasets", []))
            models = ", ".join(rollup.get("models", []))
            title_lines.extend(
                [
                    f"Datasets: {datasets}",
                    f"Models: {models}",
                ]
            )
        add_text_page(pdf, "Embedding Model Compare Summary", title_lines)

        if surveys_summary_json.exists():
            surveys_json = load_summary_json(surveys_summary_json)
            thresholds = surveys_json.get("summary_rows", [])
            if thresholds:
                min_score = thresholds[0].get("min_score")
                warn_score = thresholds[0].get("warn_score")
                add_text_page(
                    pdf,
                    "Surveys Context",
                    [
                        f"Source: {surveys_json.get('source', '')}",
                        f"Targets: {', '.join(surveys_json.get('targets', []))}",
                        f"Pass threshold: {min_score}",
                        f"Review threshold: {warn_score}",
                    ],
                )

        if surveys_summary_csv.exists():
            rows = read_csv(surveys_summary_csv)
            models, targets, matrix = build_matrix(rows, "pass_rate")
            add_table_page(
                pdf,
                "Surveys - Pass Rate by Model/Target",
                models,
                targets,
                matrix,
                format_percent,
                footnote="Pass rate = pass_count / count",
            )
            models, targets, matrix = build_matrix(rows, "mean")
            add_table_page(
                pdf,
                "Surveys - Mean Similarity by Model/Target",
                models,
                targets,
                matrix,
                format_float,
            )

        if itembank_summary_json.exists():
            itembank_json = load_summary_json(itembank_summary_json)
            thresholds = itembank_json.get("summary_rows", [])
            if thresholds:
                min_score = thresholds[0].get("min_score")
                warn_score = thresholds[0].get("warn_score")
                add_text_page(
                    pdf,
                    "Item Bank Context",
                    [
                        f"Source: {itembank_json.get('source', '')}",
                        f"Targets: {', '.join(itembank_json.get('targets', []))}",
                        f"Pass threshold: {min_score}",
                        f"Review threshold: {warn_score}",
                    ],
                )

        if itembank_summary_csv.exists():
            rows = read_csv(itembank_summary_csv)
            models, targets, matrix = build_matrix(rows, "pass_rate")
            add_table_page(
                pdf,
                "Item Bank - Pass Rate by Model/Target",
                models,
                targets,
                matrix,
                format_percent,
                footnote="Pass rate = pass_count / count",
            )
            models, targets, matrix = build_matrix(rows, "mean")
            add_table_page(
                pdf,
                "Item Bank - Mean Similarity by Model/Target",
                models,
                targets,
                matrix,
                format_float,
            )

    print(f"PDF report written to: {output_pdf}")


if __name__ == "__main__":
    main()
