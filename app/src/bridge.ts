import { query, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { InlineKeyboard, type Api, type RawApi } from "grammy";
import { Streamer } from "./streamer.js";
import { findLatestSessionId, getSessionTitle } from "./projects.js";
import {
  ThreadStore,
  routeKey,
  sendRouted,
  type ThreadRoute,
} from "./topics.js";

interface PendingMessage {
  chatId: number;
  text: string;
  route: ThreadRoute;
  images?: { data: string; mediaType: string }[];
}

const QUEUE_LIMIT = 5;

// Safe mode: these run without confirmation (read-only or harmless)…
const SAFE_TOOLS = ["Read", "Grep", "Glob", "WebSearch", "WebFetch", "Task"];
// …while everything else (Bash, Write, Edit, …) asks with buttons.
const ALL_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Bash",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "Task",
];
const PERM_TIMEOUT_MS = 10 * 60_000; // unanswered confirmation = deny

// Compact one-line description of a tool call for the activity notice.
function toolLine(name: string, input: unknown): string {
  const i = input as Record<string, unknown> | undefined;
  const detail =
    typeof i?.command === "string"
      ? i.command
      : typeof i?.file_path === "string"
        ? i.file_path
        : typeof i?.pattern === "string"
          ? i.pattern
          : typeof i?.prompt === "string"
            ? i.prompt
            : typeof i?.url === "string"
              ? i.url
              : "";
  const d = String(detail).replace(/\s+/g, " ").slice(0, 60);
  return d ? `${name}: ${d}` : name;
}

// Fuller variant for confirmations: a 60-char cut could hide the dangerous
// tail of a command, so show up to 500 chars here.
function toolDetail(name: string, input: unknown): string {
  const i = input as Record<string, unknown> | undefined;
  const detail =
    typeof i?.command === "string"
      ? i.command
      : typeof i?.file_path === "string"
        ? i.file_path
        : typeof i?.url === "string"
          ? i.url
          : JSON.stringify(i ?? {});
  return `${name}: ${String(detail).slice(0, 500)}`;
}

export class Bridge {
  store: ThreadStore;
  private api: Api<RawApi>;
  private busy = new Set<string>();
  private queues = new Map<string, PendingMessage[]>();
  private active = new Map<string, { interrupt: () => Promise<void> }>();

  constructor(api: Api<RawApi>, projectPath?: string) {
    this.api = api;
    this.store = new ThreadStore(projectPath || process.cwd());
  }

  // Attach the latest session of the thread's project to that thread.
  async resumeLatest(key: string): Promise<string | undefined> {
    const state = this.store.get(key);
    const sessionId = await findLatestSessionId(state.projectPath);
    this.store.setSession(key, sessionId);
    return sessionId;
  }

  // Thread state with legacy-main adoption applied (see ThreadStore.adoptMain).
  threadState(key: string) {
    this.store.adoptMain(key);
    return this.store.get(key);
  }

  // Best-effort: name the topic after its session so tabs are recognizable.
  // Telegram auto-creates topics as "Новый чат"; once the session has a
  // title (custom or ai-generated), the tab takes it.
  async syncTopicTitle(chatId: number, route: ThreadRoute): Promise<void> {
    const key = routeKey(route);
    if (key === "main") return;
    const state = this.store.get(key);
    if (!state.sessionId) return;
    const title = await getSessionTitle(state.projectPath, state.sessionId);
    if (!title || title === state.title) return;
    const name = title.length > 128 ? title.slice(0, 127) + "…" : title;
    const ids = [
      ...new Set(
        [route.directMessagesTopicId, route.messageThreadId].filter(
          (v): v is number => v !== undefined
        )
      ),
    ];
    for (const id of ids) {
      try {
        await this.api.editForumTopic(chatId, id, { name });
        this.store.setTitle(key, title);
        return;
      } catch {
        // wrong id kind or no rights — try the other id, else give up
      }
    }
  }

  isBusy(key: string): boolean {
    return this.busy.has(key);
  }

  private pendingPerms = new Map<
    string,
    (v: "allow" | "deny" | "all") => void
  >();

