import { readdir, stat, readFile, writeFile, mkdir } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface ProjectInfo {
  name: string;
  path: string;
  encodedName: string;
  lastActivity: Date;
}

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

// Claude Code names each project folder by taking the project's cwd and
// replacing every character that is not a letter or digit with "-".
// On Windows that collapses ":", "\", "/", "!" and "_" all into "-", so the
// original path CANNOT be reconstructed from the folder name alone (lossy).
// Therefore the real path is read back from the "cwd" field stored inside the
// session .jsonl records; encoding (path -> folder) stays deterministic and is
// used to locate a project's folder from a known path.
function encodePath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, "-");
}

// Last path segment of a Windows or POSIX path, for display.
function baseName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() || p;
}

// Read the real cwd from the newest session files of a project folder.
// Scans newest-first, line-by-line, stopping at the first record that carries
// a non-empty "cwd". Returns undefined when no session records a cwd.
async function readProjectCwd(
  projectDir: string,
  jsonlNewestFirst: string[]
): Promise<string | undefined> {
  for (const file of jsonlNewestFirst) {
    let content: string;
    try {
      content = await readFile(join(projectDir, file), "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (!line || !line.includes('"cwd"')) continue; // cheap prefilter
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.cwd === "string" && rec.cwd) return rec.cwd;
      } catch {
        // skip malformed line
      }
    }
  }
  return undefined;
}

export async function listProjects(): Promise<ProjectInfo[]> {
  let entries: string[];
  try {
    entries = await readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  const projects: ProjectInfo[] = [];

  for (const entry of entries) {
    const projectDir = join(PROJECTS_DIR, entry);
    const dirStat = await stat(projectDir).catch(() => null);
    if (!dirStat?.isDirectory()) continue;

    // Collect .jsonl files with their mtimes to get both the newest-first order
    // (for cwd lookup) and the last-activity timestamp in one pass.
    let jsonl: { file: string; mtime: number }[] = [];
    try {
      const files = await readdir(projectDir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const fileStat = await stat(join(projectDir, file)).catch(() => null);
        if (fileStat) jsonl.push({ file, mtime: fileStat.mtimeMs });
      }
    } catch {
      // ignore read errors
    }
    jsonl.sort((a, b) => b.mtime - a.mtime);

    const lastActivity =
      jsonl.length > 0 ? new Date(jsonl[0].mtime) : dirStat.mtime;

    const cwd = await readProjectCwd(
      projectDir,
      jsonl.map((j) => j.file)
    );
    // Fall back to the folder name when no session recorded a cwd (the folder
    // name is lossy but better than nothing for display).
    const path = cwd || entry;
    const name = baseName(path);

    projects.push({ name, path, encodedName: entry, lastActivity });
  }

  projects.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  return projects;
}

export async function findLatestSessionId(
  projectPath: string
): Promise<string | undefined> {
  const encoded = encodePath(projectPath);
  const projectDir = join(PROJECTS_DIR, encoded);

  let files: string[];
  try {
    files = await readdir(projectDir);
  } catch {
    return undefined;
  }

  let latestFile: string | undefined;
  let latestMtime = 0;

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const fileStat = await stat(join(projectDir, file)).catch(() => null);
    if (fileStat && fileStat.mtimeMs > latestMtime) {
      latestMtime = fileStat.mtimeMs;
      latestFile = file;
    }
  }

  if (!latestFile) return undefined;
  return latestFile.replace(".jsonl", "");
}

export interface SessionInfo {
  id: string;
  title?: string;
  lastActivity: Date;
}

