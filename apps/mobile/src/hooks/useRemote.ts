import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { apiRequest } from "../api";

// every: how often to reload in the background (default every 30 seconds). Changing it does not
// clear the data; background reloads and refresh() never blank the screen.
export function useRemote<T>(path: string, expired: () => void, every = 30000) {
  const interval = useRef(every);
  interval.current = every;
  const quiet = useRef<() => Promise<void>>(async () => {});
  // Data is tagged with the path it was loaded for, so a previous resource is
  // never exposed as the newly requested one during the render before the
  // effect below resets state.
  const [loaded, setLoaded] = useState<{ path: string; data: T | null }>({
    path,
    data: null,
  });
  const setData = (data: T | null) => setLoaded({ path, data });
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const current = loaded.path === path;
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setData(null);
    setLoading(true);
    async function load() {
      if (AppState.currentState !== "active" && AppState.currentState !== null)
        return;
      try {
        const next = await apiRequest<T>(path, { signal: controller.signal });
        if (active) {
          setData(next);
          setError("");
        }
      } catch (e) {
        if (active && (e as Error).name !== "AbortError") {
          if ((e as { status?: number }).status === 401) expired();
          setError((e as Error).message);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    quiet.current = load;
    let last = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - last >= interval.current) {
        last = Date.now();
        void load();
      }
    }, 5000);
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void load();
    });
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
      listener.remove();
    };
  }, [path, version, expired]);
  return {
    data: current ? loaded.data : null,
    error,
    loading: loading || !current,
    reload: () => setVersion((n) => n + 1),
    // Reload in place, keeping the current data on screen.
    refresh: () => void quiet.current(),
  };
}
