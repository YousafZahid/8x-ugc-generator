"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Stage = { key: string; label: string };

/**
 * Fixed checklist. Rendering the stages up front - greyed until reached - lets
 * the 13-second wait read as a known sequence rather than an unbounded hang.
 */
const STAGES: Stage[] = [
  { key: "read", label: "Reading the site" },
  { key: "understand", label: "Understanding the product" },
  { key: "assets", label: "Choosing footage, sticker & music" },
  { key: "compose", label: "Compositing four layers" },
];

type Msg = {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Latest detail line per stage key. */
  stageDetail?: Record<string, string>;
  reached?: string[];
  product?: string;
  hook?: string;
  videoUrl?: string;
  posterUrl?: string | null;
  credits?: string[];
  notes?: string[];
  pending?: boolean;
  failed?: boolean;
  /** Inline playback failed - the file is still fine, offer the download. */
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
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      // Clipboard is permission-gated; the input below is selectable regardless.
    }
  }, []);

  const watch = useCallback(
    (jobId: string, msgId: string) => {
      esRef.current?.close();
      const es = new EventSource(`/api/generate?id=${encodeURIComponent(jobId)}`);
      esRef.current = es;

      es.addEventListener("progress", (e) => {
        const p = JSON.parse((e as MessageEvent).data) as {
          step: string;
          detail: string;
          meta?: { product?: string; hook?: string };
        };
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  reached: Array.from(new Set([...(m.reached ?? []), p.step])),
                  stageDetail: { ...(m.stageDetail ?? {}), [p.step]: p.detail },
                  product: p.meta?.product ?? m.product,
                  hook: p.meta?.hook ?? m.hook,
                }
              : m
          )
        );
      });

      es.addEventListener("done", (e) => {
        const d = JSON.parse((e as MessageEvent).data) as {
          videoUrl: string;
          posterUrl: string | null;
          credits: string[];
          notes: string[];
        };
        patch(msgId, {
          pending: false,
          videoUrl: d.videoUrl,
          posterUrl: d.posterUrl,
          credits: d.credits,
          notes: d.notes,
          text: "Here's your ad.",
        });
        setBusy(false);
        es.close();
      });

      es.addEventListener("error", (e) => {
        const raw = (e as MessageEvent).data;
        const message = raw
          ? (JSON.parse(raw) as { message: string }).message
          : "The connection dropped while rendering. Send it again and I'll retry.";
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
        { id: placeholderId, role: "assistant", text: "", pending: true },
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
          text: data.reply ?? "",
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

  const empty = messages.length === 0;

  return (
    <main>
      <header>
        <div className="brand">
          <span className="dot" />
          <h1>UGC Video Generator</h1>
        </div>
        <p>
          Send a product and its link. I read the site, then cut an 8-second vertical ad from
          real stock footage, an animated sticker and a music bed. <b>No AI-generated frames.</b>
        </p>
      </header>

      <div className={`scroll ${empty ? "centered" : ""}`} ref={scrollRef}>
        {empty ? (
          <div className="empty">
            <div className="layers">
              {[
                ["1", "Background", "Stock video"],
                ["2", "Text", "Timed overlays"],
                ["3", "Audio", "Matched to vibe"],
                ["4", "Sticker", "Transparent GIF"],
              ].map(([n, t, s]) => (
                <div key={n} className="layer">
                  <span className="n">{n}</span>
                  <span className="t">{t}</span>
                  <span className="s">{s}</span>
                </div>
              ))}
            </div>
            <p className="try">Try one:</p>
            <div className="examples">
              {EXAMPLES.map((ex) => (
                <button key={ex.label} onClick={() => void send(ex.text)} disabled={busy}>
                  <b>{ex.label}</b>
                  <span>{ex.text}</span>
                </button>
              ))}
            </div>
            <p className="or">…or describe your own product with its URL.</p>
          </div>
        ) : (
          <div className="thread">
            {messages.map((m) => (
              <div key={m.id} className={`row ${m.role}`}>
                <div className={`bubble ${m.failed ? "failed" : ""}`}>
                  {m.text && <div className="text">{m.text}</div>}

                  {m.pending && (
                    <div className="stages">
                      {STAGES.map((stage) => {
                        const reached = m.reached?.includes(stage.key);
                        const active =
                          reached && m.reached?.[m.reached.length - 1] === stage.key;
                        return (
                          <div
                            key={stage.key}
                            className={`stage ${reached ? "on" : ""} ${active ? "active" : ""}`}
                          >
                            <span className="mark">
                              {active ? <span className="spin" /> : reached ? "✓" : "○"}
                            </span>
                            <span className="lbl">
                              {(reached && m.stageDetail?.[stage.key]) || stage.label}
                            </span>
                          </div>
                        );
                      })}
                      <div className="bar">
                        <span
                          style={{
                            width: `${((m.reached?.length ?? 0) / STAGES.length) * 100}%`,
                          }}
                        />
                      </div>
                      {m.hook && (
                        <div className="preview">
                          Headline: <b>&ldquo;{m.hook}&rdquo;</b>
                        </div>
                      )}
                    </div>
                  )}

                  {m.videoUrl && (
                    <div className="result">
                      {m.unplayable ? (
                        <div className="noplay">
                          <p>Your browser couldn&rsquo;t play this inline.</p>
                          <p className="muted">
                            The file is fine — download it or open it in a new tab.
                          </p>
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
                      <div className="urlrow">
                        <input readOnly value={m.videoUrl} onFocus={(e) => e.target.select()} />
                        <button onClick={() => void copy(m.videoUrl!)}>
                          {copied === m.videoUrl ? "Copied" : "Copy"}
                        </button>
                        <a href={m.videoUrl} download>
                          Download
                        </a>
                      </div>
                      <p className="expiry">
                        Renders are ephemeral — this link dies when the server restarts.
                      </p>
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
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={busy ? "Rendering — one at a time…" : "e.g. I'm building Notion — notion.so"}
          disabled={busy}
          aria-label="Describe your product"
        />
        <button type="submit" disabled={busy || !input.trim()}>
          {busy ? <span className="spin dark" /> : "Send"}
        </button>
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
          background: #0b0b0f;
          color: #ececf1;
          font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
          -webkit-font-smoothing: antialiased;
        }
      `}</style>

      <style jsx>{`
        main {
          max-width: 700px;
          margin: 0 auto;
          height: 100dvh;
          display: flex;
          flex-direction: column;
          padding: 18px 16px 14px;
        }
        header {
          flex: none;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 9px;
        }
        .dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: #6c5cff;
          box-shadow: 0 0 12px #6c5cff;
          flex: none;
        }
        h1 {
          font-size: 17px;
          margin: 0;
          letter-spacing: -0.01em;
          font-weight: 650;
        }
        header p {
          margin: 8px 0 14px;
          font-size: 13px;
          line-height: 1.55;
          color: #9596a6;
        }
        header b {
          color: #cfd0dc;
          font-weight: 600;
        }
        .scroll {
          flex: 1;
          overflow-y: auto;
          border-top: 1px solid #1b1b23;
          padding-top: 16px;
          min-height: 0;
        }
        /* Empty state is centred: top-aligned it leaves a dead void above the
           composer on a tall desktop window. */
        .scroll.centered {
          display: flex;
          flex-direction: column;
          justify-content: center;
        }

        /* ---------- empty state ---------- */
        .empty {
          padding: 4px 0 8px;
        }
        .layers {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 8px;
          margin-bottom: 22px;
        }
        .layer {
          background: #121218;
          border: 1px solid #1f1f29;
          border-radius: 10px;
          padding: 10px 9px;
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .layer .n {
          font-size: 10px;
          color: #6c5cff;
          font-weight: 700;
        }
        .layer .t {
          font-size: 12.5px;
          font-weight: 600;
          color: #e3e3ec;
        }
        .layer .s {
          font-size: 11px;
          color: #7c7d8e;
          line-height: 1.3;
        }
        .try {
          font-size: 12px;
          color: #7c7d8e;
          margin: 0 0 9px;
          text-transform: uppercase;
          letter-spacing: 0.09em;
        }
        .examples {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .examples button {
          text-align: left;
          background: #121218;
          border: 1px solid #22222e;
          border-radius: 11px;
          padding: 12px 14px;
          cursor: pointer;
          color: inherit;
          display: flex;
          flex-direction: column;
          gap: 2px;
          transition: border-color 0.15s, background 0.15s;
          font-family: inherit;
        }
        .examples button:hover:not(:disabled) {
          border-color: #4a3fd0;
          background: #16161f;
        }
        .examples b {
          font-size: 13.5px;
          font-weight: 600;
        }
        .examples span {
          font-size: 12.5px;
          color: #8a8b9c;
        }
        .or {
          font-size: 12.5px;
          color: #6b6c7d;
          margin: 14px 0 0;
        }

        /* ---------- thread ---------- */
        .thread {
          display: flex;
          flex-direction: column;
          gap: 13px;
          padding-bottom: 6px;
        }
        .row {
          display: flex;
        }
        .row.user {
          justify-content: flex-end;
        }
        .bubble {
          max-width: 90%;
          padding: 11px 14px;
          border-radius: 14px;
          background: #14141b;
          border: 1px solid #202029;
          font-size: 14.5px;
          line-height: 1.55;
        }
        .row.user .bubble {
          background: #2a2578;
          border-color: #3a34a0;
        }
        .bubble.failed {
          background: #26161a;
          border-color: #4d2530;
        }
        .text {
          white-space: pre-wrap;
        }

        /* ---------- progress ---------- */
        .stages {
          margin-top: 10px;
          min-width: 250px;
        }
        .stage {
          display: flex;
          gap: 9px;
          align-items: baseline;
          padding: 3px 0;
          font-size: 13px;
          color: #55566a;
          transition: color 0.2s;
        }
        .stage.on {
          color: #9fa0b4;
        }
        .stage.active {
          color: #ecedf5;
        }
        .mark {
          width: 13px;
          flex: none;
          font-size: 11px;
          color: #4ec98a;
          display: inline-flex;
          justify-content: center;
        }
        .stage:not(.on) .mark {
          color: #35364a;
        }
        .lbl {
          line-height: 1.45;
        }
        .spin {
          width: 10px;
          height: 10px;
          border: 2px solid #6c5cff;
          border-top-color: transparent;
          border-radius: 50%;
          display: inline-block;
          animation: rot 0.7s linear infinite;
        }
        .spin.dark {
          border-color: #fff;
          border-top-color: transparent;
        }
        @keyframes rot {
          to {
            transform: rotate(360deg);
          }
        }
        .bar {
          height: 3px;
          background: #1e1e28;
          border-radius: 2px;
          margin-top: 10px;
          overflow: hidden;
        }
        .bar span {
          display: block;
          height: 100%;
          background: linear-gradient(90deg, #4a3fd0, #6c5cff);
          transition: width 0.5s ease;
        }
        .preview {
          margin-top: 10px;
          font-size: 12.5px;
          color: #8a8b9c;
          border-left: 2px solid #3a34a0;
          padding-left: 9px;
        }
        .preview b {
          color: #d7d8e6;
          font-weight: 600;
        }

        /* ---------- result ---------- */
        .result {
          margin-top: 12px;
        }
        .result video {
          width: 100%;
          max-width: 264px;
          aspect-ratio: 9 / 16;
          max-height: 62vh;
          border-radius: 13px;
          background: #000;
          display: block;
          border: 1px solid #24242f;
          object-fit: contain;
        }
        .urlrow {
          display: flex;
          gap: 6px;
          align-items: center;
          margin-top: 10px;
          max-width: 264px;
        }
        .urlrow input {
          flex: 1;
          min-width: 0;
          background: #0e0e14;
          border: 1px solid #22222d;
          border-radius: 8px;
          padding: 7px 9px;
          font-size: 11.5px;
          color: #9fa0b4;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .urlrow button,
        .urlrow a {
          flex: none;
          font-size: 11.5px;
          padding: 7px 10px;
          border-radius: 8px;
          border: 1px solid #22222d;
          background: #16161f;
          color: #c3c4d4;
          cursor: pointer;
          text-decoration: none;
          font-family: inherit;
        }
        .urlrow a:hover,
        .urlrow button:hover {
          border-color: #4a3fd0;
          color: #fff;
        }
        .noplay {
          width: 100%;
          max-width: 264px;
          aspect-ratio: 9 / 16;
          max-height: 62vh;
          border-radius: 13px;
          border: 1px dashed #33333f;
          background: #101017;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 6px;
          padding: 20px;
          text-align: center;
          font-size: 13px;
        }
        .noplay p {
          margin: 0;
        }
        .expiry {
          font-size: 11.5px;
          color: #63647a;
          margin: 8px 0 0;
        }
        details {
          margin-top: 10px;
          font-size: 12.5px;
          color: #8a8b9c;
        }
        details summary {
          cursor: pointer;
        }
        details ul {
          margin: 8px 0 0;
          padding-left: 17px;
        }
        details li {
          margin: 3px 0;
          line-height: 1.45;
          word-break: break-word;
        }
        .muted {
          color: #6b6c7d;
        }

        /* ---------- composer ---------- */
        form {
          flex: none;
          display: flex;
          gap: 8px;
          padding-top: 13px;
        }
        form input {
          flex: 1;
          min-width: 0;
          background: #121219;
          border: 1px solid #24242f;
          color: inherit;
          border-radius: 11px;
          padding: 12px 14px;
          font-size: 15px;
          font-family: inherit;
        }
        form input:focus {
          outline: none;
          border-color: #4a3fd0;
        }
        form input:disabled {
          opacity: 0.6;
        }
        form button {
          flex: none;
          background: #5b4ce0;
          color: #fff;
          border: 0;
          border-radius: 11px;
          min-width: 74px;
          height: 45px;
          font-size: 14.5px;
          font-weight: 600;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-family: inherit;
        }
        form button:disabled,
        .examples button:disabled {
          opacity: 0.45;
          cursor: default;
        }

        @media (max-width: 460px) {
          main {
            padding: 14px 12px 12px;
          }
          .layers {
            grid-template-columns: repeat(2, 1fr);
          }
          .bubble {
            max-width: 100%;
          }
          .result video,
          .urlrow {
            max-width: 100%;
          }
          header p {
            font-size: 12.5px;
          }
        }
      `}</style>
    </main>
  );
}
