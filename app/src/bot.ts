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

// Escape special HTML characters for Telegram parse_mode: "HTML".
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
  let rcEnabled = true;

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
  // the owner's Telegram account in the wrong hands. State is per-topic and
  // in-memory: a bot restart locks every topic again.
  interface LockState {
    unlockedUntil: number;
    failedAttempts: number;
    attemptsBlockedUntil: number;
  }
  const lockStates = new Map<string, LockState>();
  const AUTOLOCK_MS = config.autolockMinutes * 60_000;

  function getLock(key: string): LockState {
    let s = lockStates.get(key);
    if (!s) {
      s = { unlockedUntil: 0, failedAttempts: 0, attemptsBlockedUntil: 0 };
      lockStates.set(key, s);
    }
    return s;
  }

  bot.use(async (ctx, next) => {
    if (!config.passwordHash) return next();
    const now = Date.now();
    const text = ctx.message?.text ?? "";
    const key = routeKey(routeOf(ctx));
    const lock = getLock(key);

    if (looksLikeUnlockAttempt(text)) {
      const password = text.trim().split(/\s+/).slice(1).join(" ");
      // The password must not stay in the chat history.
      ctx.api
        .deleteMessage(ctx.chat!.id, ctx.message!.message_id)
        .catch(() => {});
      if (!password) {
        await replyRouted(ctx, "Использование: /unlock <code>&lt;пароль&gt;</code>", { parse_mode: "HTML" });
        return;
      }
      if (now < lock.attemptsBlockedUntil) {
        await replyRouted(
          ctx,
          `⏳ Слишком много попыток. Подожди ${Math.ceil((lock.attemptsBlockedUntil - now) / 60_000)} мин.`
        );
        return;
      }
      const hash = createHash("sha256").update(password, "utf-8").digest("hex");
      if (hash === config.passwordHash) {
        lock.unlockedUntil = now + AUTOLOCK_MS;
        lock.failedAttempts = 0;
        await replyRouted(
          ctx,
          `🔓 Вкладка разблокирована на ${config.autolockMinutes} мин (продлевается активностью). /lock — заблокировать.`,
          { parse_mode: "HTML" }
        );
      } else {
        lock.failedAttempts++;
        if (lock.failedAttempts >= 5) {
          lock.attemptsBlockedUntil = now + 5 * 60_000;
          lock.failedAttempts = 0;
          await replyRouted(ctx, "⛔ Пять неверных паролей — пауза 5 минут.");
        } else {
          await replyRouted(ctx, "🔒 Неверный пароль.");
        }
      }
      return;
    }

    if (/^\/lock(@\w+)?$/.test(text.trim())) {
      lock.unlockedUntil = 0;
      await replyRouted(ctx, "🔒 Вкладка заблокирована. /unlock <code>&lt;пароль&gt;</code>", { parse_mode: "HTML" });
      return;
    }

    if (now >= lock.unlockedUntil) {
      if (ctx.callbackQuery) {
        try {
          await ctx.answerCallbackQuery({ text: "🔒 Вкладка заблокирована" });
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
          "🔒 Вкладка заблокирована, сообщение удалено. /unlock <code>&lt;пароль&gt;</code>",
          { parse_mode: "HTML" }
        );
      }
      return;
    }

    lock.unlockedUntil = now + AUTOLOCK_MS; // sliding renewal on activity
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
      `<b>VibeIDE connected.</b>\nПроект: <code>${escHtml(state.projectPath)}</code>\n\nКаждая вкладка чата — отдельная сессия. Новая вкладка = новая сессия.\n\n/help — справка по командам`,
      { parse_mode: "HTML" }
    );
  });

  // /help — справка (RU): команды, поведение вкладок, легенда пометок
  bot.command("help", async (ctx) => {
    await replyRouted(
      ctx,
      [
        "<b>Справка VibeIDE</b>",
        "",
        "Каждая вкладка (тема) чата — отдельная сессия Claude Code:",
        "• пишешь <b>внутри вкладки</b> — продолжаешь её сессию",
        "• пишешь <b>из корня чата</b> — Telegram создаёт новую вкладку, бот заведёт свежую сессию",
        "• вкладка сама переименовывается по имени сессии",
        "",
        "<b>Сессия</b>",
        "/fresh — следующее сообщение <b>без истории</b> (новая сессия, старая в /sessions)",
        "/history <code>[n]</code> — последние n реплик; <code>all</code> — вся история файлом",
        "/new — отвязать сессию: следующее сообщение начнёт свежую",
        "/rename <code>&lt;имя&gt;</code> — переименовать сессию и вкладку",
        "/resume <code>&lt;id&gt;</code> — привязать сессию по id (хватит первых 8 символов)",
        "/sessions — выбрать сессию (листается кнопками)",
        "/status — проект, вкладка и сессия",
        "",
        "<b>Проект</b>",
        "/get <code>&lt;путь&gt;</code> — прислать файл из проекта в чат",
        "/projects — список проектов",
        "/switch — сменить проект этой вкладки",
        "",
        "<b>Модель и скорость</b>",
        "/model — модель: fable, opus, sonnet, haiku (+ opus4, sonnet4) или полный ID",
        "/speed — скорость мышления: fast, normal, deep — или число токенов",
        "",
        "<b>Управление</b>",
        "/settings — панель настроек вкладки (модель, скорость, режим)",
        "/lock, /unlock <code>&lt;пароль&gt;</code> — замок бота",
        "/mode <code>safe|fast</code> — подтверждать ли Bash/Write/Edit кнопками",
        "/rc <code>[on|off]</code> — удалённое управление: мастер-выключатель обработки сообщений",
        "/restart — перезапустить бота",
        "/shutdown — выключить бота",
        "/stop — прервать текущую задачу и очистить очередь",
        "",
        "<b>Пометки в /sessions</b>",
        "● — сессия этой вкладки",
        "📌 — открыта в другой вкладке (можно забрать «Take over here»)",
        "🟢 — кто-то пишет прямо сейчас (терминал — лучше не трогать)",
        "",
        "Пока бот занят, сообщения встают в очередь (до 5).",
        "Фото бот видит; файлы сохраняет и передаёт агенту путь.",
      ].join("\n"),
      { parse_mode: "HTML" }
    );
  });

  // /status command — project and session of the current topic
  bot.command("status", async (ctx) => {
    const state = bridge.threadState(routeKey(routeOf(ctx)));
    await bridge.syncTopicTitle(ctx.chat.id, routeOf(ctx));
    let sessionInfo = "нет (начнётся со следующего сообщения)";
    if (state.sessionId) {
      const title = await getSessionTitle(state.projectPath, state.sessionId);
      const shortId = state.sessionId.slice(0, 8);
      sessionInfo = title ? `<b>${escHtml(title)}</b> (<code>${shortId}</code>)` : `<code>${shortId}…</code>`;
    }
    await replyRouted(
      ctx,
      `<b>Проект:</b> <code>${escHtml(state.projectPath)}</code>\n<b>Вкладка:</b> <code>${routeKey(routeOf(ctx))}</code>\n<b>Сессия:</b> ${sessionInfo}`,
      { parse_mode: "HTML" }
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

  // /rc — remote control master switch
  bot.command("rc", async (ctx) => {
    const arg = (ctx.match || "").trim().toLowerCase();
    if (arg === "on" || arg === "1") {
      rcEnabled = true;
      await replyRouted(ctx, "📡 Удалённое управление <b>включено</b>.", { parse_mode: "HTML" });
    } else if (arg === "off" || arg === "0") {
      rcEnabled = false;
      await replyRouted(ctx, "🔇 Удалённое управление <b>выключено</b>. Бот не обрабатывает сообщения.", { parse_mode: "HTML" });
    } else {
      rcEnabled = !rcEnabled;
      await replyRouted(
        ctx,
        rcEnabled
          ? "📡 Удалённое управление <b>включено</b>."
          : "🔇 Удалённое управление <b>выключено</b>. Бот не обрабатывает сообщения.",
        { parse_mode: "HTML" }
      );
    }
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

  // /model — switch Claude model for this topic
  // Models are loaded from models.json (next to topics.json); if missing,
  // built-in defaults are used.  /model reload re-reads the file at runtime.
  const MODELS_FILE = join(process.cwd(), "models.json");

  interface ModelCatalog {
    presets: Record<string, { id: string; label: string }>;
    aliases: Record<string, string>;
  }

  const BUILTIN_PRESETS: ModelCatalog["presets"] = {
    "fable5.1": { id: "claude-fable-5-1", label: "Fable 5.1" },
    opus5:      { id: "claude-opus-5", label: "Opus 5" },
    sonnet5:    { id: "claude-sonnet-5", label: "Sonnet 5" },
    haiku:      { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
    opus4:      { id: "claude-opus-4-5-20250929", label: "Opus 4.5" },
    sonnet4:    { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5" },
  };
  const BUILTIN_ALIASES: ModelCatalog["aliases"] = {
    "fable": "fable5.1", "fable5": "fable5.1", "fable-5.1": "fable5.1", "fable-5": "fable5.1",
    "opus": "opus5", "opus-5": "opus5",
    "sonnet": "sonnet5", "sonnet-5": "sonnet5",
    "haiku4.5": "haiku", "haiku-4.5": "haiku", "haiku4": "haiku", "haiku-4": "haiku",
    "opus4.5": "opus4", "opus-4.5": "opus4", "opus-4": "opus4",
    "sonnet4.5": "sonnet4", "sonnet-4.5": "sonnet4", "sonnet-4": "sonnet4",
  };

  let MODEL_PRESETS = { ...BUILTIN_PRESETS };
  let MODEL_ALIASES = { ...BUILTIN_ALIASES };

  async function loadModelCatalog(): Promise<boolean> {
    try {
      const raw = JSON.parse(await readFile(MODELS_FILE, "utf-8")) as ModelCatalog;
      if (raw.presets && typeof raw.presets === "object") {
        MODEL_PRESETS = raw.presets;
      }
      if (raw.aliases && typeof raw.aliases === "object") {
        MODEL_ALIASES = raw.aliases;
      }
      return true;
    } catch {
      // File missing or invalid — keep current (builtin) values.
      return false;
    }
  }

  // Try loading from file at startup; fall back to builtins silently.
  await loadModelCatalog();

  bot.command("model", async (ctx) => {
    const key = routeKey(routeOf(ctx));
    const arg = (ctx.match || "").trim().toLowerCase();

    if (arg === "reload") {
      const ok = await loadModelCatalog();
      const count = Object.keys(MODEL_PRESETS).length;
      await replyRouted(
        ctx,
        ok
          ? `🔄 <code>models.json</code> перечитан — ${count} моделей.`
          : "⚠️ <code>models.json</code> не найден или невалиден — используются встроенные.",
        { parse_mode: "HTML" }
      );
      return;
    }

    if (arg === "reset" || arg === "default" || arg === "auto") {
      bridge.store.setModel(key, undefined);
      await replyRouted(ctx, "🔄 Модель сброшена на <b>по умолчанию</b> (SDK default).", { parse_mode: "HTML" });
      return;
    }

    if (arg) {
      const resolved = MODEL_ALIASES[arg] ?? arg;
      const preset = MODEL_PRESETS[resolved];
      if (preset) {
        bridge.store.setModel(key, preset.id);
        await replyRouted(ctx, `🧠 Модель: <b>${escHtml(preset.label)}</b>\n<code>${escHtml(preset.id)}</code>`, { parse_mode: "HTML" });
        return;
      }
      // Full model ID passed directly
      if (arg.startsWith("claude-")) {
        bridge.store.setModel(key, arg);
        await replyRouted(ctx, `🧠 Модель: <code>${escHtml(arg)}</code>`, { parse_mode: "HTML" });
        return;
      }
      const names = Object.values(MODEL_PRESETS).map((p) => p.label).join(", ");
      await replyRouted(ctx, `Неизвестная модель: <code>${escHtml(arg)}</code>.\nДоступные: ${escHtml(names)}, auto — или полный ID (claude-…).\n/model reload — перечитать <code>models.json</code>.`, { parse_mode: "HTML" });
      return;
    }

    // No argument — show current + picker buttons
    const state = bridge.threadState(key);
    const current = state.model
      ? Object.values(MODEL_PRESETS).find((p) => p.id === state.model)?.label ?? state.model
      : "по умолчанию";
    const keyboard = new InlineKeyboard();
    const entries = Object.entries(MODEL_PRESETS);
    for (let i = 0; i < entries.length; i++) {
      const [slug, preset] = entries[i];
      const mark = state.model === preset.id ? "● " : "";
      keyboard.text(`${mark}${preset.label}`, `model:${slug}`);
      if (i % 3 === 2) keyboard.row();
    }
    keyboard.row().text(state.model ? "Сброс" : "● Авто", "model:reset");
    await replyRouted(ctx, `🧠 Модель: <b>${escHtml(current)}</b>`, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(/^model:/, async (ctx) => {
    const slug = ctx.callbackQuery.data.slice("model:".length);
    const key = routeKey(routeOf(ctx));
    if (slug === "reset") {
      bridge.store.setModel(key, undefined);
      await ctx.answerCallbackQuery({ text: "Модель: авто" });
      await ctx.editMessageText("🧠 Модель: <b>по умолчанию</b>", { parse_mode: "HTML" });
      return;
    }
    const preset = MODEL_PRESETS[slug];
    if (!preset) {
      await ctx.answerCallbackQuery({ text: "?" });
      return;
    }
    bridge.store.setModel(key, preset.id);
    await ctx.answerCallbackQuery({ text: `Модель: ${preset.label}` });
    await ctx.editMessageText(`🧠 Модель: <b>${escHtml(preset.label)}</b>\n<code>${escHtml(preset.id)}</code>`, { parse_mode: "HTML" });
  });

  // /speed — thinking budget (speed vs depth)
  const SPEED_PRESETS: Record<string, { tokens: number | undefined; label: string; emoji: string }> = {
    fast:   { tokens: 1024,      label: "Быстрый",     emoji: "⚡" },
    normal: { tokens: undefined,  label: "Нормальный",  emoji: "🔹" },
    deep:   { tokens: 32768,     label: "Глубокий",     emoji: "🧠" },
  };

  bot.command("speed", async (ctx) => {
    const key = routeKey(routeOf(ctx));
    const arg = (ctx.match || "").trim().toLowerCase();

    if (arg && SPEED_PRESETS[arg]) {
      const preset = SPEED_PRESETS[arg];
      bridge.store.setMaxThinkingTokens(key, preset.tokens);
      await replyRouted(ctx, `${preset.emoji} Скорость: <b>${preset.label}</b>${preset.tokens ? ` (thinking: ${preset.tokens})` : ""}`, { parse_mode: "HTML" });
      return;
    }
    if (arg) {
      const n = parseInt(arg, 10);
      if (Number.isFinite(n) && n > 0) {
        bridge.store.setMaxThinkingTokens(key, n);
        await replyRouted(ctx, `🎛 maxThinkingTokens = <b>${n}</b>`, { parse_mode: "HTML" });
        return;
      }
      await replyRouted(ctx, "Использование: /speed fast | normal | deep — или число токенов.", { parse_mode: "HTML" });
      return;
    }

    // No argument — show current + picker
    const state = bridge.threadState(key);
    const currentPreset = Object.entries(SPEED_PRESETS).find(
      ([, p]) => p.tokens === state.maxThinkingTokens
    );
    const currentLabel = currentPreset
      ? `${currentPreset[1].emoji} ${currentPreset[1].label}`
      : state.maxThinkingTokens
        ? `🎛 thinking: ${state.maxThinkingTokens}`
        : "🔹 Нормальный";
    const keyboard = new InlineKeyboard();
    for (const [slug, preset] of Object.entries(SPEED_PRESETS)) {
      const mark = (state.maxThinkingTokens === preset.tokens) ||
        (!state.maxThinkingTokens && !preset.tokens) ? "● " : "";
      keyboard.text(`${mark}${preset.emoji} ${preset.label}`, `speed:${slug}`);
    }
    await replyRouted(ctx, `Скорость: <b>${escHtml(currentLabel)}</b>`, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(/^speed:/, async (ctx) => {
    const slug = ctx.callbackQuery.data.slice("speed:".length);
    const key = routeKey(routeOf(ctx));
    const preset = SPEED_PRESETS[slug];
    if (!preset) {
      await ctx.answerCallbackQuery({ text: "?" });
      return;
    }
    bridge.store.setMaxThinkingTokens(key, preset.tokens);
    await ctx.answerCallbackQuery({ text: `Скорость: ${preset.label}` });
    await ctx.editMessageText(`${preset.emoji} Скорость: <b>${preset.label}</b>${preset.tokens ? ` (thinking: ${preset.tokens})` : ""}`, { parse_mode: "HTML" });
  });

  // /mode safe|fast — per-topic confirmation mode for dangerous tools
  bot.command("mode", async (ctx) => {
    const arg = (ctx.match || "").trim().toLowerCase();
    const key = routeKey(routeOf(ctx));
    if (arg === "safe") {
      bridge.store.setSafeMode(key, true);
      await replyRouted(
        ctx,
        "🛡 <b>Safe</b>-режим: Bash/Write/Edit — только после подтверждения кнопками.",
        { parse_mode: "HTML" }
      );
    } else if (arg === "fast") {
      bridge.store.setSafeMode(key, false);
      await replyRouted(
        ctx,
        "⚡ <b>Fast</b>-режим: все действия без подтверждений.",
        { parse_mode: "HTML" }
      );
    } else {
      const state = bridge.threadState(key);
      await replyRouted(
        ctx,
        `Режим вкладки: ${state.safeMode ? "🛡 <b>safe</b>" : "⚡ <b>fast</b>"}. Сменить: /mode safe | /mode fast`,
        { parse_mode: "HTML" }
      );
    }
  });

  // /settings — unified settings panel with inline buttons
  function settingsText(key: string): string {
    const state = bridge.threadState(key);
    const modelLabel = state.model
      ? Object.values(MODEL_PRESETS).find((p) => p.id === state.model)?.label ?? state.model
      : "авто";
    const speedEntry = Object.entries(SPEED_PRESETS).find(
      ([, p]) => p.tokens === state.maxThinkingTokens
    );
    const speedLabel = speedEntry
      ? `${speedEntry[1].emoji} ${speedEntry[1].label}`
      : state.maxThinkingTokens
        ? `🎛 ${state.maxThinkingTokens}`
        : "🔹 Нормальный";
    const modeLabel = state.safeMode ? "🛡 safe" : "⚡ fast";
    return [
      "<b>Настройки вкладки</b>",
      "",
      `🧠 Модель: <b>${escHtml(modelLabel)}</b>`,
      `⏩ Скорость: <b>${escHtml(speedLabel)}</b>`,
      `🔧 Режим: <b>${modeLabel}</b>`,
    ].join("\n");
  }

  function settingsKeyboard(key: string): InlineKeyboard {
    const state = bridge.threadState(key);
    const kb = new InlineKeyboard();
    // Row 1 — model quick picks (top 4)
    const topModels = Object.entries(MODEL_PRESETS).slice(0, 4);
    for (const [slug, preset] of topModels) {
      const mark = state.model === preset.id ? "● " : "";
      kb.text(`${mark}${preset.label}`, `set:model:${slug}`);
    }
    kb.row();
    // Row 2 — speed
    for (const [slug, preset] of Object.entries(SPEED_PRESETS)) {
      const mark = (state.maxThinkingTokens === preset.tokens) ||
        (!state.maxThinkingTokens && !preset.tokens) ? "● " : "";
      kb.text(`${mark}${preset.emoji} ${preset.label}`, `set:speed:${slug}`);
    }
    kb.row();
    // Row 3 — mode toggle
    kb.text(
      state.safeMode ? "🛡 Safe → ⚡ Fast" : "⚡ Fast → 🛡 Safe",
      `set:mode:${state.safeMode ? "fast" : "safe"}`
    );
    return kb;
  }

  bot.command("settings", async (ctx) => {
    const key = routeKey(routeOf(ctx));
    await replyRouted(ctx, settingsText(key), {
      parse_mode: "HTML",
      reply_markup: settingsKeyboard(key),
    });
  });

  bot.callbackQuery(/^set:/, async (ctx) => {
    const parts = ctx.callbackQuery.data.split(":");
    const [, category, value] = parts;
    const key = routeKey(routeOf(ctx));

    if (category === "model") {
      if (value === "reset") {
        bridge.store.setModel(key, undefined);
      } else {
        const preset = MODEL_PRESETS[value];
        if (preset) bridge.store.setModel(key, preset.id);
      }
    } else if (category === "speed") {
      const preset = SPEED_PRESETS[value];
      if (preset) bridge.store.setMaxThinkingTokens(key, preset.tokens);
    } else if (category === "mode") {
      bridge.store.setSafeMode(key, value === "safe");
    }

    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(settingsText(key), {
        parse_mode: "HTML",
        reply_markup: settingsKeyboard(key),
      });
    } catch {
      // message unchanged
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
      "Сессия отвязана. Следующее сообщение начнёт <b>новую</b> сессию.",
      { parse_mode: "HTML" }
    );
  });

  // /fresh — next message goes without resume (new session), but the old
  // session stays available via /sessions. Useful when the session history
  // is too large for the context window.
  bot.command("fresh", async (ctx) => {
    const key = routeKey(routeOf(ctx));
    bridge.store.setFreshNext(key, true);
    await replyRouted(
      ctx,
      "Следующее сообщение пойдёт <b>без истории</b> (новая сессия).\nСтарая сессия останется в /sessions.",
      { parse_mode: "HTML" }
    );
  });

  // /projects command — list available projects
  bot.command("projects", async (ctx) => {
    const projects = await listProjects();
    if (projects.length === 0) {
      await replyRouted(ctx, "Проекты не найдены.");
      return;
    }

    const lines = projects.slice(0, 20).map(
      (p, i) => `${i + 1}. <b>${escHtml(p.name)}</b> (${formatRelativeTime(p.lastActivity)})\n   <code>${escHtml(p.path)}</code>`
    );
    await replyRouted(ctx, lines.join("\n"), { parse_mode: "HTML" });
  });

  // /switch command — show project picker for the current topic
  bot.command("switch", async (ctx) => {
    const projects = await listProjects();
    if (projects.length === 0) {
      await replyRouted(ctx, "Проекты не найдены.");
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

    await replyRouted(ctx, "Выберите проект:", { reply_markup: keyboard });
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
      ? `Продолжена сессия <code>${resumedId.slice(0, 8)}…</code>`
      : "Начнётся новая сессия.";
    await ctx.editMessageText(`Переключено на <b>${escHtml(name)}</b>\n<code>${escHtml(projectPath)}</code>\n\n${sessionNote}`, {
      parse_mode: "HTML",
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
        ? `Выберите сессию (${safeOffset + 1}–${Math.min(safeOffset + SESSIONS_PAGE, sessions.length)} из ${sessions.length}):`
        : "Выберите сессию:";
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
        `Сессий не найдено для <code>${escHtml(state.projectPath)}</code>`,
        { parse_mode: "HTML" }
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
        `Сессия уже открыта во вкладке «${escHtml(name)}» — продолжить там или забрать сюда:`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text(
            "Забрать сюда",
            `resume!:${id}`
          ),
        }
      );
      return;
    }

    bridge.store.bindSession(key, id);
    const state = bridge.store.get(key);
    const title = await getSessionTitle(state.projectPath, id);
    const label = title ? `<b>${escHtml(title)}</b>` : `<code>${id.slice(0, 8)}…</code>`;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Продолжена ${label}\nСледующее сообщение продолжит эту сессию.`,
      { parse_mode: "HTML" }
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
    const label = title ? `<b>${escHtml(title)}</b>` : `<code>${id.slice(0, 8)}…</code>`;
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `Продолжена ${label} (забрана)\nСледующее сообщение продолжит эту сессию.`,
      { parse_mode: "HTML" }
    );
    if (ctx.chat) await bridge.syncTopicTitle(ctx.chat.id, routeOf(ctx));
  });

  // /resume <id> command — resume a specific session by id (full or 8-char prefix)
  bot.command("resume", async (ctx) => {
    const arg = (ctx.match || "").trim();
    if (!arg) {
      await replyRouted(
        ctx,
        "Использование: /resume <code>&lt;session-id&gt;</code> — или /sessions для выбора из списка.",
        { parse_mode: "HTML" }
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
        `Сессия <code>${escHtml(arg)}</code> не найдена. /sessions — список.`,
        { parse_mode: "HTML" }
      );
      return;
    }

    const other = bridge.store.findBySession(match.id, key);
    if (other) {
      const name = await topicLabelOf(other, match.id);
      await replyRouted(
        ctx,
        `Сессия уже открыта во вкладке «${escHtml(name)}» — продолжить там или забрать сюда:`,
        {
          parse_mode: "HTML",
          reply_markup: new InlineKeyboard().text(
            "Забрать сюда",
            `resume!:${match.id}`
          ),
        }
      );
      return;
    }

    bridge.store.bindSession(key, match.id);
    const label = match.title
      ? `<b>${escHtml(match.title)}</b>`
      : `<code>${match.id.slice(0, 8)}…</code>`;
    await replyRouted(ctx, `Продолжена ${label}. Следующее сообщение продолжит эту сессию.`, {
      parse_mode: "HTML",
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
        "Сессия не привязана. Отправьте сообщение или выберите через /sessions."
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
        await replyRouted(ctx, "Лог сессии пуст или не найден.");
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
      await replyRouted(ctx, "Лог сессии пуст или не найден.");
      return;
    }

    const title = await getSessionTitle(state.projectPath, state.sessionId);
    const header = `История ${title || state.sessionId.slice(0, 8)} — последние ${messages.length}:`;

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
        "Использование: /rename <code>&lt;новое имя&gt;</code> — переименовать сессию этой вкладки.",
        { parse_mode: "HTML" }
      );
      return;
    }

    const state = bridge.threadState(routeKey(routeOf(ctx)));
    if (!state.sessionId) {
      await replyRouted(
        ctx,
        "Сессия не привязана. Отправьте сообщение или выберите через /sessions."
      );
      return;
    }

    await setSessionTitle(state.projectPath, state.sessionId, name);
    await bridge.syncTopicTitle(ctx.chat.id, routeOf(ctx));
    await replyRouted(ctx, `Переименовано в «${escHtml(name)}».`, { parse_mode: "HTML" });
  });

  // /get <path> — send a file from the project (or an absolute path) to chat
  bot.command("get", async (ctx) => {
    const arg = (ctx.match || "").trim().replace(/^["']|["']$/g, "");
    if (!arg) {
      await replyRouted(
        ctx,
        "Использование: /get <code>&lt;путь&gt;</code> — файл из проекта (относительный) или абсолютный.",
        { parse_mode: "HTML" }
      );
      return;
    }

    const state = bridge.threadState(routeKey(routeOf(ctx)));
    const filePath = isAbsolute(arg) ? arg : join(state.projectPath, arg);
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      await replyRouted(
        ctx,
        `Файл не найден: <code>${escHtml(filePath)}</code>`,
        { parse_mode: "HTML" }
      );
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
    if (!rcEnabled) {
      await replyRouted(ctx, "🔇 Удалённое управление выключено. /rc — включить.");
      return;
    }
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
      await replyRouted(ctx, "Не удалось скачать файл.");
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
    if (!rcEnabled) {
      await replyRouted(ctx, "🔇 Удалённое управление выключено. /rc — включить.");
      return;
    }
    const photo = ctx.message.photo;
    if (!photo || photo.length === 0) return;

    // Get highest resolution photo
    const largest = photo[photo.length - 1];
    const file = await ctx.api.getFile(largest.file_id);

    if (!file.file_path) {
      await replyRouted(ctx, "Не удалось скачать изображение.");
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
    if (!rcEnabled) {
      await replyRouted(ctx, "🔇 Удалённое управление выключено. /rc — включить.");
      return;
    }
    await bridge.sendMessage(ctx.chat.id, text, extractRoute(ctx.message));
    await bridge.syncTopicTitle(ctx.chat.id, extractRoute(ctx.message));
  });

  // Command menu — sorted alphabetically for Telegram autocomplete.
  await bot.api.setMyCommands([
    { command: "fresh", description: "Следующее сообщение без истории (новая сессия)" },
    { command: "get", description: "Прислать файл из проекта" },
    { command: "help", description: "Справка по командам и вкладкам" },
    { command: "history", description: "Последние сообщения сессии (all — файлом)" },
    { command: "lock", description: "Заблокировать бота (если задан пароль)" },
    { command: "mode", description: "Режим: safe (с подтверждениями) | fast" },
    { command: "model", description: "Модель: fable, opus, sonnet, haiku" },
    { command: "new", description: "Свежая сессия в этой вкладке" },
    { command: "projects", description: "Список проектов" },
    { command: "rc", description: "Удалённое управление: on/off" },
    { command: "rename", description: "Переименовать сессию и вкладку" },
    { command: "restart", description: "Перезапустить бота" },
    { command: "resume", description: "Привязать сессию по id" },
    { command: "sessions", description: "Выбрать сессию для этой вкладки" },
    { command: "settings", description: "Панель настроек вкладки" },
    { command: "shutdown", description: "Выключить бота" },
    { command: "speed", description: "Скорость: fast, normal, deep" },
    { command: "status", description: "Проект и сессия этой вкладки" },
    { command: "stop", description: "Прервать текущую задачу" },
    { command: "switch", description: "Сменить проект вкладки" },
    { command: "unlock", description: "Разблокировать вкладку (пароль)" },
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
