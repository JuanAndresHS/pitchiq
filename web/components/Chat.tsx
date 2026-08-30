"use client";

import { useEffect, useRef, useState } from "react";

type Message = {
  role: "you" | "pitchiq";
  text: string;
  tools?: string[];
};

const SUGGESTIONS = [
  "Who is top of the table?",
  "How has Liverpool been playing?",
  "Compare Arsenal and Manchester City",
  "How accurate has the model been?",
];

export default function Chat() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interactionId, setInteractionId] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length > 0) {
      endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [messages, pending]);

  async function send(question: string) {
    const trimmed = question.trim();
    if (!trimmed || pending) return;

    setMessages((prev) => [...prev, { role: "you", text: trimmed }]);
    setInput("");
    setError(null);
    setPending(true);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          previousInteractionId: interactionId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error ?? "Something went wrong.");
        return;
      }

      setInteractionId(data.interactionId ?? null);
      setMessages((prev) => [
        ...prev,
        { role: "pitchiq", text: data.reply, tools: data.toolsUsed },
      ]);
    } catch {
      setError("Could not reach the assistant. Check your connection.");
    } finally {
      setPending(false);
    }
  }

  return (
    <section
      id="ask"
      className="border-outcome-draw bg-pitch-raised scroll-mt-8 rounded-xl border p-6 sm:p-7"
    >
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="font-display text-2xl leading-none sm:text-3xl">
          Ask the data anything
        </h2>
        <span className="text-outcome-draw text-xs">Live · grounded in the model</span>
      </div>

      <p className="text-pitch-dim mb-5 max-w-xl text-sm leading-relaxed">
        Answers come from querying the match database and the forecasting model
        directly. The assistant has no memory of football to fall back on, so it
        cannot make a figure up — if the data does not have it, it says so.
      </p>

      {messages.length === 0 && !pending && (
        <div className="mb-5 flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => send(suggestion)}
              className="border-pitch-line text-pitch-dim hover:border-outcome-draw hover:text-pitch-text cursor-pointer rounded-full border px-3.5 py-2 text-sm transition-colors"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {messages.length > 0 && (
        <div className="mb-5 space-y-5">
          {messages.map((message, i) => (
            <div key={i}>
              <p className="text-pitch-faint mb-1 text-xs">{message.role}</p>
              <p
                className={`leading-relaxed ${
                  message.role === "you"
                    ? "text-pitch-dim text-sm"
                    : "text-pitch-text text-base"
                }`}
              >
                {message.text}
              </p>
              {message.tools && message.tools.length > 0 && (
                <p className="text-pitch-faint mt-2 text-xs">
                  Queried: {[...new Set(message.tools)].join(", ")}
                </p>
              )}
            </div>
          ))}

          {pending && (
            <p className="text-pitch-faint text-sm">Querying the data…</p>
          )}

          <div ref={endRef} />
        </div>
      )}

      {error && (
        <p className="text-outcome-away mb-3 text-sm" role="alert">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <label htmlFor="chat-input" className="sr-only">
          Ask a question about the Premier League
        </label>
        <input
          id="chat-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") send(input);
          }}
          placeholder="How is Arsenal doing?"
          maxLength={500}
          disabled={pending}
          className="border-pitch-line placeholder:text-pitch-faint focus:border-outcome-draw min-w-0 flex-1 rounded-lg border bg-transparent px-4 py-3 text-base outline-none disabled:opacity-50"
        />
        <button
          onClick={() => send(input)}
          disabled={pending || !input.trim()}
          className="bg-outcome-draw text-ink-draw cursor-pointer rounded-lg px-6 py-3 font-medium disabled:cursor-not-allowed disabled:opacity-40"
        >
          Ask
        </button>
      </div>
    </section>
  );
}
