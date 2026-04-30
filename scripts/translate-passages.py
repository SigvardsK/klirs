#!/usr/bin/env python3
"""Translate src/lib/i18n/messages/en.json → lv.draft.json via TildeOpen on Modal.

One-off translation pipeline. Per LR-WS-2026-031, base-model TildeOpen is used
for direct passage translation only — no briefs, no structured inputs.
The output requires a native-LV post-edit before becoming lv.json.

Usage:
    python scripts/translate-passages.py

Env (loaded from .env.local, then ../tildeopen-eval/.env, then process env):
    TILDEOPEN_BASE_URL — Modal endpoint, e.g. https://...modal.run
    TILDEOPEN_API_KEY — bearer token

Outputs:
    src/lib/i18n/messages/lv.draft.json     — first-pass LV
    src/lib/i18n/messages/lv.draft.review.md — review sidecar (key/EN/LV table)

After review, rename lv.draft.json → lv.json (overwrites placeholder).
"""

from __future__ import annotations

import json
import os
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EN_PATH = ROOT / "src" / "lib" / "i18n" / "messages" / "en.json"
LV_DRAFT_PATH = ROOT / "src" / "lib" / "i18n" / "messages" / "lv.draft.json"
REVIEW_PATH = ROOT / "src" / "lib" / "i18n" / "messages" / "lv.draft.review.md"

ENV_FILES = [
    ROOT / ".env.local",
    ROOT.parent / "tildeopen-eval" / ".env",
]


def load_env() -> None:
    for env_file in ENV_FILES:
        if not env_file.exists():
            continue
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            os.environ.setdefault(key, val)


load_env()

BASE_URL = os.environ.get("TILDEOPEN_BASE_URL")
API_KEY = os.environ.get("TILDEOPEN_API_KEY")

if not BASE_URL or not API_KEY:
    print(
        "ERROR: TILDEOPEN_BASE_URL and TILDEOPEN_API_KEY must be set.\n"
        "Copy from Projects/tildeopen-eval/.env into aml-demo/.env.local.",
        file=sys.stderr,
    )
    sys.exit(1)

from openai import OpenAI

client = OpenAI(base_url=BASE_URL.rstrip("/") + "/v1", api_key=API_KEY)
MODEL_ID = "TildeAI/TildeOpen-30b-64k"

PROMPT_TEMPLATE = """Translate the following English passage into formal Latvian (register: marketing).
Use idiomatic Latvian for compliance and tech concepts; do NOT paste English nouns into Latvian sentences. Do NOT include English glosses.

Example translation:
EN: "Client risk assessment form"
LV: "Klienta risku novērtējuma veidlapa"

EN: "{passage}"
LV:"""


def detect_repetition_loop(text: str, n: int = 8, threshold: int = 3) -> bool:
    tokens = text.split()
    if len(tokens) < n * threshold:
        return False
    ngrams = [" ".join(tokens[i : i + n]) for i in range(len(tokens) - n + 1)]
    counts = Counter(ngrams)
    return any(c > threshold for c in counts.values())


def translate(passage: str) -> tuple[str, bool]:
    """Returns (translation, needs_retranslate)."""
    safe_passage = passage.replace('"', '\\"')
    resp = client.completions.create(
        model=MODEL_ID,
        prompt=PROMPT_TEMPLATE.format(passage=safe_passage),
        temperature=0.7,
        top_p=0.9,
        max_tokens=1024,
        stop=["\nEN:", "\n\nEN:", "<|endoftext|>"],
    )
    out = resp.choices[0].text.strip()
    if out.startswith('"') and out.endswith('"'):
        out = out[1:-1]
    needs_retranslate = detect_repetition_loop(out)
    return out, needs_retranslate


def flatten(obj, prefix=""):
    if isinstance(obj, dict):
        if not obj:
            return
        for k, v in obj.items():
            yield from flatten(v, f"{prefix}.{k}" if prefix else k)
    elif isinstance(obj, str):
        yield prefix, obj


def set_at(obj: dict, path: str, value) -> None:
    parts = path.split(".")
    cur = obj
    for p in parts[:-1]:
        cur = cur.setdefault(p, {})
    cur[parts[-1]] = value


def main() -> None:
    en = json.loads(EN_PATH.read_text(encoding="utf-8"))
    lv_draft: dict = {}
    review_rows = []

    flat = list(flatten(en))
    print(f"Translating {len(flat)} passages...", file=sys.stderr)

    for i, (key, value) in enumerate(flat, 1):
        print(f"  [{i:>2}/{len(flat)}] {key}", file=sys.stderr)
        try:
            lv, needs_retranslate = translate(value)
            if needs_retranslate:
                lv = "<NEEDS_RETRANSLATE>"
            set_at(lv_draft, key, lv)
            review_rows.append((key, value, lv))
        except Exception as e:
            print(f"    ERROR: {e}", file=sys.stderr)
            set_at(lv_draft, key, "<NEEDS_RETRANSLATE>")
            review_rows.append((key, value, f"<ERROR: {e}>"))

    # Preserve reserved-empty namespaces (screening.*, annex.*) for future migration
    for ns in ("screening", "annex"):
        if ns in en and isinstance(en[ns], dict) and not en[ns]:
            lv_draft[ns] = {}

    LV_DRAFT_PATH.write_text(
        json.dumps(lv_draft, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )

    lines = [
        "# Klirs LV translation review",
        "",
        "Source: TildeOpen-30b-64k (base model, Modal vLLM endpoint).",
        "Per LR-WS-2026-031: native-LV post-edit is non-negotiable before this becomes `lv.json`.",
        "",
        "**Markup keys:** `audit.body` contains `<strong>` and `<code>` ICU placeholder tags. Verify TildeOpen preserved them; if not, re-insert manually around the equivalent LV phrasing.",
        "",
        "**`<NEEDS_RETRANSLATE>`:** repetition loop or API error — translate by hand.",
        "",
        "After review, rename `lv.draft.json` → `lv.json`.",
        "",
        "| Key | EN | LV (TildeOpen first-pass) |",
        "|-----|----|---------------------------|",
    ]
    for key, en_val, lv_val in review_rows:
        en_cell = en_val.replace("|", "\\|").replace("\n", " ")
        lv_cell = lv_val.replace("|", "\\|").replace("\n", " ")
        lines.append(f"| `{key}` | {en_cell} | {lv_cell} |")
    REVIEW_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"\nWrote {LV_DRAFT_PATH.relative_to(ROOT)}", file=sys.stderr)
    print(f"Wrote {REVIEW_PATH.relative_to(ROOT)}", file=sys.stderr)
    print(
        "\nNext step: Sigvards reviews lv.draft.review.md, edits lv.draft.json,\n"
        "then renames it to lv.json.",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
