export interface QueryStats {
  costUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

interface ModelStats {
  queries: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

class UsageTracker {
  private startedAt = Date.now();
  private queries = 0;
  private totalCostUsd = 0;
  private totalDurationMs = 0;
  private totalDurationApiMs = 0;
  private totalTurns = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private totalCacheReadTokens = 0;
  private totalCacheCreationTokens = 0;
  private perModel = new Map<string, ModelStats>();

  record(stats: QueryStats, modelUsage?: Record<string, { costUSD: number; inputTokens: number; outputTokens: number }>): void {
    this.queries++;
    this.totalCostUsd += stats.costUsd;
    this.totalDurationMs += stats.durationMs;
    this.totalDurationApiMs += stats.durationApiMs;
    this.totalTurns += stats.numTurns;
    this.totalInputTokens += stats.inputTokens;
    this.totalOutputTokens += stats.outputTokens;
    this.totalCacheReadTokens += stats.cacheReadTokens;
    this.totalCacheCreationTokens += stats.cacheCreationTokens;

    if (modelUsage) {
      for (const [model, mu] of Object.entries(modelUsage)) {
        const existing = this.perModel.get(model) ?? { queries: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
        existing.queries++;
        existing.costUsd += mu.costUSD ?? 0;
        existing.inputTokens += mu.inputTokens ?? 0;
        existing.outputTokens += mu.outputTokens ?? 0;
        this.perModel.set(model, existing);
      }
    }
  }

  format(): string {
    const uptime = Date.now() - this.startedAt;
    const h = Math.floor(uptime / 3_600_000);
    const m = Math.floor((uptime % 3_600_000) / 60_000);

    const lines: string[] = [
      `<b>Статистика использования</b>`,
      ``,
      `⏱ Аптайм: ${h}ч ${m}м`,
      `📊 Запросов: <b>${this.queries}</b>`,
      `💰 Стоимость: <b>$${this.totalCostUsd.toFixed(4)}</b>`,
      `🔄 Ходов (turns): ${this.totalTurns}`,
      ``,
      `<b>Токены</b>`,
      `  Вход: ${fmtTokens(this.totalInputTokens)}`,
      `  Выход: ${fmtTokens(this.totalOutputTokens)}`,
      `  Кэш (чтение): ${fmtTokens(this.totalCacheReadTokens)}`,
      `  Кэш (запись): ${fmtTokens(this.totalCacheCreationTokens)}`,
      ``,
      `<b>Время</b>`,
      `  Стена: ${fmtDuration(this.totalDurationMs)}`,
      `  API: ${fmtDuration(this.totalDurationApiMs)}`,
    ];

    if (this.perModel.size > 0) {
      lines.push(``, `<b>По моделям</b>`);
      for (const [model, ms] of this.perModel) {
        const short = model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
        lines.push(`  ${short}: ${ms.queries}× $${ms.costUsd.toFixed(4)} (${fmtTokens(ms.inputTokens + ms.outputTokens)})`);
      }
    }

    return lines.join("\n");
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}м ${s % 60}с`;
  return `${Math.floor(m / 60)}ч ${m % 60}м`;
}

export const usage = new UsageTracker();
