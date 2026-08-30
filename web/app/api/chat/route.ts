/**
 * Chat endpoint.
 *
 * Runs the Gemini tool-calling loop on the server, so the API key never
 * reaches the browser and the tools can read the CSVs from the filesystem.
 *
 * The Interactions API keeps conversation state server-side at Google, so the
 * client only has to send the previous interaction id rather than the whole
 * history.
 */

import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { TOOL_SCHEMAS, executeTool } from "@/lib/tools";

export const runtime = "nodejs";
export const maxDuration = 30;

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash";
const MAX_TOOL_ROUNDS = 6;

const SYSTEM_PROMPT = `You are PitchIQ, an analytics assistant for the Premier League.

You have tools that query a real match database and a Dixon-Coles forecasting
model built on four seasons of data. Use them.

Rules you follow strictly:

1. Never state a statistic, result, standing or prediction from memory. If you
   did not get it from a tool in this conversation, you do not know it. Call a
   tool or say you cannot answer.

2. Prefer several tool calls over guessing. Comparing two teams usually means
   calling get_team_form twice, and often get_head_to_head as well.

3. Report probabilities as probabilities. "Arsenal are 62% to win" is right;
   "Arsenal will win" is wrong. The model produces distributions, not certainties.

4. Be honest about the model's limits when they matter. It knows goals, teams
   and dates. It does not know about injuries, suspensions, transfers,
   managerial changes or European fixture congestion. If a question depends on
   those, say so.

5. Newly promoted teams have little data behind their ratings. Flag that when
   their forecasts come up.

6. Write like a knowledgeable analyst talking to someone who follows football:
   direct, specific, no hedging filler. Lead with the answer, then the evidence.
   Two or three sentences is usually enough. Plain text only, no markdown.`;

type ChatRequest = {
  message?: unknown;
  previousInteractionId?: unknown;
};

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "The chat is not configured. GEMINI_API_KEY is missing." },
      { status: 503 },
    );
  }

  let body: ChatRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  const previousId =
    typeof body.previousInteractionId === "string"
      ? body.previousInteractionId
      : null;

  if (!message) {
    return NextResponse.json({ error: "Ask a question first." }, { status: 400 });
  }

  if (message.length > 500) {
    return NextResponse.json(
      { error: "That question is too long. Keep it under 500 characters." },
      { status: 400 },
    );
  }

  const client = new GoogleGenAI({ apiKey });

  // The system prompt only needs sending once; after that the interaction id
  // carries the context.
  const input = previousId
    ? message
    : `${SYSTEM_PROMPT}\n\n---\n\nUser question: ${message}`;

  try {
    let interaction = await client.interactions.create({
      model: MODEL,
      input,
      tools: TOOL_SCHEMAS,
      ...(previousId ? { previous_interaction_id: previousId } : {}),
    });

    const toolsUsed: string[] = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const calls = interaction.steps.filter(
        (step: { type: string }) => step.type === "function_call",
      );

      if (calls.length === 0) {
        return NextResponse.json({
          reply: interaction.output_text || "I could not produce an answer.",
          interactionId: interaction.id,
          toolsUsed,
        });
      }

      const results = [];

      for (const call of calls) {
        const rawArgs = (call as { arguments?: unknown }).arguments;
        const args =
          typeof rawArgs === "string"
            ? JSON.parse(rawArgs || "{}")
            : ((rawArgs ?? {}) as Record<string, unknown>);

        const name = (call as { name: string }).name;
        toolsUsed.push(name);

        const output = await executeTool(name, args);

        results.push({
          type: "function_result",
          name,
          call_id: (call as { id: string }).id,
          result: [{ type: "text", text: JSON.stringify(output) }],
        });
      }

      interaction = await client.interactions.create({
        model: MODEL,
        input: results,
        tools: TOOL_SCHEMAS,
        previous_interaction_id: interaction.id,
      });
    }

    return NextResponse.json({
      reply:
        "That took more steps than expected. Try asking something more specific.",
      interactionId: interaction.id,
      toolsUsed,
    });
  } catch (error) {
    console.error("[chat]", error);
    return NextResponse.json(
      { error: "The assistant is unavailable right now. Try again in a moment." },
      { status: 502 },
    );
  }
}
