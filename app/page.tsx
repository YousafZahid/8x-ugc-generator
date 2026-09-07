/**
 * Placeholder. The chat UI lands here once the container is proven to render
 * on the target instance - deploying first is deliberate, so a memory or CPU
 * ceiling shows up before anything is built on top of it.
 */
export default function Home() {
  return (
    <main
      style={{
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        maxWidth: 640,
        margin: "0 auto",
        padding: "64px 24px",
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>UGC Video Generator</h1>
      <p style={{ color: "#555" }}>
        Container is up. The renderer is wired and verified; the chat interface is next.
      </p>
      <ul style={{ color: "#555" }}>
        <li>
          <a href="/api/health">/api/health</a> - liveness and ffmpeg presence
        </li>
        <li>
          <a href="/api/smoke">/api/smoke</a> - full four-layer render on this instance
        </li>
      </ul>
    </main>
  );
}
