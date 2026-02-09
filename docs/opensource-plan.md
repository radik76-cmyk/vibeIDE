# Open Source Plan

## Context
VibeIDE is a working Telegram-to-Claude-Code bridge (~300 lines across 6 files). The code works but has zero public-facing polish. Goal: make it irresistible to star on GitHub. Following patterns from high-star projects (OpenClaw, etc.).

## Files Created

### 1. `README.md` — the star-getter
Structure (proven high-star formula):
- **Hero**: Large ASCII/text logo + one-liner tagline + badge row (license, node version)
- **The pitch**: 2-3 sentences — "Claude Code from your phone." Problem → solution → how.
- **Demo mockup**: ASCII art showing a Telegram conversation with Claude responding (placeholder for future GIF)
- **Quick Start**: Exactly 4 numbered steps: clone → install → configure → run
- **Features**: Scannable bullet list (streaming, session resume, project switching, images, etc.)
- **Architecture**: ASCII box diagram
- **Commands**: Clean table of `/projects`, `/switch`, `/new`, `/status`
- **Setup details**: BotFather walkthrough, getting user ID, env vars
- **Security model**: Why bypassPermissions is safe (single-user, local, outbound-only)
- **How it works**: Brief message flow explanation
- **Contributing + License**

Tone: Confident, concise, developer-to-developer. Light personality without being cloying.

### 2. `LICENSE` — MIT

### 3. `CONTRIBUTING.md` — Short and welcoming
Just the essentials: fork, branch, PR. No bureaucracy.

### 4. `package.json` — polished metadata
Added: `description`, `license`, `keywords`, `engines`, `repository` (placeholder URL).

## Follow-up TODOs
- [ ] Record a terminal/phone GIF demo and add to README
- [ ] Create GitHub repo and update repository URL in package.json
- [ ] Add CI badge once GitHub Actions is set up
- [ ] Post to Reddit (r/programming, r/ChatGPT, r/ClaudeAI), Hacker News, Twitter/X
- [ ] Submit to awesome-claude / awesome-telegram lists
- [ ] Add star history chart once stars start accumulating