  // Resolve a pending safe-mode confirmation; false when unknown/expired.
  resolvePermission(id: string, verdict: "allow" | "deny" | "all"): boolean {
    const resolve = this.pendingPerms.get(id);
    if (!resolve) return false;
    this.pendingPerms.delete(id);
    resolve(verdict);
    return true;
  }

  // Interrupt the thread's running query and drop its queue.
  async stop(key: string): Promise<"stopped" | "idle"> {
    const hadQueue = (this.queues.get(key)?.length ?? 0) > 0;
    this.queues.delete(key);
    const running = this.active.get(key);
    if (running) {
      try {
        await running.interrupt();
      } catch {
        // already finished
      }
      return "stopped";
    }
    return hadQueue ? "stopped" : "idle";
  }

  async sendMessage(
    chatId: number,
    text: string,
    route: ThreadRoute = {},
    images?: { data: string; mediaType: string }[]
  ): Promise<void> {
    const key = routeKey(route);

    // Busy: queue instead of dropping the message.
    if (this.busy.has(key)) {
      const q = this.queues.get(key) ?? [];
      if (q.length >= QUEUE_LIMIT) {
        await sendRouted(
          this.api,
          chatId,
          `Очередь полна (${QUEUE_LIMIT}). /stop — прервать текущую задачу.`,
          route
        );
        return;
      }
      q.push({ chatId, text, route, images });
      this.queues.set(key, q);
      await sendRouted(
        this.api,
        chatId,
        `⏳ В очереди: ${q.length}. Отправлю после текущего ответа; /stop — прервать и очистить.`,
        route
      );
      return;
    }

    this.busy.add(key);
    try {
      await this.process(key, { chatId, text, route, images });
      // Drain messages queued while we were busy (cleared by /stop).
      let next: PendingMessage | undefined;
      while ((next = this.queues.get(key)?.shift()) !== undefined) {
        await this.process(key, next);
      }
    } finally {
      this.busy.delete(key);
      this.queues.delete(key);
    }
  }

