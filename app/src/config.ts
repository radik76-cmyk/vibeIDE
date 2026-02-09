import "dotenv/config";

export interface Config {
  telegramBotToken: string;
  allowedUserId: number;
}

export function loadConfig(): Config {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN not set in .env");
  }

  const userIdStr = process.env.TELEGRAM_ALLOWED_USER_ID;
  if (!userIdStr) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID not set in .env");
  }
  const allowedUserId = parseInt(userIdStr, 10);
  if (isNaN(allowedUserId)) {
    throw new Error("TELEGRAM_ALLOWED_USER_ID must be a number");
  }

  return { telegramBotToken: token, allowedUserId };
}
