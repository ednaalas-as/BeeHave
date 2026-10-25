import { createApi,manilaDate,withFarm,type Account,type FarmMembership } from "@beehave/shared";
import { createContext,useContext,useState,type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { FarmAccess } from "./components/FarmAccess";
import { ScopeSelectors } from "./components/ScopeSelectors";
export const api = createApi();
const Context = createContext<{
  account: Account;
  farms: FarmMembership[];
  // The selected farm decides every farm-scoped request and cache key.
  farm: FarmMembership;
  setFarm: (id: string) => void;
  owner: boolean;
  farmPath: (path: string) => string;
  // The API client for farm-scoped requests: every call names the selected farm.
  farmApi: typeof api;
  device: string;
  setDevice: (id: string) => void;
  refresh: number;
  setRefresh: (n: number) => void;
} | null>(null);
const farmStorageKey = (account: Account) => `beehave.farm.${account.id}`;
function storedFarm(account: Account) {
  try {
    return localStorage.getItem(farmStorageKey(account));
  } catch {
    return null;
  }
}
export function WorkspaceProvider({
  account,
  logout,
  children,
}: {
  account: Account;
  logout: () => void;
  children: ReactNode;
}) {
  const membershipQuery = useQuery({
    queryKey: ["farms", account.id],
    queryFn: () => api<FarmMembership[]>("/farms"),
    refetchInterval: 15_000,
  });
  const farms = membershipQuery.isSuccess ? membershipQuery.data : [];
  const [chosen, setChosen] = useState(() => storedFarm(account));
  // A farm the account no longer belongs to falls back to its default farm.
  const farm =
    farms.find((f) => f.id === chosen) ??
    farms.find((f) => f.id === account.farmId) ??
    farms[0];
  const [deviceChoice, setDevice] = useState({ farm: farm?.id, device: "" });
  // A device selection belongs to the farm it was made in.
  const device = deviceChoice.farm === farm?.id ? deviceChoice.device : "";
  const [refresh, setRefreshState] = useState(() =>
    Number(localStorage.getItem("beehave.refresh") ?? 30),
  );
  const setRefresh = (n: number) => {
    localStorage.setItem("beehave.refresh", String(n));
    setRefreshState(n);
  };
  const setFarm = (id: string) => {
    try {
      localStorage.setItem(farmStorageKey(account), id);
    } catch {
      // The choice still applies for this visit.
    }
    setChosen(id);
    setDevice({ farm: id, device: "" });
  };
  if (!farm)
    return <NoFarm account={account} logout={logout} loaded={membershipQuery.isSuccess} opened={(id) => setFarm(id)} />;
  return (
    <Context.Provider
      value={{
        account,
        farms,
        farm,
        setFarm,
        owner: farm.role === "owner",
        farmPath: (path) => withFarm(path, farm.id),
        farmApi: (path, options) => api(withFarm(path, farm.id), options),
        device,
        setDevice: (id) => setDevice({ farm: farm.id, device: id }),
        refresh,
        setRefresh,
      }}
    >
      {children}
    </Context.Provider>
  );
}
// No farm yet: the account creates one or joins one with an invite code, right here.
function NoFarm({ account, logout, loaded, opened }: { account: Account; logout: () => void; loaded: boolean; opened: (id: string) => void }) {
  return (
    <div className="loading no-farm" role="status">
      <ScopeSelectors farms={[]} devices={[]} farmId="" deviceId="" onFarm={() => {}} onDevice={() => {}} />
      This account is not a member of any farm yet.
      {loaded && !account.demo && <FarmAccess accountId={account.id} opened={(farm) => opened(farm.id)} />}
      <button className="button secondary" onClick={logout}>Sign out</button>
    </div>
  );
}
export function useWorkspace() {
  const value = useContext(Context);
  if (!value) throw new Error("Missing workspace");
  return value;
}
export function periodRange(days: number) {
  return {
    from: manilaDate(new Date(Date.now() - (days - 1) * 86400000)),
    to: manilaDate(),
  };
}
export function queryString(values: Record<string, string | number>) {
  return new URLSearchParams(
    Object.entries(values).map(([k, v]) => [k, String(v)]),
  ).toString();
}
