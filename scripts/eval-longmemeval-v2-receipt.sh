#!/usr/bin/env bash
set -euo pipefail

# Bounded LongMemEval-V2 receipt.
#
# Default path is deterministic: run the checked-in V2 mini fixture through the
# same CLI shape used for real V2 roots. To test a downloaded HF dataset root,
# set GBRAIN_LME_V2_DATA_ROOT=/path/to/longmemeval-v2.
#
# Optional local reranker lane:
#   LLAMA_SERVER_RERANKER_BASE_URL=http://localhost:8081/v1 \
#   GBRAIN_LME_V2_LOCAL_RERANKER_MODEL=llama-server-reranker:qwen3-reranker-0.6b \
#   scripts/eval-longmemeval-v2-receipt.sh

ROOT="$(git rev-parse --show-toplevel)"
DATA_ROOT="${GBRAIN_LME_V2_DATA_ROOT:-$ROOT/test/fixtures/longmemeval-v2-mini}"
OUT_DIR="${1:-$ROOT/docs/eval/results/longmemeval-v2-fixture}"
LIMIT="${GBRAIN_LME_V2_LIMIT:-1}"
TOP_K="${GBRAIN_LME_V2_TOP_K:-2}"
LOCAL_RERANKER_MODEL="${GBRAIN_LME_V2_LOCAL_RERANKER_MODEL:-}"

mkdir -p "$OUT_DIR"

python3 - "$ROOT" "$DATA_ROOT" "$OUT_DIR" "$LIMIT" "$TOP_K" "$LOCAL_RERANKER_MODEL" <<'PY'
import json
import os
import pathlib
import subprocess
import sys
import time

root = pathlib.Path(sys.argv[1])
data_root = pathlib.Path(sys.argv[2])
out = pathlib.Path(sys.argv[3])
limit = sys.argv[4]
top_k = sys.argv[5]
local_reranker_model = sys.argv[6]

out.mkdir(parents=True, exist_ok=True)

def rel(path: pathlib.Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return str(path)

def read_jsonl(path: pathlib.Path):
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]

