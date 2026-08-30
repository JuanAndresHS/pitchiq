"""
PitchIQ — Conversational agent (Gemini).

Wraps Gemini with the tools in tools.py so that football questions are answered
from the project's own data and models rather than from the model's memory.

The core idea: the model never states a fact it did not retrieve. It decides
which tool to call, the tool runs real code against real files, and the result
comes back for interpretation. That is what keeps a confidently-worded wrong
answer from reaching the user.

Note on the API: this uses the Interactions API, which keeps conversation state
server-side. Each turn passes `previous_interaction_id` instead of resending the
whole history, so the client stays thin.

Usage:
    python src/agent/gemini_agent.py                        # interactive
    python src/agent/gemini_agent.py "How is Arsenal doing?" # single question
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from google import genai

sys.path.insert(0, str(Path(__file__).resolve().parent))
from tools import TOOL_SCHEMAS, execute_tool  # noqa: E402

DEFAULT_MODEL = "gemini-3.5-flash"
MAX_TOOL_ROUNDS = 8  # guard against a runaway tool loop

SYSTEM_PROMPT = """You are PitchIQ, an analytics assistant for the Premier League.

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

4. Be honest about the model's limits when they matter. It knows goals, teams and
   dates. It does not know about injuries, suspensions, transfers, managerial
   changes or European fixture congestion. If a question depends on those, say so.

5. Newly promoted teams have little data behind their ratings. Flag that when
   their forecasts come up.

6. Write like a knowledgeable analyst talking to someone who follows football:
   direct, specific, no hedging filler. Lead with the answer, then the evidence.
   Keep it short unless depth was asked for.
"""


def _to_gemini_tools(schemas: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Translate the provider-neutral tool schemas into Gemini's format.

    tools.py declares tools once, in a shape close to JSON Schema. Each provider
    adapter renames the wrapper fields rather than duplicating the definitions,
    which is what keeps the agent layer swappable.
    """
    return [
        {
            "type": "function",
            "name": schema["name"],
            "description": schema["description"],
            "parameters": schema["input_schema"],
        }
        for schema in schemas
    ]


class PitchIQAgent:
    """A conversational agent grounded in the PitchIQ dataset."""

    def __init__(
        self,
        api_key: str | None = None,
        model: str | None = None,
        verbose: bool = True,
    ):
        load_dotenv()
        key = api_key or os.getenv("GEMINI_API_KEY")
        if not key:
            raise ValueError(
                "GEMINI_API_KEY not found. Get one free at "
                "https://aistudio.google.com/apikey and add it to your .env file."
            )

        self.client = genai.Client(api_key=key)
        self.model = model or os.getenv("GEMINI_MODEL", DEFAULT_MODEL)
        self.tools = _to_gemini_tools(TOOL_SCHEMAS)
        self.verbose = verbose
        self.last_interaction_id: str | None = None

    def _log(self, message: str) -> None:
        if self.verbose:
            print(f"  \033[90m{message}\033[0m")

    def _create(self, user_input: Any, previous_id: str | None = None):
        kwargs: dict[str, Any] = {
            "model": self.model,
            "input": user_input,
            "tools": self.tools,
        }
        if previous_id:
            kwargs["previous_interaction_id"] = previous_id
        return self.client.interactions.create(**kwargs)

    def ask(self, question: str) -> str:
        """Answer a question, running whatever tools are needed along the way."""
        # The system prompt only needs to be sent once: after that the server
        # holds the conversation and previous_interaction_id carries the context.
        if self.last_interaction_id is None:
            payload = f"{SYSTEM_PROMPT}\n\n---\n\nUser question: {question}"
        else:
            payload = question

        interaction = self._create(payload, self.last_interaction_id)

        for _ in range(MAX_TOOL_ROUNDS):
            calls = [s for s in interaction.steps if s.type == "function_call"]

            if not calls:
                self.last_interaction_id = interaction.id
                return interaction.output_text or "(no response)"

            # Run every tool the model asked for, then hand the results back.
            results = []
            for call in calls:
                arguments = call.arguments or {}
                if isinstance(arguments, str):
                    arguments = json.loads(arguments or "{}")

                self._log(f"→ {call.name}({json.dumps(arguments)})")
                output = execute_tool(call.name, arguments)

                if "error" in output:
                    self._log(f"  ! {str(output['error'])[:80]}")

                results.append({
                    "type": "function_result",
                    "name": call.name,
                    "call_id": call.id,
                    "result": [
                        {"type": "text", "text": json.dumps(output, default=str)}
                    ],
                })

            interaction = self._create(results, interaction.id)

        self.last_interaction_id = interaction.id
        return (
            "I hit the tool-call limit while working on that. "
            "Try asking something more specific."
        )

    def reset(self) -> None:
        """Start a fresh conversation."""
        self.last_interaction_id = None


# --- CLI ---------------------------------------------------------------------

BANNER = """
  ██████  PitchIQ
  Premier League analytics, grounded in real data.

  Try:  Who is top of the table?
        How has Liverpool been playing recently?
        What are the odds for the next Arsenal match?
        Compare Manchester City and Arsenal
        How accurate has the model been so far?

  Commands:  reset  ·  quit
"""


def main() -> int:
    try:
        agent = PitchIQAgent()
    except ValueError as exc:
        print(f"Error: {exc}")
        return 1

    # Single-question mode: python gemini_agent.py "your question"
    if len(sys.argv) > 1:
        print(agent.ask(" ".join(sys.argv[1:])))
        return 0

    print(BANNER)
    print(f"  model: {agent.model}")

    while True:
        try:
            question = input("\n\033[1myou ›\033[0m ").strip()
        except (EOFError, KeyboardInterrupt):
            print("\nBye.")
            return 0

        if not question:
            continue
        if question.lower() in {"quit", "exit", "q"}:
            print("Bye.")
            return 0
        if question.lower() == "reset":
            agent.reset()
            print("  Conversation cleared.")
            continue

        try:
            answer = agent.ask(question)
            print(f"\n\033[1mPitchIQ ›\033[0m {answer}")
        except Exception as exc:  # noqa: BLE001
            print(f"\n  Error: {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    sys.exit(main())
