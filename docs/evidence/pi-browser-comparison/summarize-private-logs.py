"""Offline allowlist export. Never copies prompts, reasoning, commands or outputs."""
import hashlib
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def number(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value
    return None


def summarize(path):
    raw = path.read_bytes()
    result = {"source": str(path.relative_to(ROOT)), "raw_sha256": hashlib.sha256(raw).hexdigest(),
              "raw_bytes": len(raw), "assistant_calls": [], "tool_completions": [], "non_json_lines": 0}
    for line in raw.decode().splitlines():
        try:
            event = json.loads(line)
        except (ValueError, TypeError):
            result["non_json_lines"] += 1
            continue
        if event.get("type") == "message_end":
            message = event.get("message", {})
            if message.get("role") != "assistant":
                continue
            usage = message.get("usage")
            safe_usage = None if not isinstance(usage, dict) else {
                **{key: number(usage.get(key)) for key in ["input", "output", "cacheRead", "reasoning"]},
                "estimated_cost_usd": number((usage.get("cost") or {}).get("total")),
            }
            tools = [part.get("name") if part.get("name") in ["read", "bash"] else "other"
                     for part in message.get("content", []) if part.get("type") == "toolCall"]
            result["assistant_calls"].append({"usage": safe_usage, "tools": tools})
        elif event.get("type") == "tool_execution_end":
            error = event.get("isError")
            result["tool_completions"].append({
                "tool": event.get("toolName") if event.get("toolName") in ["read", "bash"] else "other",
                "is_error": error if isinstance(error, bool) else None,
            })
    results_file = path.parent / "results.json"
    rows = json.loads(results_file.read_text()) if results_file.exists() else []
    result["has_result"] = any(path.stem == f"{row['arm']}-{row['repeat']}" for row in rows)
    return result


def main():
    paths = sorted(path for path in ROOT.rglob("*.jsonl") if "private-originals" not in path.parts)
    if not paths:
        raise SystemExit("No private logs present; refusing to replace the published summary")
    output = {"schema_version": 1,
              "note": "Allowlisted counts/usage only. No reasoning content, prompts, tool arguments or outputs. This export cannot independently prove UI behavior or adherence to task constraints. Raw logs are not distributed.",
              "runs": [summarize(path) for path in paths]}
    (ROOT / "compact-events.json").write_text(json.dumps(output, indent=2) + "\n")
    print(f"Exported {len(paths)} private logs as compact event summaries")


if __name__ == "__main__":
    main()
