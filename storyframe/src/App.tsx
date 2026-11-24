import { ConnectionTestScreen } from "./components/ConnectionTestScreen";

export default function App() {
  return (
    <div className="app-shell">
      <header className="site-header">
        <div>
          <p className="eyebrow">StoryFrame / Phase 1</p>
          <h1>Ollama Cloud connection test</h1>
          <p className="lede">
            A development-only screen that sends one bounded request through the StoryFrame server to Ollama Cloud and
            shows the actual reply that comes back.
          </p>
        </div>
        <span className="badge">Development only</span>
      </header>

      <main>
        <ConnectionTestScreen />
      </main>

      <footer className="site-footer">
        <p>
          No application authentication exists yet. The test endpoint is gated by a server-verified development bearer
          token, which is not production authentication. Provider credentials are read only by the Node server process.
        </p>
      </footer>
    </div>
  );
}
