import { QueryCache,QueryClient } from "@tanstack/react-query";
import type { Session } from "@beehave/shared";

export async function acceptSession(client: QueryClient, session: Session) {
  // Requests from the old session must not overwrite a successful sign-in.
  await client.cancelQueries();
  client.removeQueries({
    predicate: (query) => query.queryKey[0] !== "session",
  });
  // Login already returns memberships; don't block the dashboard on /farms.
  if (session.account.farms) {
    client.setQueryData(["farms", session.account.id], session.account.farms);
  }
  client.setQueryData(["session"], session);
}

export async function clearSession(client: QueryClient) {
  // Keep the session query attached to App's observer across sign-out/sign-in.
  // Cancel old requests first so they cannot restore the previous session.
  await client.cancelQueries();
  client.removeQueries({
    predicate: (query) => query.queryKey[0] !== "session",
  });
  client.setQueryData(["session"], null);
}

export const queryClient: QueryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      if (
        (error as { status?: number }).status === 401 &&
        query.queryKey[0] !== "session"
      ) {
        void clearSession(queryClient);
      }
    },
  }),
  defaultOptions: { queries: { retry: 1, staleTime: 15000 } },
});
