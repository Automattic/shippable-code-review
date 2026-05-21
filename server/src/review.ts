import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getCredential } from "./auth/store.ts";
import { recordStat } from "./stats/record.ts";

const RequestSchema = z.object({
  // Pre-rendered prompt text. The frontend renders templates client-side;
  // the server receives the final user message and forwards it.
  text: z.string().min(1),
  system: z.string().optional(),
  max_tokens: z.number().int().positive().max(8192).optional(),
  model: z.string().optional(),
});

const DEFAULT_MODEL = process.env.CLAUDE_MODEL ?? "claude-sonnet-4-6";
const DEFAULT_MAX_TOKENS = 4096;

// Stable client-facing event contract. Decoupled from the Anthropic SDK's
// internal event types so we can evolve either side independently.
export type ClientEvent =
  | { type: "text"; text: string }
  | {
      type: "done";
      stop_reason?: string | null;
      usage?: { input_tokens: number; output_tokens: number };
    }
  | { type: "error"; error: string };

export async function streamReview(
  body: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  recordStat("ai-review-request");

  let parsed: z.infer<typeof RequestSchema>;
  try {
    parsed = RequestSchema.parse(JSON.parse(body));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `invalid body: ${message}` }));
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.writeHead(200);
  res.flushHeaders?.();

  const writeEvent = (event: ClientEvent) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  const controller = new AbortController();
  // Listen on res, not req: req's 'close' / `destroyed` flip true when the
  // request body is consumed, not when the client disconnects. The response
  // socket is the right signal — it stays open while we're streaming and
  // closes only when either side hangs up.
  const onClose = () => controller.abort();
  res.on("close", onClose);

  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | null | undefined;
  const started = Date.now();

  try {
    const apiKey = getCredential({ kind: "anthropic" });
    if (!apiKey) {
      // /api/review gates on hasCredential and returns 503 before reaching
      // streamReview, so this branch is the TOCTOU defense — the credential
      // was cleared between the gate and SDK construction. Throw rather
      // than let the SDK fall back to process.env.ANTHROPIC_API_KEY.
      throw new Error("anthropic_key_missing");
    }
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream(
      {
        model: parsed.model ?? DEFAULT_MODEL,
        max_tokens: parsed.max_tokens ?? DEFAULT_MAX_TOKENS,
        ...(parsed.system ? { system: parsed.system } : {}),
        messages: [{ role: "user", content: parsed.text }],
      },
      { signal: controller.signal },
    );

    for await (const event of stream) {
      if (res.writableEnded || res.destroyed) return;

      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        writeEvent({ type: "text", text: event.delta.text });
      } else if (event.type === "message_start") {
        inputTokens = event.message.usage.input_tokens;
        outputTokens = event.message.usage.output_tokens;
      } else if (event.type === "message_delta") {
        outputTokens = event.usage.output_tokens;
        stopReason = event.delta.stop_reason;
      }
    }

    writeEvent({
      type: "done",
      stop_reason: stopReason ?? null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
    recordStat("comment-posted-ai");
    const ms = Date.now() - started;
    console.log(
      `[server] /api/review ok in ${ms}ms in=${inputTokens} out=${outputTokens} stop=${stopReason ?? "?"}`,
    );
  } catch (err) {
    if (controller.signal.aborted) {
      console.log(`[server] /api/review aborted by client`);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[server] /api/review err:`, err);
    writeEvent({ type: "error", error: message });
  } finally {
    res.off("close", onClose);
    if (!res.writableEnded) res.end();
  }
}
