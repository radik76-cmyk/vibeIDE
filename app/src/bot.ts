import { Bot, InlineKeyboard, type Context } from "grammy";
import type { Config } from "./config.js";
import { Bridge } from "./bridge.js";
import {
  listProjects,
  formatRelativeTime,
  type ProjectInfo,
} from "./projects.js";

export async function createBot(config: Config, initialProjectPath?: string): Promise<Bot> {
  const bot = new Bot(config.telegramBotToken);
  const bridge = new Bridge(bot.api, initialProjectPath);

  // Auto-resume the latest session for this project
  const resumedId = await bridge.resumeLatestSession();
  if (resumedId) {
    console.log(`Resuming session: ${resumedId.slice(0, 8)}...`);
  }

  // Auth middleware — silently drop unauthorized users
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== config.allowedUserId) return;
    await next();
  });

  // /start command
  bot.command("start", async (ctx) => {
    await ctx.reply(
      `VibeIDE connected.\nProject: \`${bridge.projectPath}\`\n\nCommands:\n/projects — list projects\n/switch — change project\n/new — fresh session\n/status — current state`,
      { parse_mode: "Markdown" }
    );
  });

  // /status command
  bot.command("status", async (ctx) => {
    const sessionInfo = bridge.sessionId
      ? `\`${bridge.sessionId.slice(0, 8)}...\``
      : "none (will start on next message)";
    await ctx.reply(
      `Project: \`${bridge.projectPath}\`\nSession: ${sessionInfo}`,
      { parse_mode: "Markdown" }
    );
  });

  // /new command — fresh session, same project
  bot.command("new", async (ctx) => {
    bridge.clearSession();
    await ctx.reply("Session cleared. Next message starts a fresh conversation.");
  });

  // /projects command — list available projects
  bot.command("projects", async (ctx) => {
    const projects = await listProjects();
    if (projects.length === 0) {
      await ctx.reply("No projects found in ~/.claude/projects/");
      return;
    }

    const lines = projects.slice(0, 20).map(
      (p, i) => `${i + 1}. **${p.name}** (${formatRelativeTime(p.lastActivity)})\n   \`${p.path}\``
    );
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  });

  // /switch command — show project picker
  bot.command("switch", async (ctx) => {
    const projects = await listProjects();
    if (projects.length === 0) {
      await ctx.reply("No projects found in ~/.claude/projects/");
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

    await ctx.reply("Pick a project:", { reply_markup: keyboard });
  });

  // Handle inline keyboard callbacks for project switching
  bot.callbackQuery(/^switch:/, async (ctx) => {
    const projectPath = ctx.callbackQuery.data.slice("switch:".length);
    bridge.projectPath = projectPath;
    const resumedId = await bridge.resumeLatestSession();
    const name = projectPath.split("/").filter(Boolean).pop() || projectPath;
    await ctx.answerCallbackQuery();
    const sessionNote = resumedId
      ? `Resumed session \`${resumedId.slice(0, 8)}...\``
      : "Starting fresh session.";
    await ctx.editMessageText(`Switched to **${name}**\n\`${projectPath}\`\n\n${sessionNote}`, {
      parse_mode: "Markdown",
    });
  });

  // Handle photo messages (images)
  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo;
    if (!photo || photo.length === 0) return;

    // Get highest resolution photo
    const largest = photo[photo.length - 1];
    const file = await ctx.api.getFile(largest.file_id);

    if (!file.file_path) {
      await ctx.reply("Could not download image.");
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
    await bridge.sendMessage(ctx.chat.id, caption, [
      { data: base64, mediaType },
    ]);
  });

  // Handle text messages — forward to Claude
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text;
    if (!text || text.startsWith("/")) return; // Skip unhandled commands
    await bridge.sendMessage(ctx.chat.id, text);
  });

  return bot;
}
