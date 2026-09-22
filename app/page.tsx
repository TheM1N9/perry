/**
 * Placeholder. The real dashboard (threads, memories, connected accounts) is a
 * later step; Perry is usable from Telegram long before this page matters.
 */
export default function Home() {
  const modes = [
    {
      name: "Perry",
      detail: "recall, remember. 4 steps. read-only, cheap, default.",
    },
    {
      name: "Agent P",
      detail: "recall, remember, forget. 40 steps. approval on destructive.",
    },
  ];

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "4rem 1.5rem" }}>
      <h1 style={{ fontSize: "1.5rem", margin: 0 }}>Perry</h1>
      <p style={{ color: "#8a8a92", marginTop: "0.5rem" }}>
        Running in Telegram. This dashboard is not built yet.
      </p>

      <h2 style={{ fontSize: "0.85rem", color: "#8a8a92", marginTop: "3rem" }}>
        MODES
      </h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {modes.map((mode) => (
          <li key={mode.name} style={{ marginBottom: "1rem" }}>
            <strong>{mode.name}</strong>
            <div style={{ color: "#8a8a92" }}>{mode.detail}</div>
          </li>
        ))}
      </ul>
    </main>
  );
}
