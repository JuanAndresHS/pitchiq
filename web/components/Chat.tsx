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
    <div className="bg-pitch-raised rounded-lg p-5">
      <div className="mb-4">
        <h2 className="font-display text-xl leading-none">Ask the data</h2>
        <p className="text-pitch-faint mt-1.5 text-xs leading-relaxed">
          Questions are answered by querying the match database and the
          forecasting model directly, so the assistant cannot make figures up.
        </p>
      </div>

      {messages.length === 0 && !pending && (
        <div className="mb-4 flex flex-wrap gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => send(suggestion)}
              className="border-pitch-line text-pitch-dim hover:border-outcome-draw hover:text-pitch-text cursor-pointer rounded-full border px-3 py-1.5 text-xs transition-colors"
            >
              {suggestion}
            </button>
          ))}
        </div>
      )}

      {messages.length > 0 && (
        <div className="mb-4 space-y-4">
          {messages.map((message, i) => (
            <div key={i}>
              <p className="text-pitch-faint mb-1 text-xs">{message.role}</p>
              <p
                className={`text-sm leading-relaxed ${
                  message.role === "you" ? "text-pitch-dim" : "text-pitch-text"
                }`}
              >
                {message.text}
              </p>
              {message.tools && message.tools.length > 0 && (
                <p className="text-pitch-faint mt-1.5 text-xs">
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
          className="border-pitch-line placeholder:text-pitch-faint focus:border-outcome-draw min-w-0 flex-1 rounded border bg-transparent px-3 py-2 text-sm outline-none disabled:opacity-50"
        />
        <button
          onClick={() => send(input)}
          disabled={pending || !input.trim()}
          className="bg-outcome-draw text-ink-draw cursor-pointer rounded px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
        >
          Ask
        </button>
      </div>
    </div>
  );
}
