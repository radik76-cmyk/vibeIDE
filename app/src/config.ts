import "dotenv/config";

export interface Config {
  telegramBotToken: string;
  allowedUserId: number;
  /** sha256 hex of the access password; unset = password gate disabled */
  passwordHash?: string;
  /** auto-lock after this many minutes of inactivity (default 60) */
  autolockMinutes: number;
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

  const passwordHash =
    process.env.VIBEIDE_PASSWORD_HASH?.trim().toLowerCase() || undefined;
  const autolockMinutes =
    parseInt(process.env.VIBEIDE_AUTOLOCK_MIN || "", 10) || 60;

  return { telegramBotToken: token, allowedUserId, passwordHash, autolockMinutes };
}
