# VibeIDE — Block Diagrams

Three levels of detail: high-level overview, component structure, and message processing flow.

## Level 1 — High-Level Architecture

```mermaid
graph LR
    subgraph Phone["Any device"]
        TG["Telegram Client<br/>(phone / tablet / desktop / web)"]
    end

    subgraph Local["Local machine (Windows / macOS / Linux)"]
        BOT["VibeIDE<br/>Node.js process"]
        FS[("Project<br/>filesystem")]
    end

    subgraph Cloud["Anthropic"]
        SDK["Claude Agent SDK<br/>(@anthropic-ai/claude-agent-sdk)"]
    end

    TG -- "Long polling<br/>(outbound HTTPS)" --> BOT
    BOT -- "Streaming responses" --> TG
    BOT -- "query() / resume" --> SDK
    SDK -- "async generator<br/>messages" --> BOT
    SDK -- "Read / Edit / Write / Bash<br/>Glob / Grep / WebSearch" --> FS
```

**Key properties:**
- Single local process, zero infrastructure
- No inbound ports — Grammy uses long polling (outbound HTTPS only)
- Claude operates on the real filesystem with full tool access
- Session resume: start a conversation in VS Code, continue on phone

---

## Level 2 — Component Structure

```mermaid
graph TB
    subgraph Entry["Startup"]
        IDX["index.ts<br/>CLI args, signals"]
        CFG["config.ts<br/>.env validation"]
    end

    subgraph Bot["bot.ts — Grammy Bot"]
        AUTH["Auth middleware<br/>user ID check"]
        LOCK["Password gate<br/>SHA-256, per-topic lock"]
        LOG["Diagnostic logger<br/>topic IDs"]
        CMD["Commands<br/>/model /speed /settings<br/>/sessions /switch /stop<br/>/fresh /new /get /history<br/>/rename /resume /mode<br/>/help /status /projects<br/>/restart /shutdown"]
        CB["Callback handlers<br/>model: speed: set:<br/>switch: resume: perm: sessions:"]
        MSG["Message handlers<br/>text → bridge<br/>photo → base64 → bridge<br/>document → inbox → bridge"]
    end

    subgraph BridgeMod["bridge.ts — Claude Bridge"]
        QUEUE["Message queue<br/>(up to 5 per topic)"]
        SAFE["Safe mode<br/>tool confirmation buttons"]
        RUN["runQuery()<br/>AbortController + close()"]
        RETRY["Auto-retry<br/>context overflow → no resume"]
        TOOL["Tool activity indicator<br/>⚙️ message, deleted on finish"]
    end

    subgraph StreamMod["streamer.ts — Response Streamer"]
        ACC["Text accumulator<br/>fullText across chunks"]
        THROT["Throttled edits<br/>~300ms interval"]
        MD["mdToTgHtml()<br/>Markdown → Telegram HTML"]
        SPLIT["splitChunks()<br/>~3800 char limit"]
        TABLE["renderTableCards()<br/>wide → vertical cards<br/>narrow → pre block"]
    end

    subgraph State["State & Discovery"]
        TOPICS["topics.ts<br/>ThreadStore (topics.json)<br/>per-topic: project, session,<br/>model, speed, safeMode"]
        PROJ["projects.ts<br/>~/.claude/projects/<br/>session list, titles, history"]
        MODELS["models.json<br/>model presets + aliases<br/>hot-reload via /model reload"]
    end

    IDX --> CFG
    CFG --> Bot
    IDX --> Bot

    AUTH --> LOCK --> LOG --> CMD
    AUTH --> LOCK --> LOG --> MSG
    AUTH --> LOCK --> LOG --> CB

    MSG --> QUEUE
    CMD -- "/stop" --> RUN
    QUEUE --> RUN
    RUN --> SAFE
    RUN --> RETRY
    RUN --> TOOL

    RUN -- "text blocks" --> ACC
    ACC --> THROT
    ACC -- "finalize()" --> MD
    MD --> TABLE
    MD --> SPLIT

    RUN --> TOPICS
    CMD --> TOPICS
    CMD --> PROJ
    CMD --> MODELS
    CB --> TOPICS
    CB --> MODELS
```

---

## Level 3 — Message Processing Flow

