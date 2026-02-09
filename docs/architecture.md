# VibeIDE — Architecture & Implementation Plan

## Context

Build a tool that lets a user interact with Claude Code from their phone via Telegram. When away from the laptop, the user can continue working on their project — asking questions, reading code, making edits — through a Telegram bot backed by the full Claude Code agent. When they return to the laptop, work continues seamlessly since everything is on the same filesystem.

## Architecture Overview

```
┌─────────────┐       ┌──────────────────────┐       ┌────────────────┐
│  Telegram    │◄─────►│  VibeIDE Bridge      │◄─────►│  Claude Agent   │
│  (phone)     │       │  (Node.js on Mac)    │       │  SDK (V1)       │
└─────────────┘       └──────────────────────┘       └────────────────┘
                       Grammy bot polling              @anthropic-ai/claude-agent-sdk
                       Runs locally                    Full tools: Read/Edit/Bash/etc.
                       User ID whitelist               CWD = project directory
```

Single Node.js process. No server, no database, no external infra. Just a script running on the Mac that bridges Telegram messages to the Claude Agent SDK.

## Components

### 1. Entry Point — `app/src/index.ts`
- Parse CLI args (optional project path)
- Load config from `.env`
- Initialize Grammy bot + Claude bridge
- Start polling
- Graceful shutdown on SIGINT/SIGTERM

### 2. Config — `app/src/config.ts`
- Load from `.env` file:
  - `TELEGRAM_BOT_TOKEN` — from @BotFather
  - `TELEGRAM_ALLOWED_USER_ID` — your Telegram numeric user ID
- `ANTHROPIC_API_KEY` — inherited from shell environment (Claude Agent SDK picks it up automatically)
- Validate all required values present at startup

### 3. Telegram Bot — `app/src/bot.ts`
- Grammy bot with long polling (no webhook needed for single-user local use)
- **Auth middleware**: Check `ctx.from.id === allowedUserId` on every message, silently drop unauthorized
- **Message handler**: Forward text messages to the Claude bridge
- **Commands**:
  - `/projects` — list available projects from `~/.claude/projects/`, sorted by last activity
  - `/switch` — change active project (shows project list as inline keyboard buttons)
  - `/new` — start a fresh session (clear current session ID, keep same project)
  - `/status` — show current project, session ID, connection status
- **Media**: Forward images as vision input to Claude (the SDK supports images)

### 4. Claude Bridge — `app/src/bridge.ts`
- Wraps `query()` from `@anthropic-ai/claude-agent-sdk`
- Maintains state per active project:
  - `sessionId: string | undefined` — for resume
  - `projectPath: string` — CWD for Claude
  - `isProcessing: boolean` — prevent concurrent queries
- Core method: `sendMessage(text: string, images?: Buffer[])`:
  ```
  query({
    prompt: text,
    options: {
      cwd: projectPath,
      resume: sessionId,
      allowedTools: ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["project"],
    }
  })
  ```
- Iterates the async generator, emits streaming events to the streamer
- On `result` message, saves `session_id` for next query
- Queue incoming messages if a query is already in progress (or reject with "still thinking...")

### 5. Response Streamer — `app/src/streamer.ts`
- Receives streaming events from the bridge
- Manages Telegram draft message lifecycle:
  1. On first token: send initial message via `bot.api.sendMessage()`
  2. On subsequent tokens: accumulate text, call `bot.api.editMessageText()` throttled (every ~300ms)
  3. When accumulated text approaches 4096 chars: finalize current message, start new one
  4. On completion: final edit with complete text
- Handles markdown → Telegram-safe formatting (code blocks, bold, etc.)
- Parse mode: `Markdown` (Grammy handles escaping)
- Error fallback: if Markdown parsing fails, retry as plain text

### 6. Project Discovery — `app/src/projects.ts`
- Reads `~/.claude/projects/` directory
- For each project folder:
  - Decode path: `-Users-you-Code-vibeide` → `/Users/you/Code/vibeide`
  - Find most recent `.jsonl` file by mtime → last activity timestamp
  - Extract friendly name from path (last segment, e.g., `vibeide`)
- Return sorted list (most recent first)
- Format for Telegram inline keyboard display

## Project Organization

