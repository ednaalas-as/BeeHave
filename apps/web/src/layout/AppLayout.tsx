import { type Device,ago,isOnline } from "@beehave/shared";
import { useQuery,useQueryClient } from "@tanstack/react-query";
import {
Activity,
AudioLines,
LayoutDashboard,
Leaf,
LogOut,
Menu,
Radio,
RefreshCw,
Settings,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
Link,
NavLink,
Navigate,
Route,
Routes,
useLocation,
useNavigate,
} from "react-router-dom";
import { api,useWorkspace } from "../api";
import { ScopeSelectors } from "../components/ScopeSelectors";
import { Logo } from "../components/Logo";
import { ActivityPage,Dashboard } from "../overview";
import {
DetectionDetail,
DetectionModalHost,
Detections,
RecordingDetail,
Recordings,
} from "../records";
import { Devices,SettingsPage } from "../settings";
import { resyncPush } from "../push";
import { Badge } from "../ui";

export const destinations = [
  { to: "/", label: "Dashboard", icon: LayoutDashboard },
  { to: "/activity", label: "Activity", icon: Activity },
  { to: "/detections", label: "Detection", icon: Radio },
  { to: "/recordings", label: "Recordings", icon: AudioLines },
  { to: "/devices", label: "Edge Device", icon: Radio },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function Layout({ logout, signoutError }: {
  logout: () => Promise<void>;
  signoutError: string;
}) {
  const { account, farms, farm, setFarm, owner, farmPath, device, setDevice, refresh } = useWorkspace();
  const cache = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [location.pathname]);
  useEffect(() => {
    if (!menu) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [menu]);
  const deviceQuery = useQuery({
    queryKey: ["devices", farm.id],
    queryFn: () => api<Device[]>(farmPath("/devices")),
    refetchInterval: refresh ? refresh * 1000 : false,
  });
  const devices = deviceQuery.isSuccess ? deviceQuery.data : [];
  // A notification opens a farm and device by link (?farm=&device=). It only selects: a farm this
  // account is not a member of is ignored, and the API checks access as on every request.
  // Each link is applied once: the navigation that removes its parameters commits later (as a
  // transition), and renders before that must not select again.
  const linkSearch = location.search;
  const appliedLink = useRef("");
  useEffect(() => {
    const params = new URLSearchParams(linkSearch);
    const linked = params.get("farm");
    if (!linked) {
      appliedLink.current = "";
      return;
    }
    if (appliedLink.current === linkSearch) return;
    if (linked !== farm.id && farms.some((f) => f.id === linked)) return setFarm(linked);
    appliedLink.current = linkSearch;
    const linkedDevice = params.get("device");
    if (linked === farm.id && linkedDevice) setDevice(linkedDevice);
    params.delete("farm");
    params.delete("device");
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [linkSearch, farm.id, farms, setFarm, setDevice, navigate, location.pathname]);
  // A notification clicked while BeeHave is open navigates this tab.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const open = (event: MessageEvent) => {
      const path = (event.data as { type?: string; path?: unknown } | null)?.path;
      if (event.data?.type === "beehave-navigate" && typeof path === "string" && path.startsWith("/")) navigate(path);
    };
    navigator.serviceWorker.addEventListener("message", open);
    return () => navigator.serviceWorker.removeEventListener("message", open);
  }, [navigate]);
  // Keep this browser's notifications linked to the current session.
  useEffect(() => {
    void resyncPush(account.id).catch(() => {});
  }, [account.id]);
  // A device that left the selected farm (or was deleted) is no longer selectable.
  const unknownDevice = !!device && deviceQuery.isSuccess && !devices.some((d) => d.id === device);
  useEffect(() => {
    if (unknownDevice) setDevice("");
  }, [unknownDevice, setDevice]);
  const selected =
    devices.find((station) => station.id === device) ?? devices[0];
  const title =
    destinations.find((d) =>
      d.to === "/"
        ? location.pathname === "/"
        : location.pathname.startsWith(d.to),
    )?.label ?? "Monitoring";
  return (
    <div className="app-shell">
      {menu && (
        <div
          className="sidebar-backdrop"
          aria-hidden="true"
          onClick={() => setMenu(false)}
        />
      )}
      <aside className={`sidebar ${menu ? "open" : ""}`}>
        <Link to="/" className="logo-link">
          <Logo />
        </Link>
        <div className="workspace-label">WORKSPACE</div>
        <nav aria-label="Main navigation">
          {destinations.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              onClick={() => setMenu(false)}
            >
              <Icon size={19} />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="account">
            <span className="avatar">
              {account.name
                .split(" ")
                .map((n) => n[0])
                .slice(0, 2)
                .join("")}
            </span>
            <div>
              <strong>{account.name}</strong>
              <small>
                {owner ? "Farm administrator" : "Farm viewer"}
              </small>
            </div>
            <button
              className="icon-button"
              aria-label="Sign out"
              onClick={logout}
            >
              <LogOut size={17} />
            </button>
          </div>
          {signoutError && (
            <p role="alert" className="form-error">
              {signoutError}
            </p>
          )}
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="Toggle navigation"
              onClick={() => setMenu(!menu)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <span>/</span>
            <strong>{title}</strong>
          </div>
          <div className="topbar-right">
            <span className="timezone">Asia/Manila (UTC+8)</span>
            <span className="divider" />
            <span className="farm-name">
              <Leaf size={16} />
              {farm.name}
            </span>
          </div>
        </header>
        <main id="main-content">
          {farm.demo && (
            <div className="demo-banner">
              <span>
                <strong>Sample workspace</strong>
                <span className="hide-small">
                  {" "}
                  · Synthetic detections and audio for exploring BeeHave.
                </span>
              </span>
              <Badge tone="amber">DEMO DATA</Badge>
            </div>
          )}
          <div className="context-row">
            <ScopeSelectors
              farms={farms} devices={devices} farmId={farm.id}
              deviceId={unknownDevice ? "" : device}
              onFarm={setFarm} onDevice={setDevice}
            />
            <div className="sync-meta">
              {selected ? (
                <>
                  <Badge tone={isOnline(selected) ? "green" : "gray"}>
                    {isOnline(selected) ? "Last report recent" : "Report stale"}
                  </Badge>
                  <span>Synced {ago(selected.lastSync)}</span>
                </>
              ) : (
                <span>No connected stations</span>
              )}
              <button
                className="icon-button"
                aria-label="Refresh monitoring data"
                onClick={() => cache.invalidateQueries()}
              >
                <RefreshCw
                  size={16}
                  className={deviceQuery.isFetching ? "spin" : ""}
                />
              </button>
            </div>
          </div>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/detections" element={<Detections />} />
            <Route
              path="/detections/:deviceId/:id"
              element={<DetectionDetail />}
            />
            <Route path="/recordings" element={<Recordings />} />
            <Route
              path="/recordings/:deviceId/:id"
              element={<RecordingDetail />}
            />
            <Route path="/devices" element={<Devices />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          <DetectionModalHost />
          <footer className="main-footer">
            <span>
              BeeHave <span className="muted">/</span> Bioacoustic monitoring
            </span>
            <span>Asia/Manila</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
