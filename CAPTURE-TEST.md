# Capture Test

## Tool and model

- **Tool:** Claude Code (CLI)
- **Model:** Opus 5 (1M context) — exact ID `claude-opus-5[1m]`
- **Planning vs execution:** a single model does both. There is no separate
  planner/executor split in this setup, so every entry in `.agent-logs/` comes
  from the same model. The `model:` field is written per entry anyway, so a
  switch mid-build would be visible.

## Mechanism

Claude Code exposes lifecycle hooks in `.claude/settings.json`. Two events are
wired, and both fire on their own with no action from me:

| Event | Fires | Payload used |
|---|---|---|
| `UserPromptSubmit` | when I submit a prompt | `prompt` (verbatim), `session_id` |
| `Stop` | at end of turn | `transcript_path` — JSONL of the session |

**Config file changed:** `.claude/settings.json`
**Hook script:** `.claude/hooks/capture.py`

Both events run the same script; it branches on `hook_event_name`.

### Design notes

- **Only prompt and final response are kept.** The `Stop` payload points at the
  full session transcript, which contains thinking blocks, tool calls, file
  reads and retries. The script walks the transcript backwards and takes the
  text of the last assistant message only. `thinking` and `tool_use` blocks are
  filtered out by type.
- **Stateless numbering.** The entry number is derived by counting existing
  `[LOG_ENTRY type=PROMPT` lines in the log file rather than kept in a sidecar
  state file. Nothing to corrupt, nothing extra to commit, and it survives a
  resumed session.
- **Never breaks the session.** Every failure path is caught, written to
  `.agent-logs/.capture-errors.log`, and exits 0. A capture hook that kills the
  session it is capturing is worse than one that misses an entry.
- **One file per session**, named `YYYY-MM-DD_HH-MM-SS_<session-id>.md`, matching
  the requested format. Frontmatter `total_exchanges` and `last_prompt_time` are
  updated as the session goes.

## Log file the canaries landed in

<!-- TODO: fill in after running the two canaries -->

- Session 1: `.agent-logs/`
- Session 2: `.agent-logs/`

## Canary entries, raw

### Session 1

```
TODO: paste raw block from .agent-logs/ here
```

### Session 2

```
TODO: paste raw block from .agent-logs/ here
```

## What did not work first

**Project hooks do not load in a session started outside the repo.**
`.claude/settings.json` is read from the directory Claude Code was launched in.
The first session was running from a different folder, so the hooks were written
but never fired. Fixed by quitting and relaunching `claude` from the repo root.
This is also why the brief's two-session check matters — a hook that only works
in the session that created it is not actually installed.

**Verification before going live.** Rather than discovering a broken hook
mid-build, the script was pipe-tested first by feeding it synthetic
`UserPromptSubmit` and `Stop` payloads on stdin, with a hand-built transcript
JSONL containing a `thinking` block, a `tool_use` block, a `tool_result`, and a
final text message. Confirmed that only the final text was captured and the
output matched the required format. The synthetic log file was deleted
afterwards so no fabricated session ID would sit in `.agent-logs/`.
