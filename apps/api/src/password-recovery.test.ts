import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { createApp } from "./app";
import { hashToken } from "./auth";
import { openDatabase } from "./database";

// The email boundary is the Resend HTTP call; it is stubbed so no real email is sent.
const RESEND = "https://api.resend.com/";
const realFetch = globalThis.fetch;
const sent: { authorization: string; to: string[]; text: string }[] = [];
let providerStatus = 200;
let deliveryDelay = 0;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith(RESEND)) return realFetch(input, init);
  const body = JSON.parse(String(init?.body));
  sent.push({
    authorization: new Headers(init?.headers).get("authorization") ?? "",
    to: body.to,
    text: body.text,
  });
  if (deliveryDelay) await new Promise((r) => setTimeout(r, deliveryDelay));
  return new Response('{"id":"stub"}', { status: providerStatus });
}) as typeof fetch;

const logged: string[] = [];
for (const level of ["log", "info", "warn", "error"] as const) {
  const original = console[level];
  console[level] = (...args: unknown[]) => {
    logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" "));
    original(...args);
  };
}

const apiKey = "re_test_" + randomBytes(16).toString("hex");
const responses: string[] = [];
const cleanups: (() => Promise<void>)[] = [];

beforeEach(() => {
  process.env.RESEND_API_KEY = apiKey;
  process.env.PASSWORD_RESET_EMAIL_FROM = "BeeHave <no-reply@staging.example.test>";
  process.env.APP_PUBLIC_URL = "https://staging.example.test";
  delete process.env.DISABLE_REGISTRATION;
  sent.length = 0;
  providerStatus = 200;
  deliveryDelay = 0;
});
after(async () => {
  for (const cleanup of cleanups) await cleanup();
  globalThis.fetch = realFetch;
});

async function start() {
  const schema = "beehave_test_" + randomUUID().replaceAll("-", "");
  const administrator = openDatabase();
  await administrator.execute(`CREATE SCHEMA ${schema}`);
  const { app, db } = await createApp(schema);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  cleanups.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.close();
    await administrator.execute(`DROP SCHEMA ${schema} CASCADE`);
    await administrator.close();
  });
  const base = `http://127.0.0.1:${address.port}/api`;
  async function post(path: string, body: unknown, token?: string) {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    responses.push(text);
    return { status: response.status, text, json: () => JSON.parse(text) };
  }
  async function me(token: string) {
    return (await fetch(base + "/auth/me", { headers: { Authorization: `Bearer ${token}` } })).status;
  }
  async function login(email: string, password: string) {
    return post("/auth/login", { email, password, platform: "native" });
  }
  async function register(email: string, password: string) {
    return post("/auth/register", { name: "Test farmer", farm: "Test farm", email, password, platform: "native" });
  }
  function lastToken() {
    const match = sent.at(-1)?.text.match(/#reset=([a-f0-9]{64})/);
    assert(match, "recovery email carries the token in the URL fragment");
    return match[1];
  }
  return { db, post, me, login, register, lastToken };
}

test("registration can be disabled without affecting existing-account login", async () => {
  const s = await start();
  assert.equal((await s.register("existing@example.com", "an-existing-password")).status, 200);
  process.env.DISABLE_REGISTRATION = "true";
  const blocked = await s.register("stranger@example.com", "a-stranger-password");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json().error, "Account registration is disabled.");
  assert.equal(
    (await s.db.one<{ n: string }>("SELECT count(*) AS n FROM accounts WHERE email=$1", ["stranger@example.com"]))?.n,
    "0",
  );
  const loggedIn = await s.login("existing@example.com", "an-existing-password");
  assert.equal(loggedIn.status, 200);
  assert.equal(await s.me(loggedIn.json().token), 200);
  assert.equal((await s.login("existing@example.com", "a-wrong-password")).status, 401);
});

test("recover gives the same answer whether or not the account exists", async () => {
  const s = await start();
  await s.register("farmer@example.com", "the-original-password");
  const known = await s.post("/auth/recover", { email: "farmer@example.com" });
  const unknown = await s.post("/auth/recover", { email: "nobody@example.com" });
  assert.equal(known.status, 200);
  assert.equal(unknown.status, known.status);
  assert.equal(unknown.text, known.text);
  assert.equal(sent.length, 1, "only the real account gets an email");
  assert.deepEqual(sent[0].to, ["farmer@example.com"]);
  assert.equal(sent[0].authorization, `Bearer ${apiKey}`);
});

test("recover response time does not depend on whether the account exists", async () => {
  const s = await start();
  await s.register("farmer@example.com", "the-original-password");
  deliveryDelay = 400; // a slow email provider
  const time = async (email: string) => {
    const t0 = performance.now();
    await s.post("/auth/recover", { email });
    return performance.now() - t0;
  };
  const known = await time("farmer@example.com");
  const unknown = await time("nobody@example.com");
  assert(
    Math.abs(known - unknown) < 200,
    `existing account took ${known.toFixed(0)} ms, unknown took ${unknown.toFixed(0)} ms`,
  );
});

