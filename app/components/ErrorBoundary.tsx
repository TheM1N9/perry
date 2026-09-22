"use client";

import { Component, type ReactNode } from "react";

/**
 * Convex surfaces a rejected query by throwing during render. The most common
 * cause here is a wrong dashboard key, so the boundary offers to forget it
 * rather than leaving a blank page.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; onReset: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const message = error.message ?? String(error);
    const isKeyProblem = /dashboard key|DASHBOARD_KEY/i.test(message);

    return (
      <div className="gate">
        <h1 className="title">Perry</h1>
        <p className="hint" style={{ marginTop: 8 }}>
          {isKeyProblem
            ? "That key was rejected."
            : "Something failed on the server."}
        </p>
        <pre
          className="panel"
          style={{
            whiteSpace: "pre-wrap",
            fontSize: 12,
            color: "var(--dim)",
            margin: "0 0 14px",
          }}
        >
          {message.slice(0, 600)}
        </pre>
        <div className="row">
          <button
            className="primary"
            onClick={() => {
              this.setState({ error: null });
              this.props.onReset();
            }}
          >
            Use a different key
          </button>
          <button
            className="ghost"
            onClick={() => this.setState({ error: null })}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }
}
