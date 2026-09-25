"use client";

import { Component, type ReactNode } from "react";
import { Notice, errorText } from "./ui";

/**
 * Convex surfaces a rejected query by throwing during render. The most common
 * cause here is a wrong dashboard key, so the boundary offers to forget it
 * rather than leaving a blank page.
 */
export class ErrorBoundary extends Component<
  /** Inline boundaries keep the rest of the app usable and show the failure in place. */
  { children: ReactNode; onReset: () => void; inline?: boolean },
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

    if (this.props.inline) {
      const missing = /No (public )?(function|query|mutation|action) named/i.test(message);
      return (
        <Notice tone="danger" title={isKeyProblem ? "That key was rejected" : "This page couldn't load"} details={errorText(error)}
          action={<>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => this.setState({ error: null })}>Try again</button>
            {isKeyProblem && <button type="button" className="btn btn-ghost btn-sm" onClick={() => { this.setState({ error: null }); this.props.onReset(); }}>Enter a different key</button>}
          </>}>
          {isKeyProblem ? "The dashboard key in this browser doesn't match this deployment."
            : missing ? "Perry's server is running older code than this page. Restart Perry (perry stop, then perry start) and reload."
            : "Perry's server returned an error. The rest of the dashboard still works."}
        </Notice>
      );
    }

    return (
      <main className="gate-page">
        <div className="gate" role="alert">
          <span className="brand-mark" aria-hidden="true">P</span>
          <h1>{isKeyProblem ? "That key was rejected" : "Something went wrong"}</h1>
          <p>
            {isKeyProblem
              ? "The dashboard key in this browser doesn't match this deployment. It may have changed. Enter the current key from .env.local."
              : "Perry's server returned an error while loading this page. Try again. If it keeps happening, the details below say what failed."}
          </p>
          <details className="disclosure" style={{ marginBottom: 20 }}>
            <summary>Technical details</summary>
            <pre className="activity-prompt-text">{errorText(error).slice(0, 1200)}</pre>
          </details>
          <div style={{ display: "grid", gap: 8 }}>
            {isKeyProblem ? <>
              <button type="button" className="btn btn-primary btn-lg" onClick={() => { this.setState({ error: null }); this.props.onReset(); }}>Enter a different key</button>
              <button type="button" className="btn btn-secondary btn-lg" onClick={() => this.setState({ error: null })}>Try again</button>
            </> : <>
              <button type="button" className="btn btn-primary btn-lg" onClick={() => this.setState({ error: null })}>Try again</button>
              <button type="button" className="btn btn-secondary btn-lg" onClick={() => window.location.reload()}>Reload the page</button>
              <button type="button" className="btn btn-ghost btn-lg" onClick={() => { this.setState({ error: null }); this.props.onReset(); }}>Lock and enter the key again</button>
            </>}
          </div>
        </div>
      </main>
    );
  }
}