test("only the token hash is stored, and reset changes exactly that account's password", async () => {
  const s = await start();
  const first = await s.register("farmer@example.com", "the-original-password");
  await s.register("neighbour@example.com", "the-neighbour-password");
  const oldSession = first.json().token as string;
  await s.post("/auth/recover", { email: "farmer@example.com" });
  const token = s.lastToken();
  const rows = await s.db.many<Record<string, unknown>>("SELECT * FROM password_reset_tokens");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].token_hash, hashToken(token));
  assert(!JSON.stringify(rows).includes(token), "plaintext token is not stored");

  assert.equal((await s.post("/auth/reset", { token, password: "a-brand-new-password" })).status, 200);
  assert.equal((await s.login("farmer@example.com", "the-original-password")).status, 401);
  assert.equal((await s.login("farmer@example.com", "a-brand-new-password")).status, 200);
  assert.equal(await s.me(oldSession), 401, "existing sessions are revoked");
  assert.equal((await s.login("neighbour@example.com", "the-neighbour-password")).status, 200);
  assert.equal(
    (await s.db.many("SELECT * FROM password_reset_tokens")).length,
    0,
  );

  const reused = await s.post("/auth/reset", { token, password: "yet-another-password" });
  assert.equal(reused.status, 400, "tokens are single-use");
  assert.equal((await s.login("farmer@example.com", "a-brand-new-password")).status, 200);
});

test("invalid, superseded and expired tokens are rejected", async () => {
  const s = await start();
  await s.register("farmer@example.com", "the-original-password");
  assert.equal((await s.post("/auth/reset", { token: randomBytes(32).toString("hex"), password: "a-brand-new-password" })).status, 400);
  assert.equal((await s.post("/auth/reset", { token: "not-a-token", password: "a-brand-new-password" })).status, 400);

  await s.post("/auth/recover", { email: "farmer@example.com" });
  const superseded = s.lastToken();
  await s.post("/auth/recover", { email: "farmer@example.com" });
  const current = s.lastToken();
  assert.equal((await s.post("/auth/reset", { token: superseded, password: "a-brand-new-password" })).status, 400);

  await s.db.execute("UPDATE password_reset_tokens SET expires=$1", [Date.now() - 1]);
  const expired = await s.post("/auth/reset", { token: current, password: "a-brand-new-password" });
  assert.equal(expired.status, 400);
  assert.equal(expired.json().error, "This password reset link is invalid or expired.");
  assert.equal((await s.login("farmer@example.com", "the-original-password")).status, 200);
});

test("recovery fails safely when email is not configured or delivery fails", async () => {
  const s = await start();
  await s.register("farmer@example.com", "the-original-password");
  delete process.env.RESEND_API_KEY;
  const known = await s.post("/auth/recover", { email: "farmer@example.com" });
  const unknown = await s.post("/auth/recover", { email: "nobody@example.com" });
  assert.equal(known.status, 503);
  assert.equal(unknown.text, known.text);
  assert.equal(sent.length, 0);
  assert.equal((await s.db.many("SELECT * FROM password_reset_tokens")).length, 0);

  process.env.RESEND_API_KEY = apiKey;
  providerStatus = 500;
  const failed = await s.post("/auth/recover", { email: "farmer@example.com" });
  assert.equal(failed.status, 200, "delivery failure is not revealed");
  const reference = await s.post("/auth/recover", { email: "nobody@example.com" });
  assert.equal(failed.text, reference.text);
  assert.equal((await s.db.many("SELECT * FROM password_reset_tokens")).length, 0, "undelivered token is removed");
});

test("recover and reset stay rate limited", async () => {
  const s = await start();
  for (let i = 0; i < 5; i++) assert.equal((await s.post("/auth/recover", { email: `n${i}@example.com` })).status, 200);
  assert.equal((await s.post("/auth/recover", { email: "n6@example.com" })).status, 429);
  const r = await start();
  for (let i = 0; i < 40; i++) await r.post("/auth/reset", { token: randomBytes(32).toString("hex"), password: "a-brand-new-password" });
  assert.equal((await r.post("/auth/reset", { token: randomBytes(32).toString("hex"), password: "a-brand-new-password" })).status, 429);
});

test("no API key, password, hash or reset token appears in responses or logs", async () => {
  const s = await start();
  await s.register("farmer@example.com", "the-original-password");
  providerStatus = 500;
  await s.post("/auth/recover", { email: "farmer@example.com" });
  const failedToken = s.lastToken();
  providerStatus = 200;
  await s.post("/auth/recover", { email: "farmer@example.com" });
  const token = s.lastToken();
  await s.post("/auth/reset", { token, password: "a-brand-new-password" });
  const hash = (await s.db.one<{ password: string }>("SELECT password FROM accounts WHERE email=$1", ["farmer@example.com"]))!.password;
  const secrets = [apiKey, token, hashToken(token), failedToken, hashToken(failedToken), "the-original-password", "a-brand-new-password", hash, hash.split(":")[1]];
  const outputs = [...responses, ...logged].join("\n");
  for (const secret of secrets) assert(!outputs.includes(secret), "a secret value leaked into a response or log");
});
