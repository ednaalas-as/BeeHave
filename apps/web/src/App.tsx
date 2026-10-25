import { type Session } from "@beehave/shared";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api,WorkspaceProvider } from "./api";
import { Layout } from "./layout/AppLayout";
import { Auth } from "./pages/SignInPage";
import { Loading } from "./ui";
import { acceptSession, clearSession } from "./query-client";
import { releasePush } from "./push";

export function App() {
  const cache = useQueryClient();
  const [recovering, setRecovering] = useState(() => Boolean(
    new URLSearchParams(window.location.hash.slice(1)).get("reset") ??
      new URLSearchParams(window.location.search).get("reset"),
  ));
  async function authenticated(value: Session) {
    await acceptSession(cache, value);
    // Completing recovery is a React state transition, not a URL side effect.
    setRecovering(false);
  }
  const [signingOut, setSigningOut] = useState(false);
  const [signoutError, setSignoutError] = useState("");
  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    setSignoutError("");
    try {
      // This browser stops receiving notifications for the account signing out.
      await releasePush();
      await api("/auth/logout", { method: "POST" });
      await clearSession(cache);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (e) {
      setSignoutError((e as Error).message);
    } finally {
      setSigningOut(false);
    }
  }
  const session = useQuery({
    queryKey: ["session"],
    // Recovery renders Auth before reading session.data. Still subscribe to
    // data changes so a successful login can leave the recovery/sign-in screen.
    notifyOnChangeProps: ["data", "isPending"],
    queryFn: async () => {
      try {
        return await api<Session>("/auth/me");
      } catch (e) {
        if ((e as { status?: number }).status === 401) return null;
        throw e;
      }
    },
    retry: false,
  });
  useEffect(() => {
    if (session.isPending) return;
    const startup = document.getElementById("beehave-startup");
    if (!startup) return;
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    const entrance = startup
      .querySelector(".beehave-startup-mark")
      ?.getAnimations()[0];
    const minimumStartupDuration = 2800;
    const elapsed = entrance
      ? Number(entrance.currentTime ?? 0)
      : minimumStartupDuration;
    let removal: number | undefined;
    // Finish the startup sequence already in progress, never restart it.
    const settle = window.setTimeout(() => {
      startup.dataset.ready = "true";
      removal = window.setTimeout(
        () => {
          startup.remove();
          document.getElementById("root")?.removeAttribute("inert");
        },
        reducedMotion ? 160 : 360,
      );
    }, reducedMotion ? 0 : Math.max(0, minimumStartupDuration - elapsed));
    return () => {
      window.clearTimeout(settle);
      window.clearTimeout(removal);
    };
  }, [session.isPending]);
  if (recovering) return <Auth onAuthenticated={authenticated} />;
  if (signingOut) {
    return (
      <div className="loading" role="status">
        <RefreshCw className="spin" size={20} /> Signing you out…
      </div>
    );
  }
  if (session.isPending) return <Loading />;
  if (!session.data) return <Auth onAuthenticated={authenticated} />;
  return (
    <WorkspaceProvider account={session.data.account} logout={() => void logout()}>
      <Layout logout={logout} signoutError={signoutError} />
    </WorkspaceProvider>
  );
}