  private async process(key: string, msg: PendingMessage): Promise<void> {
    const { chatId, text, route, images } = msg;
    const state = this.threadState(key);
    const streamer = new Streamer(this.api, chatId, route);

    // "typing" while the agent works; one call shows the status for ~5s
    const typingExtra =
      route.messageThreadId !== undefined
        ? { message_thread_id: route.messageThreadId }
        : {};
    const sendTyping = () => {
      this.api.sendChatAction(chatId, "typing", typingExtra).catch(() => {});
    };
    sendTyping();
    const typingTimer = setInterval(sendTyping, 5000);

    // One editable activity notice showing the latest tool call; deleted
    // when the answer is done so only the answer remains in the chat.
    let toolMsgId: number | null = null;
    let toolCount = 0;
    let lastToolEdit = 0;
    const noteTool = async (line: string) => {
      toolCount++;
      const label = toolCount > 1 ? `⚙️ [${toolCount}] ${line}` : `⚙️ ${line}`;
      try {
        if (toolMsgId === null) {
          const m = await sendRouted(this.api, chatId, label, route);
          toolMsgId = m.message_id;
          lastToolEdit = Date.now();
        } else if (Date.now() - lastToolEdit > 1500) {
          await this.api.editMessageText(chatId, toolMsgId, label);
          lastToolEdit = Date.now();
        }
      } catch {
        // cosmetics only
      }
    };

    try {
      let promptInput: any;

      if (images && images.length > 0) {
        // Use content blocks for images
        const content: any[] = [];
        if (text) {
          content.push({ type: "text", text });
        }
        for (const img of images) {
          content.push({
            type: "image",
            source: {
              type: "base64",
              media_type: img.mediaType,
              data: img.data,
            },
          });
        }

        // For images, we need streaming input mode
        async function* generateMessages() {
          yield {
            type: "user" as const,
            message: {
              role: "user" as const,
              content,
            },
          };
        }
        promptInput = generateMessages();
      } else {
        promptInput = text;
      }

      // Safe mode: dangerous tools go through a button confirmation in chat.
      const run = { allowAll: false };
      const canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
        opts: { signal: AbortSignal }
      ): Promise<PermissionResult> => {
        if (run.allowAll || SAFE_TOOLS.includes(toolName)) {
          return { behavior: "allow", updatedInput: input };
        }
        const detail = toolDetail(toolName, input);
        const id = Math.random().toString(36).slice(2, 10);
        let permMsgId: number | null = null;
        try {
          const m = await sendRouted(
            this.api,
            chatId,
            `⚠️ Разрешить действие?\n${detail}`,
            route,
            {
              reply_markup: new InlineKeyboard()
                .text("✅ Да", `perm:${id}:allow`)
                .text("❌ Нет", `perm:${id}:deny`)
                .row()
                .text("✅ Всё до конца задачи", `perm:${id}:all`),
            }
          );
          permMsgId = m.message_id;
        } catch {
          return {
            behavior: "deny",
            message: "Не удалось запросить подтверждение у пользователя.",
          };
        }
        const verdict = await new Promise<"allow" | "deny" | "all">(
          (resolve) => {
            this.pendingPerms.set(id, resolve);
            const timer = setTimeout(() => {
              if (this.pendingPerms.delete(id)) resolve("deny");
            }, PERM_TIMEOUT_MS);
            opts.signal.addEventListener("abort", () => {
              clearTimeout(timer);
              if (this.pendingPerms.delete(id)) resolve("deny");
            });
          }
        );
        if (permMsgId !== null) {
          const status =
            verdict === "deny"
              ? "❌ Отклонено"
              : verdict === "all"
                ? "✅ Разрешено (и всё до конца задачи)"
                : "✅ Разрешено";
          this.api
            .editMessageText(chatId, permMsgId, `${status}\n${detail}`)
            .catch(() => {});
        }
        if (verdict === "all") run.allowAll = true;
        if (verdict === "deny") {
          return { behavior: "deny", message: "Пользователь отклонил действие." };
        }
        return { behavior: "allow", updatedInput: input };
      };

      const conversation = query({
        prompt: promptInput,
        options: {
          cwd: state.projectPath,
          ...(state.sessionId ? { resume: state.sessionId } : {}),
          ...(state.safeMode === true
            ? {
                allowedTools: SAFE_TOOLS,
                permissionMode: "default" as const,
                canUseTool,
              }
            : {
                allowedTools: ALL_TOOLS,
                permissionMode: "bypassPermissions" as const,
                allowDangerouslySkipPermissions: true,
              }),
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["project"],
        },
      });
      this.active.set(
        key,
        conversation as unknown as { interrupt: () => Promise<void> }
      );

      for await (const message of conversation) {
        // Capture session ID from any message
        if ("session_id" in message && message.session_id) {
          if (state.sessionId !== message.session_id) {
            this.store.setSession(key, message.session_id);
          }
        }

        if (message.type === "assistant" && message.message) {
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                await streamer.append(block.text);
              } else if (block.type === "tool_use") {
                const b = block as { name?: string; input?: unknown };
                await noteTool(toolLine(b.name ?? "tool", b.input));
              }
            }
          }
        }

        if (message.type === "result") {
          const duration = (message as { duration_ms?: number }).duration_ms;
          if (typeof duration === "number" && duration > 10_000) {
            const s = Math.round(duration / 1000);
            const t = s >= 60 ? `${Math.floor(s / 60)}м ${s % 60}с` : `${s}с`;
            await streamer.append(`\n\n⏱ ${t}`);
          }
          if (message.is_error && "errors" in message) {
            const errors = (message as any).errors as string[];
            if (errors?.length) {
              await streamer.append(`\n\nError: ${errors.join("\n")}`);
            }
          }
        }
      }
    } catch (err: any) {
      if (/abort|interrupt/i.test(String(err?.message ?? err))) {
        await streamer.append(`\n\n⏹ Прервано.`);
      } else {
        await streamer.append(`\n\nBridge error: ${err.message || err}`);
      }
    } finally {
      clearInterval(typingTimer);
      this.active.delete(key);
      if (toolMsgId !== null) {
        try {
          await this.api.deleteMessage(chatId, toolMsgId);
        } catch {
          // leave the notice if it cannot be removed
        }
      }
      await streamer.finalize();
    }
  }
}
