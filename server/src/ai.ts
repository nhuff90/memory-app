import Anthropic from "@anthropic-ai/sdk";
import type { UsageSummary } from "../../shared/types.js";
import type { DB } from "./db.js";
import { HttpError } from "./errors.js";

export type AiKind = "ask" | "enrich" | "caption";

export type LlmPart = { type: "text"; text: string } | { type: "image"; jpegBase64: string };

export interface LlmRequest {
  system: string;
  content: string | LlmPart[];
  /** JSON Schema the reply must follow. */
  schema: Record<string, unknown>;
  maxTokens: number;
}

export interface LlmResult {
  /** The parsed JSON reply, or null if the reply was cut off, refused, or not valid JSON. */
  json: unknown;
  stopReason: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** The one thing Recall needs from a language model, so tests can supply a fake. */
export interface LlmClient {
  readonly model: string;
  complete(request: LlmRequest): Promise<LlmResult>;
}

export class AnthropicLlm implements LlmClient {
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
  ) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    const content =
      typeof request.content === "string"
        ? request.content
        : request.content.map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : { type: "image" as const, source: { type: "base64" as const, media_type: "image/jpeg" as const, data: part.jpegBase64 } },
          );
    const message = await this.client.messages.create({
      model: this.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: [{ role: "user", content }],
      output_config: { effort: "low", format: { type: "json_schema", schema: request.schema } },
    });
    const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
    let json: unknown = null;
    if (message.stop_reason !== "refusal") {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    const usage = message.usage;
    return {
      json,
      stopReason: message.stop_reason,
      model: message.model,
      inputTokens: usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
      outputTokens: usage.output_tokens,
    };
  }
}

/** Turns SDK failures into messages that make sense on a phone screen. */
export function aiFailure(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new HttpError(502, "ai_key_rejected", "Claude rejected the API key. Check ANTHROPIC_API_KEY.");
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new HttpError(429, "ai_busy", "Claude is busy right now. Try again in a minute.");
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new HttpError(502, "ai_unreachable", "Couldn't reach Claude. Try again in a moment.");
  }
  return new HttpError(502, "ai_failed", "Claude couldn't answer this time. Try again in a moment.");
}

/** Estimated list prices in USD per million tokens. Unknown models show token counts without a cost. */
const PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

function priceFor(model: string): { input: number; output: number } | null {
  const key = Object.keys(PRICES).find((name) => model === name || model.startsWith(`${name}-`));
  return key ? PRICES[key]! : null;
}

function monthStart(now: number, timeZone: string): { label: string; start: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, Number(part.value)]),
  ) as Record<string, number>;
  const localNowAsUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  const offset = localNowAsUtc - Math.floor(now / 1000) * 1000;
  return {
    label: `${parts.year}-${String(parts.month).padStart(2, "0")}`,
    start: Date.UTC(parts.year!, parts.month! - 1, 1) - offset,
  };
}

/** Records every Claude call so Settings can show what this month cost. */
export class UsageLog {
  constructor(
    private readonly db: DB,
    private readonly now: () => number = Date.now,
  ) {}

  record(kind: AiKind, result: Pick<LlmResult, "model" | "inputTokens" | "outputTokens">): void {
    this.db
      .prepare(`INSERT INTO ai_usage (at, kind, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)`)
      .run(this.now(), kind, result.model, result.inputTokens, result.outputTokens);
  }

  summary(timeZone: string): UsageSummary {
    const { label, start } = monthStart(this.now(), timeZone);
    const rows = this.db
      .prepare(
        `SELECT kind, model, count(*) AS calls, sum(input_tokens) AS input, sum(output_tokens) AS output
         FROM ai_usage WHERE at >= ? GROUP BY kind, model`,
      )
      .all(start) as { kind: AiKind; model: string; calls: number; input: number; output: number }[];
    const summary: UsageSummary = {
      month: label,
      asks: 0,
      enrichments: 0,
      captions: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    };
    for (const row of rows) {
      if (row.kind === "ask") summary.asks += row.calls;
      else if (row.kind === "enrich") summary.enrichments += row.calls;
      else summary.captions += row.calls;
      summary.inputTokens += row.input;
      summary.outputTokens += row.output;
      const price = priceFor(row.model);
      summary.estimatedCostUsd =
        price && summary.estimatedCostUsd !== null
          ? summary.estimatedCostUsd + (row.input * price.input + row.output * price.output) / 1_000_000
          : null;
    }
    return summary;
  }
}