def run_lane(name, extra_args, reranker_setting, required=True):
    output = out / f"{name}.jsonl"
    log = out / f"{name}.log"
    if output.exists():
        output.unlink()
    cmd = [
        "bun", "src/cli.ts", "eval", "longmemeval",
        str(data_root),
        "--limit", limit,
        "--retrieval-only",
        "--top-k", top_k,
        "--by-type",
        "--by-type-floor", "1",
        "--no-trajectory",
        "--output", str(output),
        *extra_args,
    ]
    start = time.perf_counter()
    proc = subprocess.run(cmd, cwd=root, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    latency_ms = round((time.perf_counter() - start) * 1000)
    log.write_text(proc.stdout)
    rows = read_jsonl(output)
    question_rows = [row for row in rows if row.get("kind") != "by_type_summary"]
    first = question_rows[0] if question_rows else None
    summary = next((row for row in rows if row.get("kind") == "by_type_summary"), None)
    return {
        "name": name,
        "required": required,
        "command": " ".join(cmd),
        "exit_code": proc.returncode,
        "latency_ms": latency_ms,
        "reranker_setting": reranker_setting,
        "output_path": rel(output),
        "log_path": rel(log),
        "row_count": len(rows),
        "first_question_row": first,
        "summary": summary,
        "passes_gate": (
            proc.returncode == 0
            and first is not None
            and first.get("dataset_schema") == "longmemeval-v2"
            and first.get("recall_hit") is True
        ),
    }

lanes = [
    run_lane(
        "keyword-only",
        ["--keyword-only", "--mode", "conservative"],
        {"enabled": False, "model": None, "note": "--keyword-only disables vector and rerank paths"},
    ),
    run_lane(
        "hybrid-conservative",
        ["--mode", "conservative"],
        {"enabled": False, "model": None, "note": "hybrid path with conservative mode; reranker disabled by mode"},
        required=False,
    ),
]

if local_reranker_model:
    lanes.append(run_lane(
        "local-reranker",
        ["--mode", "balanced", "--reranker-model", local_reranker_model],
        {
            "enabled": True,
            "model": local_reranker_model,
            "base_url": os.environ.get("LLAMA_SERVER_RERANKER_BASE_URL", "http://localhost:8081/v1"),
            "note": "requires a reachable llama-server --reranking process",
        },
        required=False,
    ))
else:
    lanes.append({
        "name": "local-reranker",
        "required": False,
        "skipped": True,
        "reranker_setting": {
            "enabled": True,
            "model": "not configured",
            "note": "set GBRAIN_LME_V2_LOCAL_RERANKER_MODEL to run this lane",
        },
        "passes_gate": None,
    })

receipt = {
    "schema_version": 2,
    "generated_at": subprocess.check_output(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"], text=True).strip(),
    "repo_commit": subprocess.check_output(["git", "rev-parse", "--short", "HEAD"], cwd=root, text=True).strip(),
    "dataset": {
        "path": rel(data_root),
        "kind": "longmemeval-v2-root" if (data_root / "questions.jsonl").exists() else "unknown",
        "v2_tier": "small",
        "limit": int(limit),
        "top_k": int(top_k),
    },
    "lanes": lanes,
}

(out / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")

required_failures = [lane for lane in lanes if lane.get("required") and not lane.get("passes_gate")]

lines = []
lines.append("# LongMemEval-V2 Tracking Receipt")
lines.append("")
lines.append("Generated by `scripts/eval-longmemeval-v2-receipt.sh`.")
lines.append("")
lines.append("## Decision")
lines.append("")
if required_failures:
    lines.append("The pinned V2 receipt did not pass. Treat this as a harness regression until the required lanes recover.")
else:
    lines.append("The current LongMemEval harness loads a V2 root and records recall evidence on the pinned fixture. This is enough to keep V2 tracking alive without pretending a full HF sweep has run.")
lines.append("")
lines.append("## Dataset")
lines.append("")
lines.append(f"- Path: `{receipt['dataset']['path']}`")
lines.append(f"- Repo commit: `{receipt['repo_commit']}`")
lines.append(f"- Limit: `{limit}`")
lines.append(f"- Top K: `{top_k}`")
lines.append("")
lines.append("## Matrix")
lines.append("")
lines.append("| Lane | Required | Exit | Recall hit | Latency ms | Reranker | Status | Output |")
lines.append("|---|---:|---:|---:|---:|---|---|---|")
for lane in lanes:
    if lane.get("skipped"):
        lines.append(f"| `{lane['name']}` | no | skipped | n/a | n/a | {lane['reranker_setting']['note']} | not configured | n/a |")
        continue
    first = lane.get("first_question_row") or {}
    reranker = lane["reranker_setting"].get("model") or lane["reranker_setting"].get("note", "none")
    status = "pass" if lane.get("passes_gate") else first.get("error", "no recall hit")
    lines.append(
        f"| `{lane['name']}` | {'yes' if lane['required'] else 'no'} | `{lane['exit_code']}` | "
        f"`{first.get('recall_hit')}` | `{lane['latency_ms']}` | `{reranker}` | `{status}` | `{lane['output_path']}` |"
    )
lines.append("")
lines.append("## Local Reranker Probe")
lines.append("")
lines.append("Run this only when a local llama.cpp reranker is actually listening:")
lines.append("")
lines.append("```bash")
lines.append("LLAMA_SERVER_RERANKER_BASE_URL=http://localhost:8081/v1 \\")
lines.append("GBRAIN_LME_V2_LOCAL_RERANKER_MODEL=llama-server-reranker:qwen3-reranker-0.6b \\")
lines.append("scripts/eval-longmemeval-v2-receipt.sh")
lines.append("```")
lines.append("")
lines.append("Start with `Qwen3-Reranker-0.6B`, then `Qwen3-Reranker-4B` only if the smaller lane shows useful recall or ranking movement for acceptable latency. Keep `Qwen3-Reranker-8B` and `BAAI/bge-reranker-v2-m3` as later comparison candidates.")
lines.append("")
lines.append("## Still Not Proven")
lines.append("")
lines.append("- This fixture receipt is not a full LongMemEval-V2 benchmark sweep.")
lines.append("- Public V2 haystacks do not carry private answer labels unless labels are supplied, so recall gates require a labeled fixture or labeled local copy.")
lines.append("- A local reranker comparison is skipped unless a reachable `llama-server --reranking` process is configured.")
lines.append("")

(out / "README.md").write_text("\n".join(lines))

print(out)
if required_failures:
    sys.exit(1)
PY
