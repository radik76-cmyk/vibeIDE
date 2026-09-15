import { readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { GrammyError, type Api, type RawApi } from "grammy";
import type { Message } from "grammy/types";

// ---------------------------------------------------------------------------
// Reply routing into chat topics
// ---------------------------------------------------------------------------

// Where in the chat a message lives: the plain chat view ("main") or a topic.
// Private-chat topics (Bot API 9.4+) and forum topics carry their ids in
// different fields, so both are kept.
export interface ThreadRoute {
  messageThreadId?: number;
  directMessagesTopicId?: number;
  // Incoming message id — replying to it inherits its topic, which is the
  // only outbound routing private-chat topics reliably accept (Bot API 10.x).
  replyToMessageId?: number;
}

export function extractRoute(msg: Message | undefined): ThreadRoute {
  if (!msg) return {};
  return {
    messageThreadId: msg.message_thread_id,
    directMessagesTopicId: msg.direct_messages_topic?.topic_id,
    replyToMessageId: msg.message_id,
  };
}

// Stable key for per-topic state.
export function routeKey(route: ThreadRoute): string {
  const id = route.directMessagesTopicId ?? route.messageThreadId;
  return id === undefined ? "main" : String(id);
}

type SendParams = {
  message_thread_id?: number;
  direct_messages_topic_id?: number;
  reply_parameters?: { message_id: number };
};

// How to address a topic on send. Verified live 2026-09-15 on a private
// bot chat: message_thread_id routes correctly; direct_messages_topic_id
// is ACCEPTED but lands in the chat root (it belongs to channel direct
// messages only — silent misroute, so it is never synthesized from a
// thread id); replying to a message of the topic inherits it. Kinds are
// probed in order and the working kind is cached per topic (parameters
// are rebuilt per send — reply targets change every message). "plain"
// delivers to the chat root rather than losing the reply; for a topic it
// is a last resort and never cached.
type SendKind = "thread" | "dm" | "reply" | "plain";

const KIND_ORDER: SendKind[] = ["thread", "dm", "reply", "plain"];
const workingKind = new Map<string, SendKind>();

function paramsFor(kind: SendKind, route: ThreadRoute): SendParams | undefined {
  const inTopic =
    route.directMessagesTopicId !== undefined ||
    route.messageThreadId !== undefined;
  switch (kind) {
    case "dm":
      return route.directMessagesTopicId !== undefined
        ? { direct_messages_topic_id: route.directMessagesTopicId }
        : undefined;
    case "thread":
      return route.messageThreadId !== undefined
        ? { message_thread_id: route.messageThreadId }
        : undefined;
    case "reply":
      // Only useful for topic routing; chat-root replies would just add noise.
      return inTopic && route.replyToMessageId !== undefined
        ? { reply_parameters: { message_id: route.replyToMessageId } }
        : undefined;
    case "plain":
      return {};
  }
}

function isTopicError(err: unknown): boolean {
  return err instanceof GrammyError && /thread|topic|repl/i.test(err.description);
}

export async function sendRouted(
  api: Api<RawApi>,
  chatId: number,
  text: string,
  route: ThreadRoute,
  extra?: Parameters<Api<RawApi>["sendMessage"]>[2]
): Promise<Message.TextMessage> {
  const key = routeKey(route);
  const cached = workingKind.get(key);
  const kinds = cached
    ? [cached, ...KIND_ORDER.filter((k) => k !== cached)]
    : KIND_ORDER;

  let lastErr: unknown;
  for (const kind of kinds) {
    const params = paramsFor(kind, route);
    if (params === undefined) continue;
    try {
      const msg = await api.sendMessage(chatId, text, { ...extra, ...params });
      if (kind !== "plain" || key === "main") {
        workingKind.set(key, kind);
      }
      return msg;
    } catch (err) {
      if (!isTopicError(err)) throw err;
      workingKind.delete(key);
      lastErr = err;
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Persistent per-topic state: which project and session a topic is bound to
// ---------------------------------------------------------------------------

export interface ThreadState {
  projectPath: string;
  sessionId?: string;
  // Last topic name set by the bot, to skip redundant renames.
  title?: string;
}

// app/src/topics.ts -> repo root
const STORE_FILE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "topics.json"
);

export class ThreadStore {
  private threads = new Map<string, ThreadState>();
  private defaultProjectPath: string;

  constructor(defaultProjectPath: string) {
    this.defaultProjectPath = defaultProjectPath;
    try {
      const raw = JSON.parse(readFileSync(STORE_FILE, "utf-8"));
      for (const [k, v] of Object.entries(raw)) {
        if (v && typeof (v as any).projectPath === "string") {
          this.threads.set(k, v as ThreadState);
        }
      }
    } catch {
      // no store yet — start empty
    }
  }

  // Unknown key = a topic seen for the first time: it gets the default
  // project and no session, i.e. the next message starts a fresh session.
  get(key: string): ThreadState {
    let state = this.threads.get(key);
    if (!state) {
      state = { projectPath: this.defaultProjectPath };
      this.threads.set(key, state);
    }
    return state;
  }

  setSession(key: string, sessionId: string | undefined): void {
    this.get(key).sessionId = sessionId;
    this.save();
  }

  setTitle(key: string, title: string): void {
    this.get(key).title = title;
    this.save();
  }

  // A topic (other than `exceptKey`) already holding this session —
  // one session lives in one tab.
  findBySession(
    sessionId: string,
    exceptKey: string
  ): { key: string; state: ThreadState } | undefined {
    for (const [k, v] of this.threads) {
      if (k !== exceptKey && k !== "main" && v.sessionId === sessionId) {
        return { key: k, state: v };
      }
    }
    return undefined;
  }

  // Bind a session to a topic; the legacy plain-view binding of the same
  // session is released so adoption cannot hand it out a second time.
  bindSession(key: string, sessionId: string): void {
    const main = this.threads.get("main");
    if (main?.sessionId === sessionId) main.sessionId = undefined;
    this.get(key).sessionId = sessionId;
    this.save();
  }

  // One-time takeover of the legacy plain-view binding: in topics mode
  // messages can no longer reach "main", so its ongoing conversation is
  // inherited by the first topic touched that has no session of its own.
  adoptMain(key: string): void {
    if (key === "main") return;
    const main = this.threads.get("main");
    if (!main?.sessionId) return;
    const state = this.get(key);
    if (state.sessionId) return;
    state.projectPath = main.projectPath;
    state.sessionId = main.sessionId;
    main.sessionId = undefined;
    this.save();
  }

  setProject(key: string, projectPath: string): void {
    const state = this.get(key);
    state.projectPath = projectPath;
    state.sessionId = undefined;
    this.save();
  }

  private save(): void {
    try {
      writeFileSync(
        STORE_FILE,
        JSON.stringify(Object.fromEntries(this.threads), null, 2),
        "utf-8"
      );
    } catch (e) {
      console.error("Failed to save topics.json:", e);
    }
  }
}
