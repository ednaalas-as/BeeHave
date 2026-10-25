import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { acceptSession, clearSession } from "../src/query-client";
import type { Session } from "@beehave/shared";

test("password sign-out keeps the session observer connected to the next login", async () => {
  const client = new QueryClient();
  const oldSession = { account: { id: "account-1" } };
  const newSession = { account: { id: "account-1" }, token: "new-session" };
  client.setQueryData(["session"], oldSession);
  client.setQueryData(["farms", "account-1"], [{ id: "farm-1" }]);
  const observer = new QueryObserver(client, {
    queryKey: ["session"], enabled: false,
  });
  const seen: unknown[] = [];
  const unsubscribe = observer.subscribe((result) => seen.push(result.data));
  try {
    await clearSession(client);
    assert.equal(observer.getCurrentResult().data, null);
    assert.equal(client.getQueryData(["farms", "account-1"]), undefined);
    client.setQueryData(["session"], newSession);
    assert.deepEqual(seen, [null, newSession]);
    assert.deepEqual(observer.getCurrentResult().data, newSession);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("sign-out cancels an old session request before publishing signed-out state", async () => {
  const client = new QueryClient();
  let finish!: (value: unknown) => void;
  const pending = client.fetchQuery({
    queryKey: ["session"],
    queryFn: () => new Promise((resolve) => { finish = resolve; }),
  }).catch(() => undefined);
  await clearSession(client);
  finish({ account: { id: "old-account" } });
  await pending;
  assert.equal(client.getQueryData(["session"]), null);
  client.clear();
});

test("login notifies the recovery screen even when it only reads isPending", () => {
  const client = new QueryClient();
  client.setQueryData(["session"], null);
  const observer = new QueryObserver(client, {
    queryKey: ["session"], enabled: false,
    notifyOnChangeProps: ["data", "isPending"],
  });
  // App returns the recovery form before reading data. React Query tracks
  // only isPending in that render unless notifications are explicit.
  assert.equal(observer.trackResult(observer.getCurrentResult()).isPending, false);
  let updates = 0;
  const unsubscribe = observer.subscribe(() => { updates += 1; });
  try {
    client.setQueryData(["session"], { account: { id: "recovered-account" } });
    assert.equal(updates, 1);
  } finally {
    unsubscribe();
    client.clear();
  }
});

test("successful login makes memberships available before notifying the dashboard", async () => {
  const client = new QueryClient();
  const session = {
    account: {
      id: "recovered-account", name: "Test", email: "test@example.com",
      farm: "Test farm", farmId: "farm-1", role: "administrator", demo: false,
      farms: [{ id: "farm-1", name: "Test farm", role: "owner", demo: false }],
    },
  } satisfies Session;
  client.setQueryData(["session"], null);
  client.setQueryData(["summary", "old-farm"], { private: true });
  let finish!: (value: unknown) => void;
  const oldRequest = client.fetchQuery({
    queryKey: ["farms", session.account.id],
    queryFn: () => new Promise((resolve) => { finish = resolve; }),
  }).catch(() => undefined);
  const observer = new QueryObserver(client, { queryKey: ["session"], enabled: false });
  let entered = false;
  const unsubscribe = observer.subscribe((result) => {
    if (!result.data) return;
    entered = true;
    assert.deepEqual(client.getQueryData(["farms", session.account.id]), session.account.farms);
  });
  try {
    await acceptSession(client, session);
    finish([]);
    await oldRequest;
    assert.equal(entered, true);
    assert.equal(client.getQueryData(["summary", "old-farm"]), undefined);
    assert.deepEqual(client.getQueryData(["farms", session.account.id]), session.account.farms);
  } finally {
    unsubscribe();
    client.clear();
  }
});
