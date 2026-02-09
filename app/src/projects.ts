import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

export interface ProjectInfo {
  name: string;
  path: string;
  encodedName: string;
  lastActivity: Date;
}

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

function decodePath(encoded: string): string {
  return encoded.replace(/-/g, "/");
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

    const decodedPath = decodePath(entry);
    const name = decodedPath.split("/").filter(Boolean).pop() || entry;

    // Find most recent .jsonl file for last activity
    let lastActivity = dirStat.mtime;
    try {
      const files = await readdir(projectDir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        const fileStat = await stat(join(projectDir, file)).catch(() => null);
        if (fileStat && fileStat.mtime > lastActivity) {
          lastActivity = fileStat.mtime;
        }
      }
    } catch {
      // ignore read errors
    }

    projects.push({
      name,
      path: decodedPath,
      encodedName: entry,
      lastActivity,
    });
  }

  projects.sort((a, b) => b.lastActivity.getTime() - a.lastActivity.getTime());
  return projects;
}

function encodePath(projectPath: string): string {
  return projectPath.replace(/\//g, "-");
}

export async function findLatestSessionId(projectPath: string): Promise<string | undefined> {
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