```
vibeide/
├── docs/                   # Plans, architecture, decisions
│   ├── architecture.md     # This document
│   └── opensource-plan.md  # Open source launch plan
├── app/                    # Executable source code
│   └── src/
│       ├── index.ts        # Entry point, CLI args, startup
│       ├── config.ts       # Env loading + validation
│       ├── bot.ts          # Grammy bot, handlers, commands
│       ├── bridge.ts       # Claude Agent SDK wrapper
│       ├── streamer.ts     # Streaming responses to Telegram
│       └── projects.ts     # Project discovery from ~/.claude/
├── package.json            # At root — single package
├── tsconfig.json
├── .env.example            # Template with BOT_TOKEN, ALLOWED_USER_ID
├── .env                    # User's actual secrets (gitignored)
└── .gitignore
```

**Why this structure:**
- `docs/` at root — plans and discussion artifacts live outside the codebase, easy to reference but never shipped
- `app/src/` — clear boundary for executable code, keeps root clean
- Single `package.json` at root — no monorepo complexity for an MVP

## Dependencies

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "latest",
    "grammy": "^1.39.3",
    "dotenv": "^16.4.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0"
  }
}
```

Run with: `npx tsx app/src/index.ts /path/to/project`

## Message Flow — Happy Path

```
1. User sends "what does auth.ts do?" on Telegram
2. Grammy bot receives message
3. Auth check: ctx.from.id === allowedUserId ✓
4. bridge.sendMessage("what does auth.ts do?")
5. query() called with resume=sessionId, cwd=/Users/you/Code/vibeide
6. Claude Agent SDK streams response:
   a. assistant message with text content blocks → streamer.append(text)
   b. streamer sends initial Telegram message
   c. more assistant messages → streamer edits message (throttled 300ms)
   d. result message → save session_id
7. streamer finalizes message
8. User sees complete response on phone
```

## Message Flow — Long Response

```
1. Claude streams a long code explanation (5000+ chars)
2. Streamer accumulates text, editing draft message every 300ms
3. At ~3800 chars, streamer finalizes current message (leaves room for formatting)
4. Streamer sends a new message, continues accumulating
5. On completion, finalizes last message
6. User sees 2+ messages on Telegram, streamed live
```

## Message Flow — Project Switch

```
1. User sends /switch
2. Bot reads ~/.claude/projects/, shows inline keyboard:
   [vibeide (2m ago)]
   [simple-ex (yesterday)]
   [sleepdecode (Feb 7)]
3. User taps "simple-ex"
4. Bridge updates: projectPath = /Users/you/Code/simple-ex, sessionId = undefined
5. Bot confirms: "Switched to simple-ex. Fresh session started."
6. Next message goes to Claude with cwd=/Users/you/Code/simple-ex
```

## Security

- **User ID whitelist**: Single authorized Telegram user ID, checked on every incoming update
- **Bot token**: Stored in `.env`, gitignored
- **API key**: Inherited from shell environment (`ANTHROPIC_API_KEY`)
- **Permission mode**: `bypassPermissions` — since this is your own Mac, your own projects, and only you can message the bot
- **No network exposure**: Bot uses long polling (outbound only), no inbound ports opened

## Startup Sequence

```
1. Load .env
2. Validate TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USER_ID present
3. Validate ANTHROPIC_API_KEY in environment
4. Create Grammy bot
5. Register handlers + commands
6. If CLI arg provided, set initial project path; otherwise use process.cwd()
7. Start polling
8. Log: "VibeIDE running. Send a message on Telegram to start."
```

## Verification Plan

1. **Setup**: Create Telegram bot via @BotFather, get token and user ID
2. **Start**: Run `npx tsx app/src/index.ts /Users/you/Code/vibeide`
3. **Test auth**: Message from unauthorized user → no response
4. **Test basic message**: Send "what files are in this project?" → get response listing files
5. **Test continuity**: Send follow-up "tell me more about the first one" → Claude remembers context
6. **Test streaming**: Send a question that produces a long answer → see message updating live
7. **Test long response**: Ask for something that exceeds 4096 chars → see it split into multiple messages
8. **Test /projects**: Run command → see project list
9. **Test /switch**: Switch to another project → verify CWD changes
10. **Test /new**: Start fresh session → verify Claude doesn't remember prior conversation
