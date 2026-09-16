import type { Api, RawApi } from "grammy";
import { sendRouted, sendPhotoRouted, type ThreadRoute } from "./topics.js";
import { renderTablePng } from "./table-image.js";

const EDIT_INTERVAL_MS = 300;
const MAX_MESSAGE_LENGTH = 3800; // Leave room for formatting overhead under 4096 limit

// ---------------------------------------------------------------------------
// Markdown → Telegram HTML converter
// ---------------------------------------------------------------------------
// Telegram supports a limited subset of HTML: <b>, <i>, <code>, <pre>,
// <a href>, <s>, <u>, <blockquote>.  Markdown tables have no HTML equivalent
// that Telegram renders, so we convert them to pre-formatted text.

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Parse a Markdown table row into trimmed cell values. */
function parseTableRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Is this a table separator line like |---|---|? */
function isTableSeparator(line: string): boolean {
  return /^\|[\s:|-]+\|?\s*$/.test(line.trim());
}

type Segment = { kind: "html"; html: string } | { kind: "image"; png: Buffer };

const TABLE_IMAGE_PLACEHOLDER = "\x00TABLE_IMAGE\x00";


/** Convert Claude's Markdown output to mixed segments: HTML text + table images. */
function mdToSegments(md: string): Segment[] {
  const lines = md.split("\n");
  const out: string[] = [];
  const tableImages: Buffer[] = [];
  let inCode = false;
  let codeLang = "";
  let codeLines: string[] = [];
  let inTable = false;
  let tableHeaders: string[] = [];
  let tableRows: string[][] = [];

  const flushTable = () => {
    if (tableRows.length === 0 && tableHeaders.length === 0) {
      inTable = false;
      return;
    }
    try {
      const png = renderTablePng(tableHeaders, tableRows);
      tableImages.push(png);
      out.push(TABLE_IMAGE_PLACEHOLDER);
    } catch (err) {
      // Fallback to <pre> on render failure
      console.error("Table image render failed:", err);
      const pre = [tableHeaders.join(" | "), ...tableRows.map((r) => r.join(" | "))];
      out.push("<pre>" + pre.map(escHtml).join("\n") + "</pre>");
    }
    tableHeaders = [];
    tableRows = [];
    inTable = false;
  };

  for (const raw of lines) {
    if (/^```/.test(raw)) {
      if (inTable) flushTable();
      if (!inCode) {
        inCode = true;
        codeLang = raw.slice(3).trim();
        codeLines = [];
      } else {
        out.push("<pre>" + escHtml(codeLines.join("\n")) + "</pre>");
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(raw);
      continue;
    }

    const trimmed = raw.trim();
    if (trimmed.startsWith("|") || (inTable && trimmed.includes("|"))) {
      if (isTableSeparator(trimmed)) {
        inTable = true;
        continue;
      }
      const cells = parseTableRow(trimmed);
      if (!inTable) {
        inTable = true;
        tableHeaders = cells;
      } else if (tableHeaders.length === 0) {
        tableHeaders = cells;
      } else {
        tableRows.push(cells);
      }
      continue;
    }
    if (inTable) flushTable();

    const headingMatch = raw.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      out.push("<b>" + inlineFormat(headingMatch[2]) + "</b>");
      continue;
    }

    if (/^[-*_]{3,}\s*$/.test(raw)) {
      out.push("—");
      continue;
    }

    out.push(inlineFormat(raw));
  }

  if (inCode) {
    out.push("<pre>" + escHtml(codeLines.join("\n")) + "</pre>");
  }
  if (inTable) flushTable();

  // Split combined output by placeholder into segments
  const fullHtml = out.join("\n");
  const parts = fullHtml.split(TABLE_IMAGE_PLACEHOLDER);
  const segments: Segment[] = [];
  let imgIdx = 0;

  for (let i = 0; i < parts.length; i++) {
    const html = parts[i].trim();
    if (html) {
      segments.push({ kind: "html", html });
    }
    if (i < parts.length - 1 && imgIdx < tableImages.length) {
      segments.push({ kind: "image", png: tableImages[imgIdx++] });
    }
  }

  return segments;
}

/** Apply inline Markdown formatting to a single line. */
function inlineFormat(line: string): string {
  let s = escHtml(line);

  // Inline code (must be before bold/italic to avoid conflicts inside code)
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");

  // Bold + italic (***text*** or ___text___)
  s = s.replace(/\*{3}(.+?)\*{3}/g, "<b><i>$1</i></b>");

  // Bold (**text** or __text__)
  s = s.replace(/\*{2}(.+?)\*{2}/g, "<b>$1</b>");
  s = s.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic (*text* or _text_ — but not inside words with underscores)
  s = s.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, "<i>$1</i>");
  s = s.replace(/(?<!\w)_([^_]+)_(?!\w)/g, "<i>$1</i>");

  // Strikethrough ~~text~~
  s = s.replace(/~~(.+?)~~/g, "<s>$1</s>");

  // Links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  return s;
}

/** Check whether MD→HTML conversion produces meaningfully different output. */
function hasMarkdownFormatting(text: string): boolean {
  return /```|\*\*|__|~~|^#{1,6}\s|^\s*\|/m.test(text);
}

export class Streamer {
  private api: Api<RawApi>;
  private chatId: number;
  private route: ThreadRoute;
  private text = "";
  private fullText = ""; // Complete accumulated text across all chunks (for HTML conversion)
  private messageId: number | null = null;
  private lastEditTime = 0;
  private editTimer: ReturnType<typeof setTimeout> | null = null;
  private finalized = false;
  private sentMessages: number[] = [];

  constructor(api: Api<RawApi>, chatId: number, route: ThreadRoute = {}) {
    this.api = api;
    this.chatId = chatId;
    this.route = route;
  }

  async append(delta: string): Promise<void> {
    if (this.finalized) return;
    this.text += delta;
    this.fullText += delta;

    // If accumulated text exceeds max, split into a new message
    if (this.text.length > MAX_MESSAGE_LENGTH && this.messageId) {
      await this.flushEdit();
      this.sentMessages.push(this.messageId);
      this.messageId = null;
      this.text = delta; // Start fresh with overflow (plain-text chunk)
    }

    if (!this.messageId) {
      await this.sendPlain(this.text || "...");
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

    if (!this.fullText) return;

    // Upgrade the final message(s) to HTML if there is Markdown formatting.
    // Earlier streamed messages are also upgraded.
    if (hasMarkdownFormatting(this.fullText) || this.sentMessages.length > 0) {
      await this.replaceWithFormatted();
    } else if (!this.messageId) {
      // Never sent anything yet — send now.
      await this.sendPlain(this.text);
    } else {
      // Plain text, already up-to-date — just ensure the last edit lands.
      await this.flushEdit();
    }
  }

  /** Send a plain-text message (no parse_mode). */
  private async sendPlain(content: string): Promise<void> {
    try {
      const msg = await sendRouted(this.api, this.chatId, content, this.route);
      this.messageId = msg.message_id;
      this.lastEditTime = Date.now();
    } catch (e) {
      console.error("Failed to send message:", e);
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

  /** Edit the current streaming message with the latest plain text. */
  private async flushEdit(): Promise<void> {
    if (!this.messageId || !this.text) return;

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

  /**
   * Replace the streamed plain-text messages with formatted ones:
   * HTML text segments + PNG images for tables.
   */
  private async replaceWithFormatted(): Promise<void> {
    const toDelete = [...this.sentMessages];
    if (this.messageId) toDelete.push(this.messageId);

    for (const id of toDelete) {
      try {
        await this.api.deleteMessage(this.chatId, id);
      } catch {
        // already gone or no rights
      }
    }
    this.sentMessages = [];
    this.messageId = null;

    const segments = mdToSegments(this.fullText);

    for (const seg of segments) {
      if (seg.kind === "image") {
        try {
          await sendPhotoRouted(this.api, this.chatId, seg.png, this.route);
        } catch (err) {
          console.error("Table image send failed:", err);
        }
        continue;
      }

      const chunks = splitChunks(seg.html, MAX_MESSAGE_LENGTH);
      for (const chunk of chunks) {
        try {
          const msg = await sendRouted(
            this.api,
            this.chatId,
            chunk,
            this.route,
            { parse_mode: "HTML" }
          );
          this.messageId = msg.message_id;
        } catch (htmlErr) {
          console.error("HTML send failed, falling back to plain:", htmlErr);
          try {
            const msg = await sendRouted(
              this.api,
              this.chatId,
              chunk.replace(/<[^>]+>/g, ""),
              this.route
            );
            this.messageId = msg.message_id;
          } catch (e) {
            console.error("Failed to send message:", e);
          }
        }
      }
    }
  }
}

/** Split text into chunks, trying to break at newlines. */
function splitChunks(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Find a newline near the limit to break cleanly
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt < maxLen * 0.5) breakAt = maxLen; // no good break — hard cut
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt).replace(/^\n/, "");
  }
  return chunks;
}
