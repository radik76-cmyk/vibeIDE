#!/usr/bin/env node
// Prints the .env line enabling the VibeIDE password gate.
// Usage: node tools/hash-password.mjs "your password"
// Tip: prefer Latin letters/digits/symbols — terminal codepages can mangle
// Cyrillic before it reaches this script.
import { createHash } from "crypto";

const password = process.argv.slice(2).join(" ");
if (!password) {
  console.error('Usage: node tools/hash-password.mjs "your password"');
  process.exit(1);
}
const hash = createHash("sha256").update(password, "utf-8").digest("hex");
console.log("VIBEIDE_PASSWORD_HASH=" + hash);
