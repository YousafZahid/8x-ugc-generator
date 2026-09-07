#!/usr/bin/env python3
"""
8x assignment agent-capture hook.

Fires automatically on two Claude Code lifecycle events:

  UserPromptSubmit -> appends a [LOG_ENTRY type=PROMPT] block
  Stop             -> appends a [LOG_ENTRY type=RESPONSE] block

Both events deliver a JSON payload on stdin. UserPromptSubmit carries the raw
prompt text; Stop carries `transcript_path`, a JSONL file of the whole session
from which we take the final assistant message.

Deliberately stateless: the entry number is derived by counting existing PROMPT
blocks in the log file, so there is no sidecar state to corrupt, to gitignore,
or to get out of sync if a session is resumed.

Never raises. A capture hook that breaks the session it is capturing is worse
than one that misses an entry, so every failure path writes to
.agent-logs/.capture-errors.log and exits 0.
"""

import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

FALLBACK_MODEL = "claude-opus-5[1m]"
FALLBACK_AUTHOR = "YousafZahid"


# Secrets must never reach .agent-logs/. The log is a committed deliverable on
# a public repo, and prompts are captured verbatim - one pasted key block is
# enough to leak. GitHub push protection caught exactly this once; this is the
# belt to that braces.
SECRET_PATTERNS = [
    # Provider-specific formats, matched on their distinctive prefixes.
    re.compile(r"\bgsk_[A-Za-z0-9]{20,}"),                 # Groq
    re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}"),              # Google
    re.compile(r"\brnd_[A-Za-z0-9]{20,}"),                 # Render
    re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_\-]{20,}"),      # OpenAI / Anthropic
    re.compile(r"\bghp_[A-Za-z0-9]{30,}"),                 # GitHub PAT
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{30,}"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}"),        # Slack
    # Generic NAME=value / NAME: value for anything key-shaped. Catches the
    # providers whose keys are just opaque alphanumerics (Pexels, Giphy,
    # Pixabay) and have no prefix to match on.
    re.compile(
        r"(?im)^(\s*[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[=:]\s*)(\S{8,})$"
    ),
]


def redact(text: str) -> str:
    """Strips anything key-shaped, preserving the variable name for context."""
    if not text:
        return text
    out = text
    for pattern in SECRET_PATTERNS:
        if pattern.groups == 2:
            out = pattern.sub(lambda m: f"{m.group(1)}<REDACTED>", out)
        else:
            out = pattern.sub("<REDACTED>", out)
    return out


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
        f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def repo_root() -> Path:
    for candidate in (os.environ.get("CLAUDE_PROJECT_DIR"), os.getcwd()):
        if not candidate:
            continue
        p = Path(candidate)
        if (p / ".claude").is_dir():
            return p
    return Path(__file__).resolve().parents[2]


def log_error(root: Path, msg: str) -> None:
    try:
        d = root / ".agent-logs"
        d.mkdir(parents=True, exist_ok=True)
        with (d / ".capture-errors.log").open("a") as f:
            f.write(f"{utc_now()} {msg}\n")
    except Exception:
        pass


def author(root: Path) -> str:
    if os.environ.get("AGENT_LOG_AUTHOR"):
        return os.environ["AGENT_LOG_AUTHOR"]
    try:
        cfg = (root / ".git" / "config").read_text()
        m = re.search(r"github\.com[:/]([^/\s]+)/", cfg)
        if m:
            return m.group(1)
    except Exception:
        pass
    return FALLBACK_AUTHOR


def read_transcript(path: str) -> list:
    entries = []
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        entries.append(json.loads(line))
                    except json.JSONDecodeError:
                        continue
    except Exception:
        pass
    return entries


def text_of(message: dict) -> str:
    """Pull only plain text out of a message. Skips thinking and tool calls."""
    content = message.get("content")
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(block.get("text", ""))
    return "\n".join(parts).strip()


