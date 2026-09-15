import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Message } from "grammy/types";
import type { Config } from "./config.js";
import { Bridge } from "./bridge.js";
import {
  extractRoute,
  routeKey,
  sendRouted,
  type ThreadRoute,
} from "./topics.js";
import {
  listProjects,
  listSessions,
  getSessionTitle,
  setSessionTitle,
  readSessionMessages,
  formatRelativeTime,
  type ProjectInfo,
} from "./projects.js";

// Telegram inline-button labels are short; keep names readable.
function shorten(s: string, max = 40): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// The topic ("tab") a command or callback came from. Every reply and every
// bridged Claude answer goes back into the same topic; each topic holds its
// own project + session state.
function routeOf(ctx: Context): ThreadRoute {
  return extractRoute(
    ctx.message ?? (ctx.callbackQuery?.message as Message | undefined)
  );
}

export async function createBot(config: Config, initialProjectPath?: string): Promise<Bot> {
  const bot = new Bot(config.telegramBotToken);
  const bridge = new Bridge(bot.api, initialProjectPath);

  // Reply into the topic the update came from.
  async function replyRouted(
    ctx: Context,
    text: string,
    extra?: Parameters<Context["reply"]>[1]
  ): Promise<void> {
    await sendRouted(bot.api, ctx.chat!.id, text, routeOf(ctx), extra);
  }

  // In topics mode messages never arrive in the plain chat view, so binding
  // the latest-by-mtime session to "main" would only feed stale bindings to
  // the adoption logic (worst case: a session an open terminal is writing).
  const me = await bot.api.getMe();
  const topicsMode = Boolean(
    (me as { has_topics_enabled?: boolean }).has_topics_enabled
  );
  if (topicsMode) {
    console.log("Topics mode: sessions live per topic, no plain-view auto-resume.");
  } else {
    // Auto-resume the latest session for this project in the plain chat view
    const resumedId = await bridge.resumeLatest("main");
    if (resumedId) {
      console.log(`Resuming session: ${resumedId.slice(0, 8)}...`);
    }
  }

  // Auth middleware — silently drop unauthorized users
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.allowedUserId) return;
    await next();
  });

  // Diagnostic: log topic ids of every incoming update (goes to bot.out).
  bot.use(async (ctx, next) => {
    const m = ctx.message ?? (ctx.callbackQuery?.message as Message | undefined);
    if (m) {
      const kind = ctx.callbackQuery ? "cb " : "msg";
      console.log(
        `[${kind}] thread=${m.message_thread_id ?? "-"} ` +
          `dmTopic=${m.direct_messages_topic?.topic_id ?? "-"} ` +
          `key=${routeKey(extractRoute(m))} ` +
          `text=${(("text" in m ? m.text : undefined) ?? ctx.callbackQuery?.data ?? "").slice(0, 40)}`
      );
    }
    await next();
  });

  // /start command
  bot.command("start", async (ctx) => {
    const state = bridge.threadState(routeKey(routeOf(ctx)));
    await replyRouted(
      ctx,
      `VibeIDE connected.\nProject: \`${state.projectPath}\`\n\nEach chat topic runs its own session: a new topic starts a fresh one.\n\n/help — справка по командам и вкладкам`,
      { parse_mode: "Markdown" }
    );
  });

  // /help — справка (RU): команды, поведение вкладок, легенда пометок
  bot.command("help", async (ctx) => {
    await replyRouted(
      ctx,
      [
        "*Справка VibeIDE*",
        "",
        "Каждая вкладка (тема) чата — отдельная сессия Claude Code:",
        "• пишешь *внутри вкладки* — продолжаешь её сессию;",
        "• пишешь *из корня чата* — Telegram создаёт новую вкладку, бот заведёт в ней свежую сессию;",
        "• вкладка сама переименовывается по имени сессии.",
        "",
        "*Команды* (действуют на вкладку, где написаны):",
        "/status — проект, вкладка и сессия",
        "/sessions — выбрать сессию для этой вкладки",
        "/resume <id> — привязать сессию по id (хватит первых 8 символов)",
        "/history [n] — последние n реплик сессии (по умолчанию 10)",
        "/rename <имя> — переименовать сессию (и вкладку); имя видно и в терминале",
        "/new — отвязать сессию: следующее сообщение начнёт свежую",
        "/projects — список проектов",
        "/switch — сменить проект этой вкладки",
        "/help — эта справка",
        "",
        "*Пометки в /sessions:*",
        "● — сессия этой вкладки",
        "📌 — уже открыта в другой вкладке; при выборе бот предложит «Take over here» — забрать сюда",
        "🟢 — пишется прямо сейчас (например, открыта в терминале — лучше не трогать)",
        "",
        "Фото можно отправлять с подписью — бот увидит картинку.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  });

  // /status command — project and session of the current topic
  bot.command("status", async (ctx) => {
    const state = bridge.threadState(routeKey(routeOf(ctx)));
    await bridge.syncTopicTitle(ctx.chat.id, routeOf(ctx));
    let sessionInfo = "none (will start on next message)";
    if (state.sessionId) {
      const title = await getSessionTitle(state.projectPath, state.sessionId);
      const shortId = state.sessionId.slice(0, 8);
      sessionInfo = title ? `**${title}** (\`${shortId}\`)` : `\`${shortId}...\``;
    }
    await replyRouted(
      ctx,
      `Project: \`${state.projectPath}\`\nTopic: \`${routeKey(routeOf(ctx))}\`\nSession: ${sessionInfo}`,
      { parse_mode: "Markdown" }
    );
  });

  // /new command — fresh session, same project, current topic
  bot.command("new", async (ctx) => {
    bridge.store.setSession(routeKey(routeOf(ctx)), undefined);
    await replyRouted(
      ctx,
      "Session cleared. Next message here starts a fresh conversation."
    );
  });

  // /projects command — list available projects
  bot.command("projects", async (ctx) => {
    const projects = await listProjects();
    if (projects.length === 0) {
      await replyRouted(ctx, "No projects found in ~/.claude/projects/");
      return;
    }

    const lines = projects.slice(0, 20).map(
      (p, i) => `${i + 1}. **${p.name}** (${formatRelativeTime(p.lastActivity)})\n   \`${p.path}\``
    );
    await replyRouted(ctx, lines.join("\n"), { parse_mode: "Markdown" });
  });

  // /switch command — show project picker for the current topic
  bot.command("switch", async (ctx) => {
    const projects = await listProjects();
    if (projects.length === 0) {
      await replyRouted(ctx, "No projects found in ~/.claude/projects/");
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const project of projects.slice(0, 10)) {
      keyboard
        .text(
          `${project.name} (${formatRelativeTime(project.lastActivity)})`,
          `switch:${project.path}`
        )
        .row();
    }

    await replyRouted(ctx, "Pick a project:", { reply_markup: keyboard });
  });

  // Handle inline keyboard callbacks for project switching
  bot.callbackQuery(/^switch:/, async (ctx) => {
    const projectPath = ctx.callbackQuery.data.slice("switch:".length);
    const key = routeKey(routeOf(ctx));
    bridge.store.setProject(key, projectPath);
    const resumedId = await bridge.resumeLatest(key);
    const name = projectPath.split("/").filter(Boolean).pop() || projectPath;
    await ctx.answerCallbackQuery();
    const sessionNote = resumedId
      ? `Resumed session \`${resumedId.slice(0, 8)}...\``
      : "Starting fresh session.";
    await ctx.editMessageText(`Switched to **${name}**\n\`${projectPath}\`\n\n${sessionNote}`, {
      parse_mode: "Markdown",
    });
  });

  // /sessions command — list recent sessions of the current topic's project
  bot.command("sessions", async (ctx) => {
    const key = routeKey(routeOf(ctx));
    const state = bridge.threadState(key);
    const sessions = await listSessions(state.projectPath);
    if (sessions.length === 0) {
      await replyRouted(
        ctx,
        `No sessions found for \`${state.projectPath}\``,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const s of sessions.slice(0, 10)) {
      // ● bound to this topic, 📌 already open in another topic
      const mark =
        s.id === state.sessionId
          ? "● "
          : bridge.store.findBySession(s.id, key)
            ? "📌 "
            : "";
      // Fresh mtime = someone (likely a terminal) is writing this session now.
      const active =
        Date.now() - s.lastActivity.getTime() < 10 * 60_000 ? "🟢 " : "";
      const label = s.title ? shorten(s.title) : s.id.slice(0, 8);
      keyboard
        .text(
          `${mark}${active}${label} (${formatRelativeTime(s.lastActivity)})`,
          `resume:${s.id}`
        )
        .row();
    }

    await replyRouted(ctx, "Pick a session to resume:", {
      reply_markup: keyboard,
    });
  });

  // Display name of the topic already holding a session, for conflict notes.
  async function topicLabelOf(
    other: { state: { projectPath: string; title?: string } },
    sessionId: string
  ): Promise<string> {
    return (
      other.state.title ||
      (await getSessionTitle(other.state.projectPath, sessionId)) ||
      sessionId.slice(0, 8)
    );
  }

  // Handle inline keyboard callbacks for session resume
  bot.callbackQuery(/^resume:/, async (ctx) => {
    const id = ctx.callbackQuery.data.slice("resume:".length);
    const key = routeKey(routeOf(ctx));

    const other = bridge.store.findBySession(id, key);
    if (other) {
      const name = await topicLabelOf(other, id);
      await ctx.answerCallbackQuery();
      await ctx.editMessageText(
        `Session is already open in topic «${name}» — continue there, or take it over:`,
        {
          reply_markup: new InlineKeyboard().text(
            "Take over here",
            `resume!:${id}`
          ),
        }
      );
      return;
    }

    bridge.store.bindSession(key, id);
    const state = bridge.store.get(key);
    const title = await getSessionTitle(state.projectPath, id);
    const label = title ? `**${title}**` : `\`${id.slice(0, 8)}...\``;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Resumed ${label}\nNext message here continues it.`,
      { parse_mode: "Markdown" }
    );
    if (ctx.chat) await bridge.syncTopicTitle(ctx.chat.id, routeOf(ctx));
  });

  // Take over a session that is open in another topic: the other topic
  // loses its binding (its next message starts a fresh session there).
  bot.callbackQuery(/^resume!:/, async (ctx) => {
    const id = ctx.callbackQuery.data.slice("resume!:".length);
    const key = routeKey(routeOf(ctx));

    const other = bridge.store.findBySession(id, key);
    if (other) bridge.store.setSession(other.key, undefined);
    bridge.store.bindSession(key, id);

    const state = bridge.store.get(key);
    const title = await getSessionTitle(state.projectPath, id);
    const label = title ? `**${title}**` : `\`${id.slice(0, 8)}...\``;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Resumed ${label} (taken over)\nNext message here continues it.`,
      { parse_mode: "Markdown" }
    );
    if (ctx.chat) await bridge.syncTopicTitle(ctx.chat.id, routeOf(ctx));
  });

  // /resume <id> command — resume a specific session by id (full or 8-char prefix)
  bot.command("resume", async (ctx) => {
    const arg = (ctx.match || "").trim();
    if (!arg) {
      await replyRouted(
        ctx,
        "Usage: `/resume <session-id>` — or `/sessions` to pick from a list.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const key = routeKey(routeOf(ctx));
    const state = bridge.threadState(key);
    const sessions = await listSessions(state.projectPath);
    const match = sessions.find((s) => s.id === arg || s.id.startsWith(arg));
    if (!match) {
      await replyRouted(
        ctx,
        `No session matching \`${arg}\` in this project. Use /sessions to list.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const other = bridge.store.findBySession(match.id, key);
    if (other) {
      const name = await topicLabelOf(other, match.id);
      await replyRouted(
        ctx,
        `Session is already open in topic «${name}» — continue there, or take it over:`,
        {
          reply_markup: new InlineKeyboard().text(
            "Take over here",
            `resume!:${match.id}`
          ),
        }
      );
      return;
    }

    bridge.store.bindSession(key, match.id);
    const label = match.title
      ? `**${match.title}**`
      : `\`${match.id.slice(0, 8)}...\``;
    await replyRouted(ctx, `Resumed ${label}. Next message here continues it.`, {
      parse_mode: "Markdown",
    });
    await bridge.syncTopicTitle(ctx.chat.id, routeOf(ctx));
  });

  // /history [n] — last n text messages of the current topic's session
  bot.command("history", async (ctx) => {
    const state = bridge.threadState(routeKey(routeOf(ctx)));
    if (!state.sessionId) {
      await replyRouted(
        ctx,
        "No session attached yet. Send a message, or pick one via /sessions."
      );
      return;
    }

    let limit = parseInt((ctx.match || "").trim(), 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 10;
    limit = Math.min(limit, 50);

    const messages = await readSessionMessages(
      state.projectPath,
      state.sessionId,
      limit
    );
    if (messages.length === 0) {
      await replyRouted(ctx, "Session log is empty or not found on disk.");
      return;
    }

    const title = await getSessionTitle(state.projectPath, state.sessionId);
    const header = `History of ${title || state.sessionId.slice(0, 8)} — last ${messages.length} message(s):`;

    // Session text is arbitrary, so no parse_mode (Markdown would break),
    // long messages are cut and the whole thing is chunked under Telegram's
    // 4096-char cap.
    const EXCERPT_MAX = 1500;
    const CHUNK_MAX = 4000;
    const parts = messages.map((m) => {
      const icon = m.role === "user" ? "👤" : "🤖";
      const text =
        m.text.length > EXCERPT_MAX
          ? m.text.slice(0, EXCERPT_MAX) + "…"
          : m.text;
      return `${icon} ${text}`;
    });

    const chunks: string[] = [];
    let current = header;
    for (const part of parts) {
      if (current.length + part.length + 2 > CHUNK_MAX) {
        chunks.push(current);
        current = part;
      } else {
        current += "\n\n" + part;
      }
    }
    chunks.push(current);

    for (const chunk of chunks) {
      await replyRouted(ctx, chunk);
    }
  });

  // /rename <name> — rename this topic's session; the tab follows.
  // Writes the same custom-title.json the terminal uses, so the name is
  // visible in both the bot and the terminal session picker.
  bot.command("rename", async (ctx) => {
    const name = (ctx.match || "").trim();
    if (!name) {
      await replyRouted(
        ctx,
        "Usage: `/rename <новое имя>` — переименовать сессию этой вкладки.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const state = bridge.threadState(routeKey(routeOf(ctx)));
    if (!state.sessionId) {
      await replyRouted(
        ctx,
        "No session attached yet. Send a message, or pick one via /sessions."
      );
      return;
    }

    await setSessionTitle(state.projectPath, state.sessionId, name);
    await bridge.syncTopicTitle(ctx.chat.id, routeOf(ctx));
    await replyRouted(ctx, `Renamed to «${name}».`);
  });

  // Handle photo messages (images)
  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo;
    if (!photo || photo.length === 0) return;

    // Get highest resolution photo
    const largest = photo[photo.length - 1];
    const file = await ctx.api.getFile(largest.file_id);

    if (!file.file_path) {
      await replyRouted(ctx, "Could not download image.");
      return;
    }

    // Download the file
    const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    const base64 = buffer.toString("base64");

    const ext = file.file_path.split(".").pop()?.toLowerCase() || "jpg";
    const mediaTypeMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
    };
    const mediaType = mediaTypeMap[ext] || "image/jpeg";

    const caption = ctx.message.caption || "What do you see in this image?";
    await bridge.sendMessage(ctx.chat.id, caption, extractRoute(ctx.message), [
      { data: base64, mediaType },
    ]);
    await bridge.syncTopicTitle(ctx.chat.id, extractRoute(ctx.message));
  });

  // Handle text messages — forward to Claude
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (!text || text.startsWith("/")) return; // Skip unhandled commands
    await bridge.sendMessage(ctx.chat.id, text, extractRoute(ctx.message));
    await bridge.syncTopicTitle(ctx.chat.id, extractRoute(ctx.message));
  });

  // Command menu with autocomplete — also guards against typos like /session
  await bot.api.setMyCommands([
    { command: "status", description: "Проект и сессия этой вкладки" },
    { command: "sessions", description: "Выбрать сессию для этой вкладки" },
    { command: "resume", description: "Привязать сессию по id" },
    { command: "history", description: "Последние сообщения сессии" },
    { command: "rename", description: "Переименовать сессию и вкладку" },
    { command: "new", description: "Свежая сессия в этой вкладке" },
    { command: "projects", description: "Список проектов" },
    { command: "switch", description: "Сменить проект вкладки" },
    { command: "help", description: "Справка по командам и вкладкам" },
  ]);

  return bot;
}
