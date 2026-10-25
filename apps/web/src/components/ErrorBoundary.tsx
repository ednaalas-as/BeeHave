import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="empty">
        <h1>Something went wrong</h1>
        <p>Your monitoring records are preserved. Reload to try again.</p>
        <button onClick={() => window.location.reload()}>Reload BeeHave</button>
      </div>
    ) : (
      this.props.children
    );
  }
}
