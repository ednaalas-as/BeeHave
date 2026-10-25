import { withFarm, type Account, type FarmMembership } from "@beehave/shared";
import { createContext, useContext } from "react";
import { apiRequest } from "./api";

type FarmScope = {
  farm: FarmMembership;
  // Every farm this account is a member of, e.g. where a device can be transferred.
  farms: FarmMembership[];
  owner: boolean;
  // Farm-scoped paths name the selected farm; the API still checks membership on every call.
  farmPath: (path: string) => string;
  farmApi: typeof apiRequest;
};
const Context = createContext<FarmScope | null>(null);
export const FarmProvider = Context.Provider;
export function farmScope(farm: FarmMembership, farms: FarmMembership[]): FarmScope {
  return {
    farm,
    farms,
    owner: farm.role === "owner",
    farmPath: (path) => withFarm(path, farm.id),
    farmApi: (path, options) => apiRequest(withFarm(path, farm.id), options),
  };
}
export function useFarm() {
  const value = useContext(Context);
  if (!value) throw new Error("Missing farm");
  return value;
}
// Only server-confirmed memberships grant a selectable farm.
export const membershipsOf = (account: Account): FarmMembership[] => account.farms ?? [];
