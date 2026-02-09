# Changelog

## 0.1.0 — 2025-02-08

Initial release.

- Telegram bot bridging to Claude Code via the Claude Agent SDK
- Full agent tools: Read, Edit, Write, Bash, Glob, Grep, WebSearch, WebFetch, Task
- Streaming responses with throttled edits and auto-splitting at 4096 char limit
- Session auto-resume from latest `.jsonl` — seamless laptop-to-phone handoff
- Project switching via `/switch` with inline keyboard picker
- Image support (photos forwarded as vision input)
- Single-user auth via Telegram user ID whitelist
- Works with Claude Pro/Max subscription or API key
