"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Progress copy, in the order it appears.
 *
 * Deliberately not the pipeline's stage names. "Reading the site ->
 * Understanding the product -> Choosing footage, sticker and music ->
 * Compositing four layers" describes how this is built, which is not something
 * the user asked to know. The wait still has to feel accounted for, so the
 * phases remain, worded as what is happening to their video.
 */
const PHASES: Record<string, string> = {
  read: "Looking at your site",
  understand: "Working out what to say",
  assets: "Finding the right visuals and music",
  compose: "Putting your video together",
};
const PHASE_ORDER = ["read", "understand", "assets", "compose"];

type Msg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  phase?: string;
  videoUrl?: string;
  posterUrl?: string | null;
  credits?: string[];
  pending?: boolean;
  failed?: boolean;
  unplayable?: boolean;
};

const EXAMPLES = [
  { label: "Duolingo", text: "Make an ad for Duolingo — duolingo.com" },
  { label: "WHOOP", text: "I'm launching WHOOP, a fitness wearable — whoop.com" },
  { label: "Raycast", text: "Make a video for Raycast — raycast.com" },
];

let seq = 0;
const nextId = () => `m${++seq}`;

export default function Home() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  useEffect(() => () => esRef.current?.close(), []);

  const patch = useCallback((id: string, changes: Partial<Msg>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...changes } : m)));
  }, []);

  const copy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(window.location.origin + url);
      setCopied(url);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // Clipboard is permission-gated; the download link still works.
    }
  }, []);

  const watch = useCallback(
    (jobId: string, msgId: string) => {
      esRef.current?.close();
      const es = new EventSource(`/api/generate?id=${encodeURIComponent(jobId)}`);
      esRef.current = es;

      es.addEventListener("progress", (e) => {
        const p = JSON.parse((e as MessageEvent).data) as { step: string };
        if (PHASES[p.step]) patch(msgId, { phase: p.step });
      });

      es.addEventListener("done", (e) => {
        const d = JSON.parse((e as MessageEvent).data) as {
          videoUrl: string;
          posterUrl: string | null;
          credits: string[];
        };
        patch(msgId, {
          pending: false,
          phase: undefined,
          videoUrl: d.videoUrl,
          posterUrl: d.posterUrl,
          credits: d.credits,
          text: "Here's your ad.",
        });
        setBusy(false);
        es.close();
      });

      es.addEventListener("error", (e) => {
        const raw = (e as MessageEvent).data;
        const message = raw
          ? (JSON.parse(raw) as { message: string }).message
          : "The connection dropped while making your video. Send it again and I'll retry.";
        patch(msgId, { pending: false, phase: undefined, failed: true, text: message });
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

      const id = nextId();
      setMessages((prev) => [...prev, { id, role: "assistant", text: "", pending: true }]);

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
          patch(id, { pending: false, failed: true, text: data.error });
          setBusy(false);
          return;
        }

        patch(id, {
          text: data.reply ?? "",
          pending: data.action === "generate",
          phase: data.action === "generate" ? "read" : undefined,
        });

        if (data.action === "generate" && data.jobId) watch(data.jobId, id);
        else setBusy(false);
      } catch {
        patch(id, {
          pending: false,
          failed: true,
          text: "Couldn't reach the server. Check your connection and try again.",
        });
        setBusy(false);
      }
    },
    [busy, patch, watch]
  );

  const empty = messages.length === 0;

  return (
    <main>
      <header>
        <div className="brand">
          <span className="mark" />
          <span className="wordmark">UGC Studio</span>
        </div>
      </header>

      <div className={`scroll ${empty ? "centered" : ""}`} ref={scrollRef}>
        {empty ? (
          <div className="hero">
            <h1>
              Turn a website into a
              <br />
              <em>video ad</em>
            </h1>
            <p className="lede">
              Give me a link and I&rsquo;ll put together a short vertical ad &mdash; background
              video, music and animated stickers, ready to post.
            </p>

            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button key={ex.label} onClick={() => void send(ex.text)} disabled={busy}>
                  <span className="dot" />
                  {ex.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="thread">
            {messages.map((m) => (
              <div key={m.id} className={`row ${m.role}`}>
                <div className={`bubble ${m.failed ? "failed" : ""}`}>
                  {m.text && <div className="text">{m.text}</div>}

                  {m.pending && (
                    <div className="working">
                      <span className="spin" />
                      <span className="phase">
                        {(m.phase && PHASES[m.phase]) ?? "Getting started"}&hellip;
                      </span>
                      <span className="bar">
                        <i
                          style={{
                            width: `${
                              (((m.phase ? PHASE_ORDER.indexOf(m.phase) : 0) + 1) /
                                (PHASE_ORDER.length + 1)) *
                              100
                            }%`,
                          }}
                        />
                      </span>
                    </div>
                  )}

                  {m.videoUrl && (
                    <div className="result">
                      {m.unplayable ? (
                        <div className="noplay">
                          <p>Your browser couldn&rsquo;t play this inline.</p>
                          <p className="muted">The file is fine &mdash; download it instead.</p>
                        </div>
                      ) : (
                        <video
                          src={m.videoUrl}
                          poster={m.posterUrl ?? undefined}
                          controls
                          autoPlay
                          muted
                          loop
                          playsInline
                          preload="auto"
                          onError={() => patch(m.id, { unplayable: true })}
                        />
                      )}

                      <div className="actions">
                        <button onClick={() => void copy(m.videoUrl!)}>
                          {copied === m.videoUrl ? "Link copied" : "Copy link"}
                        </button>
                        <a href={m.videoUrl} download>
                          Download
                        </a>
                      </div>

                      {m.credits && m.credits.length > 0 && (
                        <details>
                          <summary>Licences</summary>
                          <ul>
                            {m.credits.map((c) => (
                              <li key={c}>{c}</li>
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
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <div className="field">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={busy ? "Making your video…" : "Paste a website link"}
            disabled={busy}
            aria-label="Website link"
          />
          <button type="submit" disabled={busy || !input.trim()} aria-label="Send">
            {busy ? <span className="spin light" /> : <ArrowUp />}
          </button>
        </div>
      </form>

      <style jsx global>{`
        :root {
          color-scheme: dark;
        }
        * {
          box-sizing: border-box;
        }
        html,
        body {
          margin: 0;
          height: 100%;
          background: #07070b;
          color: #eceef5;
          font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
        }
      `}</style>

      <style jsx>{`
        /* Layered surfaces rather than one flat black: page, panels and the
           composer each sit at a different level so every edge is readable. */
        main {
          --surface: #12131b;
          --surface-2: #191b25;
          --line: #262936;
          --line-bright: #343849;
          --text: #eceef5;
          --muted: #8b8fa3;
          --accent: #6d5cff;
          --accent-2: #a855f7;

          position: relative;
          max-width: 720px;
          margin: 0 auto;
          height: 100dvh;
          display: flex;
          flex-direction: column;
          padding: 20px 20px 18px;
          isolation: isolate;
        }
        main::before {
          content: "";
          position: fixed;
          inset: 0;
          z-index: -1;
          background:
            radial-gradient(60rem 32rem at 50% -12%, rgba(109, 92, 255, 0.16), transparent 70%),
            radial-gradient(40rem 24rem at 90% 8%, rgba(168, 85, 247, 0.1), transparent 70%);
          pointer-events: none;
        }

        header {
          flex: none;
          padding-bottom: 16px;
        }
        .brand {
          display: inline-flex;
          align-items: center;
          gap: 9px;
        }
        .mark {
          width: 22px;
          height: 22px;
          border-radius: 7px;
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
          box-shadow: 0 4px 16px rgba(109, 92, 255, 0.45);
        }
        .wordmark {
          font-size: 14.5px;
          font-weight: 650;
          letter-spacing: -0.01em;
        }

        .scroll {
          flex: 1;
          overflow-y: auto;
          min-height: 0;
          padding: 4px 2px 8px;
        }
        .scroll.centered {
          display: flex;
          flex-direction: column;
          justify-content: center;
        }

        .hero h1 {
          font-size: clamp(30px, 6vw, 42px);
          line-height: 1.08;
          letter-spacing: -0.035em;
          font-weight: 680;
          margin: 0 0 16px;
        }
        .hero em {
          font-style: normal;
          background: linear-gradient(100deg, #a78bfa, #6d5cff 55%, #22d3ee);
          -webkit-background-clip: text;
          background-clip: text;
          color: transparent;
        }
        .lede {
          margin: 0 0 26px;
          font-size: 15.5px;
          line-height: 1.6;
          color: var(--muted);
          max-width: 46ch;
        }
        .examples {
          display: flex;
          flex-wrap: wrap;
          gap: 9px;
        }
        .examples button {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          background: var(--surface);
          border: 1px solid var(--line);
          color: var(--text);
          border-radius: 999px;
          padding: 9px 16px 9px 12px;
          font-size: 13.5px;
          font-weight: 500;
          font-family: inherit;
          cursor: pointer;
          transition: border-color 0.15s, background 0.15s, transform 0.15s;
        }
        .examples button:hover:not(:disabled) {
          background: var(--surface-2);
          border-color: var(--line-bright);
          transform: translateY(-1px);
        }
        .examples .dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
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
          padding: 12px 15px;
          border-radius: 16px;
          background: var(--surface);
          border: 1px solid var(--line);
          font-size: 14.5px;
          line-height: 1.55;
        }
        .row.user .bubble {
          background: linear-gradient(135deg, #5b4ce0, #7c3aed);
          border-color: transparent;
          box-shadow: 0 6px 20px rgba(109, 92, 255, 0.28);
        }
        .bubble.failed {
          background: #24151a;
          border-color: #532a35;
        }
        .text {
          white-space: pre-wrap;
        }

        .working {
          display: grid;
          grid-template-columns: auto 1fr;
          align-items: center;
          gap: 9px;
          margin-top: 4px;
          min-width: 240px;
        }
        .phase {
          font-size: 13.5px;
          color: var(--muted);
        }
        .bar {
          grid-column: 1 / -1;
          height: 3px;
          background: #23252f;
          border-radius: 3px;
          overflow: hidden;
          margin-top: 4px;
        }
        .bar i {
          display: block;
          height: 100%;
          border-radius: 3px;
          background: linear-gradient(90deg, var(--accent), var(--accent-2));
          transition: width 0.6s ease;
        }
        .spin {
          width: 13px;
          height: 13px;
          border: 2px solid var(--accent);
          border-top-color: transparent;
          border-radius: 50%;
          display: inline-block;
          animation: rot 0.75s linear infinite;
        }
        .spin.light {
          border-color: #fff;
          border-top-color: transparent;
        }
        @keyframes rot {
          to {
            transform: rotate(360deg);
          }
        }

        .result {
          margin-top: 12px;
        }
        .result video,
        .noplay {
          width: 100%;
          max-width: 258px;
          aspect-ratio: 9 / 16;
          max-height: 60vh;
          border-radius: 14px;
          display: block;
          background: #000;
          border: 1px solid var(--line);
          box-shadow: 0 12px 34px rgba(0, 0, 0, 0.55);
          object-fit: contain;
        }
        .noplay {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 22px;
          text-align: center;
          font-size: 13px;
          border-style: dashed;
        }
        .noplay p {
          margin: 0;
        }
        .muted {
          color: var(--muted);
        }
        .actions {
          display: flex;
          gap: 8px;
          margin-top: 11px;
          max-width: 258px;
        }
        .actions button,
        .actions a {
          flex: 1;
          text-align: center;
          font-size: 12.5px;
          font-weight: 500;
          padding: 9px 10px;
          border-radius: 10px;
          border: 1px solid var(--line);
          background: var(--surface-2);
          color: var(--text);
          cursor: pointer;
          text-decoration: none;
          font-family: inherit;
          transition: border-color 0.15s, background 0.15s;
        }
        .actions button:hover,
        .actions a:hover {
          border-color: var(--line-bright);
          background: #20222e;
        }
        details {
          margin-top: 11px;
          font-size: 12px;
          color: var(--muted);
          max-width: 258px;
        }
        details summary {
          cursor: pointer;
          list-style: none;
        }
        details summary::-webkit-details-marker {
          display: none;
        }
        details summary::before {
          content: "▸ ";
        }
        details[open] summary::before {
          content: "▾ ";
        }
        details ul {
          margin: 7px 0 0;
          padding-left: 15px;
        }
        details li {
          margin: 3px 0;
          line-height: 1.45;
          word-break: break-word;
        }

        form {
          flex: none;
          padding-top: 14px;
        }
        .field {
          display: flex;
          align-items: center;
          gap: 8px;
          background: var(--surface-2);
          border: 1px solid var(--line-bright);
          border-radius: 15px;
          padding: 6px 6px 6px 16px;
          box-shadow: 0 8px 26px rgba(0, 0, 0, 0.5);
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .field:focus-within {
          border-color: var(--accent);
          box-shadow: 0 8px 26px rgba(0, 0, 0, 0.5), 0 0 0 3px rgba(109, 92, 255, 0.18);
        }
        .field input {
          flex: 1;
          min-width: 0;
          background: transparent;
          border: 0;
          outline: none;
          color: var(--text);
          font-size: 15px;
          font-family: inherit;
          padding: 10px 0;
        }
        .field input::placeholder {
          color: #6c7085;
        }
        .field button {
          flex: none;
          width: 38px;
          height: 38px;
          border-radius: 11px;
          border: 0;
          background: linear-gradient(135deg, var(--accent), var(--accent-2));
          color: #fff;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
        }
        .field button:disabled {
          opacity: 0.4;
          cursor: default;
        }
        .examples button:disabled {
          opacity: 0.45;
          cursor: default;
        }

        @media (max-width: 460px) {
          main {
            padding: 16px 14px 14px;
          }
          .bubble {
            max-width: 100%;
          }
          .result video,
          .noplay,
          .actions,
          details {
            max-width: 100%;
          }
        }
      `}</style>
    </main>
  );
}

function ArrowUp() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 19V5M12 5l-6 6M12 5l6 6"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
