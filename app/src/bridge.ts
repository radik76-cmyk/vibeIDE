import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Api, RawApi } from "grammy";
import { Streamer } from "./streamer.js";
import { findLatestSessionId, getSessionTitle } from "./projects.js";
import {
  ThreadStore,
  routeKey,
  sendRouted,
  type ThreadRoute,
} from "./topics.js";

export class Bridge {
  store: ThreadStore;
  private busy = new Set<string>();
  private api: Api<RawApi>;

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

  async sendMessage(
    chatId: number,
    text: string,
    route: ThreadRoute = {},
    images?: { data: string; mediaType: string }[]
  ): Promise<void> {
    const key = routeKey(route);
    if (this.busy.has(key)) {
      await sendRouted(
        this.api,
        chatId,
        "Still thinking on your last message... please wait.",
        route
      );
      return;
    }

    this.busy.add(key);
    const state = this.threadState(key);
    const streamer = new Streamer(this.api, chatId, route);

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

      const conversation = query({
        prompt: promptInput,
        options: {
          cwd: state.projectPath,
          ...(state.sessionId ? { resume: state.sessionId } : {}),
          allowedTools: [
            "Read",
            "Edit",
            "Write",
            "Bash",
            "Glob",
            "Grep",
            "WebSearch",
            "WebFetch",
            "Task",
          ],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["project"],
        },
      });

      for await (const message of conversation) {
        // Capture session ID from any message
        if ("session_id" in message && message.session_id) {
          if (state.sessionId !== message.session_id) {
            this.store.setSession(key, message.session_id);
          }
        }

        if (message.type === "assistant" && message.message) {
          // Extract text from content blocks
          const content = message.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === "text" && block.text) {
                await streamer.append(block.text);
              }
            }
          }
        }

        if (message.type === "result") {
          if (message.is_error && "errors" in message) {
            const errors = (message as any).errors as string[];
            if (errors?.length) {
              await streamer.append(`\n\nError: ${errors.join("\n")}`);
            }
          }
        }
      }
    } catch (err: any) {
      await streamer.append(`\n\nBridge error: ${err.message || err}`);
    } finally {
      await streamer.finalize();
      this.busy.delete(key);
    }
  }
}