def final_response(entries: list) -> tuple:
    """Last assistant message carrying real text, with the model that wrote it."""
    for entry in reversed(entries):
        if entry.get("type") != "assistant":
            continue
        message = entry.get("message") or {}
        body = text_of(message)
        if body:
            return body, message.get("model") or FALLBACK_MODEL
    return "", FALLBACK_MODEL


def latest_model(entries: list) -> str:
    for entry in reversed(entries):
        if entry.get("type") == "assistant":
            model = (entry.get("message") or {}).get("model")
            if model:
                return model
    return FALLBACK_MODEL


def log_path(root: Path, session_id: str) -> Path:
    d = root / ".agent-logs"
    d.mkdir(parents=True, exist_ok=True)
    existing = sorted(d.glob(f"*_{session_id}.md"))
    if existing:
        return existing[0]
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d_%H-%M-%S")
    return d / f"{stamp}_{session_id}.md"


def init_file(path: Path, session_id: str, model: str, project: str, who: str, now: str) -> None:
    if path.exists():
        return
    short = session_id[:8]
    path.write_text(
        "---\n"
        f"session_id: {session_id}\n"
        f"date: {now[:10]}\n"
        f"author: {who}\n"
        f"model: {model}\n"
        "tool: claude-code\n"
        f"project: {project}\n"
        "total_exchanges: 0\n"
        f"first_prompt_time: {now}\n"
        f"last_prompt_time: {now}\n"
        "---\n\n"
        f"# Session Log - {now[:10]}\n\n"
        f"Session: `{short}` | Project: `{project}` | Author: `{who}`\n\n"
        "---\n"
    )


def bump_frontmatter(path: Path, count: int, now: str) -> None:
    text = path.read_text()
    text = re.sub(r"^total_exchanges: .*$", f"total_exchanges: {count}",
                  text, count=1, flags=re.M)
    text = re.sub(r"^last_prompt_time: .*$", f"last_prompt_time: {now}",
                  text, count=1, flags=re.M)
    path.write_text(text)


def prompt_count(path: Path) -> int:
    if not path.exists():
        return 0
    return len(re.findall(r"^\[LOG_ENTRY type=PROMPT ", path.read_text(), flags=re.M))


def append_entry(path: Path, kind: str, num: int, session_id: str,
                 model: str, now: str, body: str) -> None:
    short = session_id[:8]
    with path.open("a") as f:
        f.write(
            f"\n[LOG_ENTRY type={kind} num={num} session={short}]\n"
            f"timestamp: {now}\n"
            f"model: {model}\n\n"
            f"{body}\n\n"
        )


def main() -> None:
    root = repo_root()
    try:
        payload = json.load(sys.stdin)
    except Exception as e:
        log_error(root, f"unreadable stdin: {e}")
        return

    event = payload.get("hook_event_name") or ""
    session_id = payload.get("session_id") or "unknown-session"
    transcript = payload.get("transcript_path") or ""
    now = utc_now()
    project = root.name
    who = author(root)

    entries = read_transcript(transcript) if transcript else []
    path = log_path(root, session_id)

    if event == "UserPromptSubmit":
        body = payload.get("prompt")
        if not body:
            log_error(root, "UserPromptSubmit with no prompt field")
            return
        model = latest_model(entries)
        init_file(path, session_id, model, project, who, now)
        num = prompt_count(path) + 1
        append_entry(path, "PROMPT", num, session_id, model, now, redact(body.strip()))
        bump_frontmatter(path, num, now)

    elif event == "Stop":
        body, model = final_response(entries)
        if not body:
            log_error(root, "Stop with no assistant text found")
            return
        init_file(path, session_id, model, project, who, now)
        num = max(prompt_count(path), 1)
        append_entry(path, "RESPONSE", num, session_id, model, now, redact(body))
        bump_frontmatter(path, num, now)

    else:
        log_error(root, f"ignored event: {event!r}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        try:
            log_error(repo_root(), f"unhandled: {type(e).__name__}: {e}")
        except Exception:
            pass
    sys.exit(0)
