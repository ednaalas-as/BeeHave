import { type Session } from "@beehave/shared";
import { ArrowUpRight, ExternalLink, ShieldCheck } from "lucide-react";
import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import logo from "../../../../packages/shared/assets/beehave-logo.png";
import { api } from "../api";
import { Logo } from "../components/Logo";
import { Wordmark } from "../components/Wordmark";

// Deployments without public sign-up (staging) build with this set; the API
// enforces it separately with DISABLE_REGISTRATION.
const registrationDisabled =
  import.meta.env.VITE_DISABLE_REGISTRATION === "true";

export function Auth({ onAuthenticated }: {
  onAuthenticated: (session: Session) => Promise<void>;
}) {
  const navigate = useNavigate();
  const [resetToken] = useState(
    () =>
      new URLSearchParams(window.location.hash.slice(1)).get("reset") ??
      new URLSearchParams(window.location.search).get("reset") ??
      "",
  );
  const [mode, setMode] = useState<"login" | "register" | "recover" | "reset">(
    () => (resetToken ? "reset" : "login"),
  );
  const [samplePreview, setSamplePreview] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  function clearResetLink() {
    const url = new URL(window.location.href);
    url.searchParams.delete("reset");
    url.hash = "";
    window.history.replaceState(null, "", url.pathname + url.search);
  }
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.currentTarget));
    setPending(true);
    setError("");
    setMessage("");
    try {
      if (mode === "recover") {
        await api("/auth/recover", {
          method: "POST",
          body: JSON.stringify(fields),
        });
        setMessage(
          "If an account uses that email, a recovery link will be sent. Check your inbox and spam folder.",
        );
      } else if (mode === "reset") {
        if (fields.password !== fields.confirmPassword) {
          setError("The new passwords do not match.");
          return;
        }
        await api("/auth/reset", {
          method: "POST",
          body: JSON.stringify({
            token: resetToken,
            password: fields.password,
          }),
        });
        clearResetLink();
        setMode("login");
        setMessage("Password updated. Sign in with your new password.");
      } else {
        if (mode === "register" && fields.password !== fields.confirmPassword) {
          setError("The passwords do not match.");
          return;
        }
        // Registration needs only the person's own details; the API creates
        // their farm workspace automatically.
        const { confirmPassword: _confirm, ...credentials } = fields;
        const result = await api<Session>(`/auth/${mode}`, {
          method: "POST",
          body: JSON.stringify(credentials),
        });
        navigate("/", { replace: true });
        await onAuthenticated(result);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function demo() {
    setPending(true);
    setError("");
    try {
      const result = await api<Session>("/auth/demo", { method: "POST", body: "{}" });
      clearResetLink();
      navigate("/", { replace: true });
      await onAuthenticated(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="auth-page">
      <section className="auth-story">
        <Logo />
        <div className="auth-brand">
          <img
            src={logo}
            alt="BeeHave bee and soundwave logo"
            width={300}
            height={300}
          />
          <h1>
            <Wordmark width={240} />
          </h1>
          <p>Bee activity monitoring</p>
        </div>
      </section>
      <section className="auth-form-panel">
        <div className="auth-form">
          <span className="small-label">WELCOME TO BEEHAVE</span>
          <h2>
            {mode === "register"
              ? "Create an account"
              : mode === "recover"
                ? "Recover your account"
                : mode === "reset"
                  ? "Choose a new password"
                  : "Sign in"}
          </h2>
          <p className="muted">
            {mode === "register"
              ? "Your private farm workspace is created for you. Your data starts empty."
              : mode === "recover"
                ? "We’ll email a secure recovery link to your account address."
                : mode === "reset"
                  ? "Choose a new password with at least 12 characters."
                  : "Sign in to your farm’s monitoring workspace."}
          </p>
          {mode === "recover" || mode === "reset" ? (
            <form onSubmit={submit}>
              {mode === "recover" ? (
                <label>
                  Account email address
                  <input
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    autoComplete="email"
                    required
                  />
                </label>
              ) : (
                <>
                  <label>
                    New password
                    <input
                      name="password"
                      type="password"
                      minLength={12}
                      maxLength={128}
                      autoComplete="new-password"
                      required
                    />
                  </label>
                  <label>
                    Confirm new password
                    <input
                      name="confirmPassword"
                      type="password"
                      minLength={12}
                      maxLength={128}
                      autoComplete="new-password"
                      required
                    />
                  </label>
                </>
              )}
              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}
              {message && (
                <div className="notice" role="status">
                  {message}
                </div>
              )}
              <button className="primary full" disabled={pending}>
                {pending
                  ? "Please wait…"
                  : mode === "recover"
                    ? "Send recovery email"
                    : "Update password"}
                <ArrowUpRight size={17} />
              </button>
              <button
                type="button"
                className="text-button full"
                onClick={() => {
                  setMode("login");
                  setError("");
                  setMessage("");
                  if (mode === "reset") clearResetLink();
                }}
              >
                Back to sign in
              </button>
            </form>
          ) : (
            <>
              <form onSubmit={submit}>
                {mode === "register" && (
                  <label>
                    Full name
                    <input
                      name="name"
                      autoComplete="name"
                      required
                      minLength={2}
                    />
                  </label>
                )}
                <label>
                  Email address
                  <input
                    name="email"
                    type="email"
                    placeholder="you@example.com"
                    autoComplete="email"
                    required
                  />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    placeholder={
                      mode === "register"
                        ? "At least 12 characters"
                        : "Enter your password"
                    }
                    minLength={mode === "register" ? 12 : 1}
                    maxLength={128}
                    autoComplete={
                      mode === "register" ? "new-password" : "current-password"
                    }
                    required
                  />
                </label>
                {mode === "register" && (
                  <label>
                    Confirm password
                    <input
                      name="confirmPassword"
                      type="password"
                      placeholder="Re-enter your password"
                      minLength={12}
                      maxLength={128}
                      autoComplete="new-password"
                      required
                    />
                  </label>
                )}
                {mode === "login" && (
                  <button
                    type="button"
                    className="text-button forgot"
                    onClick={() => {
                      setMode("recover");
                      setError("");
                      setMessage("");
                    }}
                  >
                    Forgot password?
                  </button>
                )}
                {error && (
                  <p className="form-error" role="alert">
                    {error}
                  </p>
                )}
                <button className="primary full" disabled={pending}>
                  {pending
                    ? "Please wait…"
                    : mode === "register"
                      ? "Create account"
                      : "Sign in"}
                  <ArrowUpRight size={17} />
                </button>
              </form>
              {message && (
                <div className="notice" role="status">
                  {message}
                </div>
              )}
              {!(mode === "login" && registrationDisabled) && (
                <p className="auth-switch">
                  {mode === "login"
                    ? "New to BeeHave?"
                    : "Already have an account?"}{" "}
                  <button
                    className="text-button"
                    onClick={() => {
                      setMode(mode === "login" ? "register" : "login");
                      setError("");
                    }}
                  >
                    {mode === "login" ? "Create an account" : "Sign in"}
                  </button>
                </p>
              )}
              <div className="or">
                <span />
                or explore first
                <span />
              </div>
              {samplePreview ? (
                <div
                  className="notice"
                  role="region"
                  aria-label="Sample Farm Preview"
                >
                  <strong>Sample Farm Preview</strong>
                  <p>
                    The data shown in this farm is synthetic and is provided
                    only to demonstrate BeeHave’s features and how the
                    application works. It does not represent actual bee
                    activity, recordings, environmental readings, or real farm
                    data.
                  </p>
                  <button
                    className="primary full"
                    onClick={demo}
                    disabled={pending}
                  >
                    Continue to Sample Farm
                  </button>
                  <button
                    className="text-button full"
                    onClick={() => setSamplePreview(false)}
                    disabled={pending}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <button
                  className="full"
                  onClick={() => setSamplePreview(true)}
                  disabled={pending}
                >
                  Explore sample farm <ExternalLink size={16} />
                </button>
              )}
              <p className="caption center">
                Sample workspace uses labeled synthetic data.
                <br />
                No hardware connection is required.
              </p>
            </>
          )}
          <div className="auth-trust">
            <ShieldCheck size={16} /> Private farm access · Read-only monitoring
            records
          </div>
        </div>
      </section>
    </div>
  );
}