// Human-readable name for a session, best-effort:
//   1) the user-set title in <projectDir>/<id>/custom-title.json,
//   2) the auto-generated "aiTitle" from the session .jsonl (last occurrence),
//   otherwise undefined (caller falls back to the short id).
async function resolveSessionTitle(
  projectDir: string,
  id: string
): Promise<string | undefined> {
  try {
    const raw = await readFile(
      join(projectDir, id, "custom-title.json"),
      "utf-8"
    );
    const t = JSON.parse(raw)?.customTitle;
    if (typeof t === "string" && t.trim()) return t.trim();
  } catch {
    // no custom title
  }
  try {
    const content = await readFile(join(projectDir, `${id}.jsonl`), "utf-8");
    let ai: string | undefined;
    for (const line of content.split("\n")) {
      if (!line.includes('"aiTitle"')) continue; // cheap prefilter
      try {
        const rec = JSON.parse(line);
        if (rec && typeof rec.aiTitle === "string" && rec.aiTitle.trim()) {
          ai = rec.aiTitle.trim(); // keep the latest one
        }
      } catch {
        // skip malformed line
      }
    }
    if (ai) return ai;
  } catch {
    // no session log
  }
  return undefined;
}

// Set the user-visible session title — the same custom-title.json the
// Claude Code terminal maintains, so the name shows up in both places.
export async function setSessionTitle(
  projectPath: string,
  id: string,
  title: string
): Promise<void> {
  const dir = join(PROJECTS_DIR, encodePath(projectPath), id);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "custom-title.json");
  let data: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8"));
    if (parsed && typeof parsed === "object") data = parsed;
  } catch {
    // no file yet or malformed — start clean
  }
  data.customTitle = title;
  await writeFile(file, JSON.stringify(data), "utf-8");
}

// Title for a single known session id (used by /status, /resume).
export async function getSessionTitle(
  projectPath: string,
  id: string
): Promise<string | undefined> {
  const projectDir = join(PROJECTS_DIR, encodePath(projectPath));
  return resolveSessionTitle(projectDir, id);
}

// List all sessions of a project (newest first) with names, for /sessions and /resume.
export async function listSessions(projectPath: string): Promise<SessionInfo[]> {
  const encoded = encodePath(projectPath);
  const projectDir = join(PROJECTS_DIR, encoded);

  let files: string[];
  try {
    files = await readdir(projectDir);
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const fileStat = await stat(join(projectDir, file)).catch(() => null);
    if (!fileStat) continue;
    const id = file.replace(".jsonl", "");
    const title = await resolveSessionTitle(projectDir, id);
    sessions.push({ id, title, lastActivity: new Date(fileStat.mtimeMs) });
  }

  sessions.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  return sessions;
}

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
}

// Last text messages of a session's main conversation: user and assistant
// records with visible text. Skips tool results (no text blocks), meta
// records, subagent sidechains and injected <system-reminder> blocks.
// Returns up to `limit` messages, oldest first.
export async function readSessionMessages(
  projectPath: string,
  id: string,
  limit: number
): Promise<SessionMessage[]> {
  const projectDir = join(PROJECTS_DIR, encodePath(projectPath));
  let content: string;
  try {
    content = await readFile(join(projectDir, `${id}.jsonl`), "utf-8");
  } catch {
    return [];
  }

  const messages: SessionMessage[] = [];
  for (const line of content.split("\n")) {
    if (!line) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // skip malformed line
    }
    if (rec?.type !== "user" && rec?.type !== "assistant") continue;
    if (rec.isMeta || rec.isSidechain) continue;
    const msgContent = rec.message?.content;
    let text = "";
    if (typeof msgContent === "string") {
      text = msgContent;
    } else if (Array.isArray(msgContent)) {
      const parts: string[] = [];
      for (const block of msgContent) {
        if (block?.type !== "text" || !block.text) continue;
        if (block.text.startsWith("<system-reminder>")) continue;
        parts.push(block.text);
      }
      text = parts.join("\n");
    }
    text = text.trim();
    if (!text) continue;
    messages.push({ role: rec.type, text });
  }
  return messages.slice(-limit);
}

export function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  const hours = Math.floor(diff / 3_600_000);
  const days = Math.floor(diff / 86_400_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}
