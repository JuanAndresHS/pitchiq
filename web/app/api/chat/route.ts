/**
 * Chat endpoint.
 *
 * Runs the Gemini tool-calling loop on the server, so the API key never reaches
 * the browser and the tools can read the CSVs from the filesystem.
 *
 * The Interactions API keeps conversation state server-side at Google, so the
 * client only has to send the previous interaction id rather than the whole
 * history.
 *
 * Note on limits: a single question costs several API requests — one to choose
 * a tool, one to read the result, more if it chains. On the free tier that adds
 * up fast, so the tool loop is kept short and quota errors are surfaced
 * honestly rather than as a generic failure.
 */

import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { TOOL_SCHEMAS, executeTool } from "@/lib/tools";
import { DEFAULT_LEAGUE, LEAGUES, resolveLeague } from "@/lib/leagues";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Hobby caps at 60s

const MODEL = process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite";

// Three rounds is enough for "compare two teams" (two parallel tool calls, then
// an answer). Allowing more mostly buys pathological chains that time out.
const MAX_TOOL_ROUNDS = 3;

function systemPrompt(leagueName: string | null): string {
  const context = leagueName
    ? `The user is currently viewing the ${leagueName}, so questions without a
named competition are about that one.`
    : `The user is on the index page and has not chosen a league, so ask which
one they mean when a question is ambiguous, or answer across several when that
is more useful.`;

  return `You are PitchIQ, an analytics assistant for European football.

You cover five leagues: ${LEAGUES.map((l) => l.name).join(", ")}. ${context}

You have tools that query a real match database and Dixon-Coles forecasting
models fit separately for each league. Use them.

Rules you follow strictly:

1. Never state a statistic, result, standing or prediction from memory. If you
   did not get it from a tool in this conversation, you do not know it. Call a
   tool or say you cannot answer.

2. Call every tool you need in one go rather than one at a time. Comparing two
   teams means requesting both forms together, not sequentially.

3. Answer as soon as you have enough. Do not keep querying for extra colour.

4. Report probabilities as probabilities. "Arsenal are 62% to win" is right;
   "Arsenal will win" is wrong. The models produce distributions, not certainties.

5. Ratings are only comparable within a league. Never claim one league's team is
   stronger than another's on the basis of ratings — there are no matches
   connecting them, so the comparison has no basis.

6. Be honest about what the models miss: injuries, suspensions, transfers,
   managerial changes and European fixture congestion are all invisible to them.
   Newly promoted teams have little data behind their ratings.

7. Write like a knowledgeable analyst talking to someone who follows football:
   direct, specific, no hedging filler. Lead with the answer, then the evidence.
   Two or three sentences is usually enough. Plain text only, no markdown.`;
}

type ChatRequest = {
  message?: unknown;
  league?: unknown;
  previousInteractionId?: unknown;
};

/** Pull a usable message out of whatever shape the SDK threw. */
function describeError(error: unknown): { status: number; message: string } {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status)
      : 0;

  if (status === 429) {
    return {
      status: 429,
      message:
        "The free tier's request limit was hit. Wait about a minute and ask again.",
    };
  }

  if (status === 403 || status === 401) {
    return {
      status: 503,
      message: "The assistant is not configured correctly. Check the API key.",
    };
  }

  return {
    status: 502,
    message: "The assistant is unavailable right now. Try again in a moment.",
  };
}

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

  // No league means the index page. Tools still need a starting point for team
  // lookups, so they fall back to the default while the prompt makes clear
  // nothing has been chosen.
  const league = resolveLeague(
    typeof body.league === "string" ? body.league : null,
  );
  const toolContext = (league ?? DEFAULT_LEAGUE).slug;

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
    : `${systemPrompt(league?.name ?? null)}\n\n---\n\nUser question: ${message}`;

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

        const output = await executeTool(name, args, toolContext);

        results.push({
          type: "function_result" as const,
          name,
          call_id: (call as { id: string }).id,
          result: [{ type: "text" as const, text: JSON.stringify(output) }],
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
        interaction.output_text ||
        "That took more steps than expected. Try asking something more specific.",
      interactionId: interaction.id,
      toolsUsed,
    });
  } catch (error) {
    console.error("[chat]", error);
    const { status, message: text } = describeError(error);
    return NextResponse.json({ error: text }, { status });
  }
}
