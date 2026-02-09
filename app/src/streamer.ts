import type { Api, RawApi } from "grammy";

const EDIT_INTERVAL_MS = 300;
const MAX_MESSAGE_LENGTH = 3800; // Leave room for formatting overhead under 4096 limit

export class Streamer {
  private api: Api<RawApi>;
  private chatId: number;
  private text = "";
  private messageId: number | null = null;
  private lastEditTime = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;
  private sentMessages: number[] = [];

  constructor(api: Api<RawApi>, chatId: number) {
    this.api = api;
    this.chatId = chatId;
  }

  async append(delta: string): Promise<void> {
    if (this.finalized) return;
    this.text += delta;

    // If accumulated text exceeds max, split into a new message
    if (this.text.length > MAX_MESSAGE_LENGTH && this.messageId) {
      await this.flushEdit();
      this.sentMessages.push(this.messageId);
      this.messageId = null;
      this.text = delta; // Start fresh with overflow
    }

    if (!this.messageId) {
      await this.sendInitial();
    } else {
      this.scheduleEdit();
    }
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    if (this.editTimer) {
      clearTimeout(this.editTimer);
      this.editTimer = null;
    }

    if (!this.messageId && this.text) {
      await this.sendInitial();
    } else if (this.messageId) {
      await this.flushEdit();
    }
  }

  private async sendInitial(): Promise<void> {
    const content = this.text || "...";
    try {
      const msg = await this.api.sendMessage(
        this.chatId,
        content,
        { parse_mode: "Markdown" }
      );
      this.messageId = msg.message_id;
      this.lastEditTime = Date.now();
    } catch {
      // Markdown failed, try plain text
      try {
        const msg = await this.api.sendMessage(this.chatId, content);
        this.messageId = msg.message_id;
        this.lastEditTime = Date.now();
      } catch (e) {
        console.error("Failed to send message:", e);
      }
    }
  }

  private scheduleEdit(): void {
    if (this.editTimer) return;

    const elapsed = Date.now() - this.lastEditTime;
    const delay = Math.max(0, EDIT_INTERVAL_MS - elapsed);

    this.editTimer = setTimeout(async () => {
      this.editTimer = null;
      await this.flushEdit();
    }, delay);
  }

  private async flushEdit(): Promise<void> {
    if (!this.messageId || !this.text) return;

    try {
      await this.api.editMessageText(this.chatId, this.messageId, this.text, {
        parse_mode: "Markdown",
      });
      this.lastEditTime = Date.now();
    } catch {
      // Markdown parse error — try plain text
      try {
        await this.api.editMessageText(
          this.chatId,
          this.messageId,
          this.text
        );
        this.lastEditTime = Date.now();
      } catch {
        // Message unchanged or other error — ignore
      }
    }
  }
}
