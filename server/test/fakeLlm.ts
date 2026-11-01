import type { LlmClient, LlmRequest, LlmResult } from "../src/ai.js";

type Reply = Partial<LlmResult> | Error;

/** Records each request and answers with whatever the test queued (or `fallback`). */
export class FakeLlm implements LlmClient {
  readonly model = "claude-haiku-5-5";
  readonly requests: LlmRequest[] = [];
  private readonly queue: Reply[] = [];

  constructor(private readonly fallback: (request: LlmRequest) => Reply = () => ({ json: null })) {}

  reply(...replies: Reply[]): this {
    this.queue.push(...replies);
    return this;
  }

  async complete(request: LlmRequest): Promise<LlmResult> {
    this.requests.push(request);
    const reply = this.queue.shift() ?? this.fallback(request);
    if (reply instanceof Error) throw reply;
    return { json: null, stopReason: "end_turn", model: this.model, inputTokens: 1000, outputTokens: 50, ...reply };
  }

  /** The text of the last request's user message. */
  get lastContent(): string {
    const content = this.requests.at(-1)?.content;
    if (typeof content === "string") return content;
    return (content ?? []).map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
  }
}