```mermaid
sequenceDiagram
    participant U as User (Telegram)
    participant B as bot.ts
    participant BR as bridge.ts
    participant S as streamer.ts
    participant SDK as Claude Agent SDK
    participant FS as Filesystem

    U->>B: Text message
    B->>B: Auth: check user ID
    B->>B: Password gate: check lock state
    B->>B: Log: topic IDs

    B->>BR: sendMessage(chatId, text, route)

    alt Topic is busy
        BR->>BR: Add to queue (max 5)
        BR->>U: "⏳ В очереди: N"
    else Topic is free
        BR->>BR: Mark topic busy
    end

    BR->>BR: process() → threadState()
    Note over BR: adoptMain() for legacy migration
    Note over BR: Check freshNext flag

    BR->>S: new Streamer(api, chatId, route)
    BR->>U: Set topic name "⚙️ ..."
    BR->>U: sendChatAction("typing")

    BR->>SDK: query({ prompt, options: {<br/>  cwd, resume, model,<br/>  maxThinkingTokens,<br/>  abortController, ... }})

    loop for await (message of conversation)
        SDK->>BR: assistant message

        alt text block
            BR->>S: append(text)
            S->>S: fullText += text

            alt First chunk
                S->>U: sendMessage (plain text)
            else Subsequent
                S->>S: Throttle 300ms
                S->>U: editMessageText
            end

            alt text > 3800 chars
                S->>S: Overflow → new message
                S->>U: sendMessage (new chunk)
            end
        end

        alt tool_use block
            BR->>U: ⚙️ tool activity note

            opt Safe mode + dangerous tool
                BR->>U: ⚠️ Confirm? [✅ Да] [❌ Нет] [✅ Всё]
                U->>BR: Button callback → allow/deny
            end
        end

        SDK->>FS: Tool execution (Read/Edit/Bash/...)
        FS->>SDK: Tool result

        alt session_id in message
            BR->>BR: store.setSession(key, id)
        end
    end

    SDK->>BR: result message

    alt duration > 10s
        BR->>S: append("⏱ Ns")
    end

    BR->>U: Delete ⚙️ tool note
    BR->>S: finalize()

    alt Has Markdown formatting
        S->>S: mdToTgHtml(fullText)
        S->>S: Tables → cards / pre
        S->>U: Delete old plain messages
        S->>U: Send HTML chunks
        alt HTML fails
            S->>U: Send plain fallback
        end
    else Plain text
        S->>S: flushEdit() (final)
    end

    BR->>U: Restore topic name (remove ⚙️)
    BR->>BR: Drain queued messages
```

### /stop Abort Flow

```mermaid
sequenceDiagram
    participant U as User (Telegram)
    participant B as bot.ts
    participant BR as bridge.ts
    participant SDK as Claude Agent SDK

    Note over BR: runQuery() is active,<br/>for-await loop running

    U->>B: /stop
    B->>BR: stop(key)
    BR->>BR: running.aborted = true
    BR->>BR: abortController.abort()
    BR->>BR: conversation.close()
    BR->>U: "⏹ Останавливаю"

    alt Error thrown in for-await
        BR->>BR: catch: wasAborted? → append "⏹ Прервано"
    else Loop ends normally
        BR->>BR: finally: wasAborted? → append "⏹ Прервано"
    end

    BR->>BR: finalize streamer
    BR->>BR: Restore topic name
```

### Context Overflow Auto-Retry

```mermaid
sequenceDiagram
    participant BR as bridge.ts
    participant SDK as Claude Agent SDK
    participant U as User (Telegram)

    BR->>SDK: query({ resume: sessionId, ... })
    SDK-->>BR: Error: "prompt too long"

    BR->>BR: Detect context overflow
    BR->>U: "⚠️ Сессия слишком длинная —<br/>повторяю без истории"
    BR->>BR: Finalize current streamer
    BR->>BR: Restore topic name

    BR->>SDK: query({ prompt, ... })<br/>(no resume)
    SDK->>BR: Fresh conversation
    Note over BR: Normal flow continues
```

---

## Level 2b — Per-Topic State Model

```mermaid
stateDiagram-v2
    [*] --> Idle: New topic (first message)

    Idle --> Processing: User sends text/photo
    Processing --> Idle: Response complete
    Processing --> Processing: Queued messages drain

    Processing --> Aborted: /stop
    Aborted --> Idle: Cleanup done

    Processing --> Retry: Context overflow
    Retry --> Processing: query() without resume

    state "Topic State (topics.json)" as TS {
        projectPath: string
        sessionId: string?
        model: string?
        maxThinkingTokens: number?
        safeMode: boolean?
        title: string?
        freshNext: boolean? (RAM only)
    }

    state "Lock State (RAM)" as LS {
        unlockedUntil: timestamp
        failedAttempts: counter
        attemptsBlockedUntil: timestamp
    }
```

---

## Data Files

| File | Location | Purpose | Persistence |
|------|----------|---------|-------------|
| `topics.json` | repo root | Per-topic state: project, session, model, speed, mode | Disk (JSON) |
| `models.json` | repo root | Model presets + aliases, hot-reloadable | Disk (JSON) |
| `.env` | repo root | Bot token, user ID, password hash | Disk (gitignored) |
| `~/.claude/projects/` | Home dir | Session .jsonl files, titles | Claude Code managed |
| `inbox/` | CWD | Files sent by user via Telegram | Disk |
| `restart.json` | CWD | Restart confirmation flag | Temp (deleted on read) |
