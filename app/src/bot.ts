import { Bot, InlineKeyboard, InputFile, type Context } from "grammy";
import type { Message } from "grammy/types";
import { createHash } from "crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "fs/promises";
import { isAbsolute, join } from "path";
import { tmpdir } from "os";
import type { Config } from "./config.js";
import { Bridge } from "./bridge.js";
import {
  extractRoute,
  routeKey,
  sendRouted,
  type ThreadRoute,
} from "./topics.js";
import {
  baseName,
  listProjects,
  listSessions,
  getSessionTitle,
  setSessionTitle,
  readSessionMessages,
  formatRelativeTime,
  type ProjectInfo,
} from "./projects.js";

// Directory where files sent to the bot are saved for the agent to read.
const INBOX_DIR = join(process.cwd(), "inbox");

// The launcher .vbs restarts the bot when it exits with this code.
const RESTART_CODE = 42;
// Where /restart leaves a note for the fresh process to confirm the restart.
const RESTART_FLAG = join(process.cwd(), "restart.json");

function sanitizeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "file";
}

// Optimal string alignment distance (Levenshtein + adjacent transposition).
function osaDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

// A mistyped /unlock must still be recognized — otherwise the password
// stays visible in the chat next to the typo. First token, slash and
// @botname stripped, within one edit of "unlock". Exported for tests.
export function looksLikeUnlockAttempt(text: string): boolean {
  const first = text.trim().split(/\s+/)[0] ?? "";
  const word = first.replace(/^\//, "").replace(/@\w+$/, "").toLowerCase();
  if (word.length < 4) return false;
  return osaDistance(word, "unlock") <= 1;
}

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

  // Reply into the topic the update came from. A Markdown parse failure
  // falls back to plain text — losing the reply is worse than losing bold.
  async function replyRouted(
    ctx: Context,
    text: string,
    extra?: Parameters<Context["reply"]>[1]
  ): Promise<void> {
    const route = routeOf(ctx);
    try {
      await sendRouted(bot.api, ctx.chat!.id, text, route, extra);
    } catch (err) {
      if (!extra || !("parse_mode" in extra)) throw err;
      const { parse_mode: _unused, ...rest } = extra as Record<string, unknown>;
      await sendRouted(bot.api, ctx.chat!.id, text, route, rest);
    }
  }

  // A crashed handler should tell the user, not die silently in bot.out.
  bot.catch(async (err) => {
    console.error("Handler error:", err.error);
    try {
      const ctx = err.ctx;
      if (ctx.chat) {
        const reason = String((err.error as any)?.message ?? err.error).slice(0, 200);
        await sendRouted(
          bot.api,
          ctx.chat.id,
          `⚠️ Ошибка обработчика: ${reason}`,
          extractRoute(
            ctx.message ?? (ctx.callbackQuery?.message as Message | undefined)
          )
        );
      }
    } catch {
      // reporting must never crash the bot
    }
  });

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

  // Auth middleware — drop unauthorized users (with a trace in the log)
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.allowedUserId) {
      console.log(`[auth] dropped update from user ${ctx.from?.id ?? "?"}`);
      return;
    }
    await next();
  });

  // Password gate (enabled when VIBEIDE_PASSWORD_HASH is set in .env).
  // The whitelist protects against strangers; the password protects against
  // the owner's Telegram account in the wrong hands. State is in-memory:
  // a bot restart locks it again.
  let unlockedUntil = 0;
  let failedAttempts = 0;
  let attemptsBlockedUntil = 0;
  const AUTOLOCK_MS = config.autolockMinutes * 60_000;

  bot.use(async (ctx, next) => {
    if (!config.passwordHash) return next();
    const now = Date.now();
    const text = ctx.message?.text ?? "";

    if (looksLikeUnlockAttempt(text)) {
      const password = text.trim().split(/\s+/).slice(1).join(" ");
      // The password must not stay in the chat history.
      ctx.api
        .deleteMessage(ctx.chat!.id, ctx.message!.message_id)
        .catch(() => {});
      if (!password) {
        await replyRouted(ctx, "Использование: /unlock <пароль>");
        return;
      }
      if (now < attemptsBlockedUntil) {
        await replyRouted(
          ctx,
          `⏳ Слишком много попыток. Подожди ${Math.ceil((attemptsBlockedUntil - now) / 60_000)} мин.`
        );
        return;
      }
      const hash = createHash("sha256").update(password, "utf-8").digest("hex");
      if (hash === config.passwordHash) {
        unlockedUntil = now + AUTOLOCK_MS;
        failedAttempts = 0;
        await replyRouted(
          ctx,
          `🔓 Разблокирован на ${config.autolockMinutes} мин (продлевается активностью). /lock — заблокировать сразу.`
        );
      } else {
        failedAttempts++;
        if (failedAttempts >= 5) {
          attemptsBlockedUntil = now + 5 * 60_000;
          failedAttempts = 0;
          await replyRouted(ctx, "⛔ Пять неверных паролей — пауза 5 минут.");
        } else {
          await replyRouted(ctx, "🔒 Неверный пароль.");
        }
      }
      return;
    }

    if (/^\/lock(@\w+)?$/.test(text.trim())) {
      unlockedUntil = 0;
      await replyRouted(ctx, "🔒 Заблокирован. /unlock <пароль> — разблокировать.");
      return;
    }

    if (now >= unlockedUntil) {
      if (ctx.callbackQuery) {
        try {
          await ctx.answerCallbackQuery({ text: "🔒 Бот заблокирован" });
        } catch {
          // stale callback
        }
      } else {
        // While locked, any text may be a mistyped password — remove it;
        // the bot would not process it anyway.
        if (ctx.message?.text) {
          ctx.api
            .deleteMessage(ctx.chat!.id, ctx.message.message_id)
            .catch(() => {});
        }
        await replyRouted(
          ctx,
          "🔒 Бот заблокирован, сообщение удалено. /unlock <пароль>"
        );
      }
      return;
    }

    unlockedUntil = now + AUTOLOCK_MS; // sliding renewal on activity
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
        "/stop — прервать текущую задачу и очистить очередь",
        "/sessions — выбрать сессию (листается кнопками Ещё/Назад)",
        "/resume <id> — привязать сессию по id (хватит первых 8 символов)",
        "/history [n] — последние n реплик сессии; /history all — вся история файлом",
        "/rename <имя> — переименовать сессию (и вкладку); имя видно и в терминале",
        "/get <путь> — прислать файл из проекта в чат",
        "/new — отвязать сессию: следующее сообщение начнёт свежую",
        "/projects — список проектов",
        "/switch — сменить проект этой вкладки",
        "/mode safe|fast — подтверждать ли опасные действия (Bash/Write/Edit) кнопками; режим свой у каждой вкладки",
        "/lock и /unlock <пароль> — замок бота (работает, если в .env задан VIBEIDE_PASSWORD_HASH)",
        "/restart — перезапустить бота (например, после обновления кода)",
        "/shutdown — выключить бота совсем (поднять — ярлыком на рабочем столе)",
        "/help — эта справка",
        "",
        "*Пометки в /sessions:*",
        "● — сессия этой вкладки",
        "📌 — уже открыта в другой вкладке; при выборе бот предложит «Take over here» — забрать сюда",
        "🟢 — пишется прямо сейчас (например, открыта в терминале — лучше не трогать)",
        "",
        "Пока бот занят, новые сообщения встают в очередь (до 5).",
        "Во время работы бот показывает «печатает…» и текущий инструмент (⚙️).",
        "Фото и файлы можно отправлять с подписью: фото бот видит, файл сохраняет и передаёт агенту путь.",
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

  // /stop — interrupt the running query of this topic and clear its queue
  bot.command("stop", async (ctx) => {
    const result = await bridge.stop(routeKey(routeOf(ctx)));
    await replyRouted(
      ctx,
      result === "stopped"
        ? "⏹ Останавливаю. Очередь очищена."
        : "Сейчас ничего не выполняется."
    );
  });

  // /restart — exit with RESTART_CODE so the launcher loop starts us again.
  // bot.stop() first: it confirms the update offset, otherwise Telegram
  // redelivers /restart to the fresh process and the bot loops forever.
  bot.command("restart", async (ctx) => {
    await replyRouted(ctx, "🔄 Перезапускаюсь…");
    try {
      await writeFile(
        RESTART_FLAG,
        JSON.stringify({ chatId: ctx.chat.id, route: routeOf(ctx) }),
        "utf-8"
      );
    } catch {
      // confirmation is optional
    }
    await bot.stop();
    process.exit(RESTART_CODE);
  });

  // /shutdown — stop the bot completely (the launcher loop ends too).
  bot.command("shutdown", async (ctx) => {
    await replyRouted(
      ctx,
      "⏻ Выключаюсь. Поднять — ярлыком VibeIDE на рабочем столе."
    );
    await bot.stop();
    process.exit(0);
  });

  // /mode safe|fast — per-topic confirmation mode for dangerous tools
  bot.command("mode", async (ctx) => {
    const arg = (ctx.match || "").trim().toLowerCase();
    const key = routeKey(routeOf(ctx));
    if (arg === "safe") {
      bridge.store.setSafeMode(key, true);
      await replyRouted(
        ctx,
        "🛡 Safe-режим этой вкладки: Bash/Write/Edit — только после подтверждения кнопками."
      );
    } else if (arg === "fast") {
      bridge.store.setSafeMode(key, false);
      await replyRouted(ctx, "⚡ Fast-режим этой вкладки: все действия без подтверждений.");
    } else {
      const state = bridge.threadState(key);
      await replyRouted(
        ctx,
        `Режим этой вкладки: ${state.safeMode ? "🛡 safe" : "⚡ fast"}. Сменить: /mode safe | /mode fast`
      );
    }
  });

  // Safe-mode confirmation buttons
  bot.callbackQuery(/^perm:/, async (ctx) => {
    const [, id, verdict] = ctx.callbackQuery.data.split(":");
    const ok = bridge.resolvePermission(
      id,
      verdict as "allow" | "deny" | "all"
    );
    await ctx.answerCallbackQuery(
      ok ? undefined : { text: "Запрос уже решён или устарел" }
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
    const name = baseName(projectPath);
    await ctx.answerCallbackQuery();
    const sessionNote = resumedId
      ? `Resumed session \`${resumedId.slice(0, 8)}...\``
      : "Starting fresh session.";
    await ctx.editMessageText(`Switched to **${name}**\n\`${projectPath}\`\n\n${sessionNote}`, {
      parse_mode: "Markdown",
    });
  });

  const SESSIONS_PAGE = 10;

  // One page of the session picker for a topic; undefined when no sessions.
  async function sessionsView(
    key: string,
    offset: number
  ): Promise<{ text: string; keyboard: InlineKeyboard } | undefined> {
    const state = bridge.threadState(key);
    const sessions = await listSessions(state.projectPath);
    if (sessions.length === 0) return undefined;
    const safeOffset = Math.max(
      0,
      Math.min(offset, Math.max(0, sessions.length - 1))
    );

    const keyboard = new InlineKeyboard();
    for (const s of sessions.slice(safeOffset, safeOffset + SESSIONS_PAGE)) {
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
    if (safeOffset > 0) {
      keyboard.text("◂ Назад", `sessions:${Math.max(0, safeOffset - SESSIONS_PAGE)}`);
    }
    if (sessions.length > safeOffset + SESSIONS_PAGE) {
      keyboard.text("Ещё ▸", `sessions:${safeOffset + SESSIONS_PAGE}`);
    }

    const text =
      sessions.length > SESSIONS_PAGE
        ? `Pick a session (${safeOffset + 1}–${Math.min(safeOffset + SESSIONS_PAGE, sessions.length)} of ${sessions.length}):`
        : "Pick a session to resume:";
    return { text, keyboard };
  }

  // /sessions command — paged list of the current topic's project sessions
  bot.command("sessions", async (ctx) => {
    const key = routeKey(routeOf(ctx));
    const view = await sessionsView(key, 0);
    if (!view) {
      const state = bridge.threadState(key);
      await replyRouted(
        ctx,
        `No sessions found for \`${state.projectPath}\``,
        { parse_mode: "Markdown" }
      );
      return;
    }
    await replyRouted(ctx, view.text, { reply_markup: view.keyboard });
  });

  // Pagination of the session picker (Ещё / Назад)
  bot.callbackQuery(/^sessions:/, async (ctx) => {
    const offset =
      parseInt(ctx.callbackQuery.data.slice("sessions:".length), 10) || 0;
    const view = await sessionsView(routeKey(routeOf(ctx)), offset);
    await ctx.answerCallbackQuery();
    if (view) {
      await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
    }
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

  // Send a document into the topic; on routing failure send it plain.
  async function sendDocumentRouted(
    ctx: Context,
    file: InputFile,
    caption?: string
  ): Promise<void> {
    const route = routeOf(ctx);
    try {
      await bot.api.sendDocument(ctx.chat!.id, file, {
        caption,
        ...(route.messageThreadId !== undefined
          ? { message_thread_id: route.messageThreadId }
          : {}),
      });
    } catch {
      await bot.api.sendDocument(ctx.chat!.id, file, { caption });
    }
  }

  // /history [n|all] — last n text messages of the current topic's session,
  // or the whole conversation as a text file
  bot.command("history", async (ctx) => {
    const state = bridge.threadState(routeKey(routeOf(ctx)));
    if (!state.sessionId) {
      await replyRouted(
        ctx,
        "No session attached yet. Send a message, or pick one via /sessions."
      );
      return;
    }

    const arg = (ctx.match || "").trim().toLowerCase();
    if (arg === "all") {
      const messages = await readSessionMessages(
        state.projectPath,
        state.sessionId,
        Number.MAX_SAFE_INTEGER
      );
      if (messages.length === 0) {
        await replyRouted(ctx, "Session log is empty or not found on disk.");
        return;
      }
      const title = await getSessionTitle(state.projectPath, state.sessionId);
      const body = messages
        .map((m) => `${m.role === "user" ? "👤 USER" : "🤖 CLAUDE"}\n${m.text}`)
        .join("\n\n" + "-".repeat(40) + "\n\n");
      const fileBase = sanitizeFileName(title || state.sessionId.slice(0, 8));
      const tmpFile = join(tmpdir(), `vibeide-${Date.now()}.txt`);
      await writeFile(tmpFile, `${title ?? state.sessionId}\n\n${body}`, "utf-8");
      try {
        await sendDocumentRouted(
          ctx,
          new InputFile(tmpFile, `${fileBase}.txt`),
          `История: ${messages.length} сообщений`
        );
      } finally {
        await unlink(tmpFile).catch(() => {});
      }
      return;
    }

    let limit = parseInt(arg, 10);
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

  // /get <path> — send a file from the project (or an absolute path) to chat
  bot.command("get", async (ctx) => {
    const arg = (ctx.match || "").trim().replace(/^["']|["']$/g, "");
    if (!arg) {
      await replyRouted(
        ctx,
        "Usage: `/get <путь>` — файл из проекта (относительный) или абсолютный путь.",
        { parse_mode: "Markdown" }
      );
      return;
    }

    const state = bridge.threadState(routeKey(routeOf(ctx)));
    const filePath = isAbsolute(arg) ? arg : join(state.projectPath, arg);
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      await replyRouted(ctx, `Файл не найден: ${filePath}`);
      return;
    }
    if (info.size > 50 * 1024 * 1024) {
      await replyRouted(
        ctx,
        `Файл больше 50 МБ (${Math.round(info.size / 1024 / 1024)} МБ) — Telegram не пропустит.`
      );
      return;
    }
    await sendDocumentRouted(ctx, new InputFile(filePath));
  });

  // Handle documents — save into the inbox and hand the path to the agent
  bot.on("message:document", async (ctx) => {
    const doc = ctx.message.document;
    let file;
    try {
      file = await ctx.api.getFile(doc.file_id);
    } catch {
      // Bot API refuses files above 20 MB
      await replyRouted(
        ctx,
        "Не могу скачать: Telegram отдаёт ботам файлы только до 20 МБ."
      );
      return;
    }
    if (!file.file_path) {
      await replyRouted(ctx, "Could not download file.");
      return;
    }

    const url = `https://api.telegram.org/file/bot${config.telegramBotToken}/${file.file_path}`;
    const response = await fetch(url);
    const buffer = Buffer.from(await response.arrayBuffer());

    await mkdir(INBOX_DIR, { recursive: true });
    const name = sanitizeFileName(doc.file_name || "file.bin");
    const savedPath = join(INBOX_DIR, `${Date.now()}-${name}`);
    await writeFile(savedPath, buffer);

    const caption = ctx.message.caption;
    const note = `[Файл от пользователя сохранён: ${savedPath}]`;
    const prompt = caption
      ? `${caption}\n\n${note}`
      : `${note} Посмотри этот файл.`;
    await bridge.sendMessage(ctx.chat.id, prompt, extractRoute(ctx.message));
    await bridge.syncTopicTitle(ctx.chat.id, extractRoute(ctx.message));
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
    { command: "stop", description: "Прервать текущую задачу" },
    { command: "sessions", description: "Выбрать сессию для этой вкладки" },
    { command: "resume", description: "Привязать сессию по id" },
    { command: "history", description: "Последние сообщения сессии (all — файлом)" },
    { command: "rename", description: "Переименовать сессию и вкладку" },
    { command: "get", description: "Прислать файл из проекта" },
    { command: "new", description: "Свежая сессия в этой вкладке" },
    { command: "projects", description: "Список проектов" },
    { command: "switch", description: "Сменить проект вкладки" },
    { command: "mode", description: "Режим вкладки: safe (с подтверждениями) | fast" },
    { command: "lock", description: "Заблокировать бота (если задан пароль)" },
    { command: "help", description: "Справка по командам и вкладкам" },
    { command: "restart", description: "Перезапустить бота" },
    { command: "shutdown", description: "Выключить бота" },
  ]);

  // Confirm a /restart to the topic that requested it.
  try {
    const raw = JSON.parse(await readFile(RESTART_FLAG, "utf-8"));
    await unlink(RESTART_FLAG).catch(() => {});
    if (raw?.chatId) {
      await sendRouted(bot.api, raw.chatId, "✅ Перезапущен.", raw.route ?? {});
    }
  } catch {
    // no restart pending
  }

  return bot;
}
