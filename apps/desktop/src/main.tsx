import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

interface ErrorBoundaryState {
  error: Error | null;
}

class StudioErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  private handleResetAndReload = () => {
    try {
      localStorage.removeItem("vedit.apk.project.v3");
    } catch {
      /* ignore */
    }
    this.setState({ error: null });
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 14,
            padding: 24,
            background: "#09090b",
            color: "#f4f4f6",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 600 }}>Vedit Studio Recovery</div>
          <div style={{ fontSize: 12.5, color: "#a1a1aa", maxWidth: 440, lineHeight: 1.5 }}>
            {this.state.error.message || "Unexpected studio render state."}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn-primary" onClick={() => this.setState({ error: null })}>
              Retry View
            </button>
            <button type="button" onClick={this.handleResetAndReload}>
              Reset Workspace &amp; Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <StudioErrorBoundary>
      <App />
    </StudioErrorBoundary>
  </React.StrictMode>,
);
