"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Msg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Live progress lines while a render is running. */
  steps?: string[];
  videoUrl?: string;
  credits?: string[];
  notes?: string[];
  pending?: boolean;
  failed?: boolean;
};

const SUGGESTIONS = [
  "hi",
  "what can you do?",
  "I'm building CalAI, a calorie-tracking app. Here's the site: calai.app",
];

let seq = 0;
const nextId = () => `m${++seq}`;

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([
    {
      id: nextId(),
      role: "assistant",
      text:
        "Tell me what you're building and include the link — I'll read the site and put together a short vertical ad for it.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // A stream left open across a navigation keeps the connection alive forever.
  useEffect(() => () => esRef.current?.close(), []);

  const patch = useCallback((id: string, changes: Partial<Msg>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...changes } : m)));
  }, []);

  const watch = useCallback(
    (jobId: string, msgId: string) => {
      esRef.current?.close();
      const es = new EventSource(`/api/generate?id=${encodeURIComponent(jobId)}`);
      esRef.current = es;

      es.addEventListener("progress", (e) => {
        const p = JSON.parse((e as MessageEvent).data) as { detail: string };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? { ...m, steps: [...(m.steps ?? []).filter((s) => s !== p.detail), p.detail] }
              : m
          )
        );
      });

      es.addEventListener("done", (e) => {
        const d = JSON.parse((e as MessageEvent).data) as {
          videoUrl: string;
          credits: string[];
          notes: string[];
        };
        patch(msgId, {
          pending: false,
          videoUrl: d.videoUrl,
          credits: d.credits,
          notes: d.notes,
          text: "Here it is.",
        });
        setBusy(false);
        es.close();
      });

      es.addEventListener("error", (e) => {
        // Distinguish a server-sent error event from a transport drop.
        const raw = (e as MessageEvent).data;
        const message = raw
          ? (JSON.parse(raw) as { message: string }).message
          : "Lost the connection while rendering. Try again?";
        patch(msgId, { pending: false, failed: true, text: message });
        setBusy(false);
        es.close();
      });
    },
    [patch]
  );

  const send = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || busy) return;

      setInput("");
      setBusy(true);
      setMessages((prev) => [...prev, { id: nextId(), role: "user", text }]);

      const placeholderId = nextId();
      setMessages((prev) => [
        ...prev,
        { id: placeholderId, role: "assistant", text: "…", pending: true },
      ]);

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: text }),
        });
        const data = (await res.json()) as {
          action?: string;
          reply?: string;
          jobId?: string;
          error?: string;
        };

        if (data.error) {
          patch(placeholderId, { pending: false, failed: true, text: data.error });
          setBusy(false);
          return;
        }

        patch(placeholderId, {
          text: data.reply ?? "…",
          pending: data.action === "generate",
        });

        if (data.action === "generate" && data.jobId) watch(data.jobId, placeholderId);
        else setBusy(false);
      } catch {
        patch(placeholderId, {
          pending: false,
          failed: true,
          text: "Couldn't reach the server. Check your connection and try again.",
        });
        setBusy(false);
      }
    },
    [busy, patch, watch]
  );

  return (
    <main>
      <header>
        <h1>UGC Video Generator</h1>
        <p>
          Real stock footage, a transparent sticker and a music bed, composited with ffmpeg.{" "}
          <strong>No AI-generated frames.</strong>
        </p>
      </header>

      <div className="scroll" ref={scrollRef}>
        <div className="thread">
          {messages.map((m) => (
            <div key={m.id} className={`row ${m.role}`}>
              <div className={`bubble ${m.failed ? "failed" : ""}`}>
                <div className="text">{m.text}</div>

                {m.steps && m.steps.length > 0 && !m.videoUrl && (
                  <ul className="steps">
                    {m.steps.map((s, i) => (
                      <li key={s} className={i === m.steps!.length - 1 ? "active" : ""}>
                        {s}
                      </li>
                    ))}
                  </ul>
                )}

                {m.pending && !m.steps?.length && <span className="dots" aria-label="working" />}

                {m.videoUrl && (
                  <div className="result">
                    <video src={m.videoUrl} controls playsInline preload="metadata" />
                    <div className="links">
                      <a href={m.videoUrl} target="_blank" rel="noreferrer">
                        Open video
                      </a>
                      <span className="sep">·</span>
                      <span className="muted">expires when the server restarts</span>
                    </div>
                    {m.credits && m.credits.length > 0 && (
                      <details>
                        <summary>Credits &amp; how it was made</summary>
                        <ul>
                          {m.credits.map((c) => (
                            <li key={c}>{c}</li>
                          ))}
                          {m.notes?.map((n) => (
                            <li key={n} className="muted">
                              {n}
                            </li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {messages.length <= 1 && (
        <div className="suggestions">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => void send(s)} disabled={busy}>
              {s.length > 42 ? `${s.slice(0, 42)}…` : s}
            </button>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? "Working…" : "Tell me about your product, with a link"}
          disabled={busy}
          autoFocus
        />
        <button type="submit" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>

      <style jsx global>{`
        :root {
          color-scheme: dark;
        }
        * {
          box-sizing: border-box;
        }
        body {
          margin: 0;
          background: #0c0c10;
          color: #e9e9ee;
          font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
        }
      `}</style>

      <style jsx>{`
        main {
          max-width: 720px;
          margin: 0 auto;
          height: 100dvh;
          display: flex;
          flex-direction: column;
          padding: 20px 16px 16px;
        }
        header h1 {
          font-size: 19px;
          margin: 0 0 4px;
          letter-spacing: -0.01em;
        }
        header p {
          margin: 0 0 14px;
          font-size: 13px;
          color: #9a9aa8;
          line-height: 1.5;
        }
        header strong {
          color: #c9c9d6;
          font-weight: 600;
        }
        .scroll {
          flex: 1;
          overflow-y: auto;
          border-top: 1px solid #1e1e26;
          padding-top: 16px;
        }
        .thread {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .row {
          display: flex;
        }
        .row.user {
          justify-content: flex-end;
        }
        .bubble {
          max-width: 88%;
          padding: 11px 14px;
          border-radius: 14px;
          background: #16161d;
          border: 1px solid #22222c;
          font-size: 14.5px;
          line-height: 1.55;
        }
        .row.user .bubble {
          background: #2b2b6d;
          border-color: #3a3a8c;
        }
        .bubble.failed {
          background: #2a1618;
          border-color: #4a2226;
        }
        .text {
          white-space: pre-wrap;
        }
        .steps {
          list-style: none;
          margin: 10px 0 0;
          padding: 0;
          font-size: 13px;
          color: #8f8fa0;
        }
        .steps li {
          padding: 2px 0 2px 16px;
          position: relative;
        }
        .steps li::before {
          content: "✓";
          position: absolute;
          left: 0;
          color: #4ec98a;
        }
        .steps li.active {
          color: #d7d7e2;
        }
        .steps li.active::before {
          content: "→";
          color: #7b7bff;
        }
        .dots {
          display: inline-block;
          width: 28px;
          height: 8px;
          background: linear-gradient(90deg, #555 25%, #999 50%, #555 75%);
          background-size: 200% 100%;
          animation: shimmer 1.1s linear infinite;
          border-radius: 4px;
          margin-top: 6px;
        }
        @keyframes shimmer {
          to {
            background-position: -200% 0;
          }
        }
        .result {
          margin-top: 12px;
        }
        .result video {
          width: 100%;
          max-width: 280px;
          border-radius: 12px;
          background: #000;
          display: block;
        }
        .links {
          margin-top: 8px;
          font-size: 12.5px;
        }
        .links a {
          color: #8f8fff;
        }
        .sep {
          margin: 0 6px;
          color: #44444f;
        }
        .muted {
          color: #7b7b8b;
        }
        details {
          margin-top: 10px;
          font-size: 12.5px;
          color: #9a9aa8;
        }
        details summary {
          cursor: pointer;
        }
        details ul {
          margin: 8px 0 0;
          padding-left: 18px;
        }
        details li {
          margin: 3px 0;
        }
        .suggestions {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          padding: 14px 0 4px;
        }
        .suggestions button {
          background: #16161d;
          color: #b9b9c8;
          border: 1px solid #26262f;
          border-radius: 999px;
          padding: 7px 13px;
          font-size: 12.5px;
          cursor: pointer;
        }
        .suggestions button:hover:not(:disabled) {
          border-color: #3d3d80;
          color: #e9e9ee;
        }
        form {
          display: flex;
          gap: 8px;
          padding-top: 14px;
        }
        input {
          flex: 1;
          background: #14141a;
          border: 1px solid #26262f;
          color: inherit;
          border-radius: 11px;
          padding: 12px 14px;
          font-size: 14.5px;
          font-family: inherit;
        }
        input:focus {
          outline: none;
          border-color: #4a4aa0;
        }
        form button {
          background: #4a4ad8;
          color: #fff;
          border: 0;
          border-radius: 11px;
          padding: 0 20px;
          font-size: 14.5px;
          font-weight: 600;
          cursor: pointer;
        }
        form button:disabled,
        .suggestions button:disabled {
          opacity: 0.45;
          cursor: default;
        }
      `}</style>
    </main>
  );
}
