import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { checkPassword, hashPassword, hashToken, newToken } from "../auth";
import type { RouteContext } from "../context";
import { ensureDemo } from "../demo";
import {
  passwordResetEmailConfigured,
  sendPasswordResetEmail,
} from "../password-reset-email";
import { HttpError, type AccountRow } from "../types";
export function registerAuthRoutes(context: RouteContext) {
  const { app, db, accountQuery, accountView, authenticate, session } = context;
  const authLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 40,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many attempts. Try again in 15 minutes." },
  });
  const recoveryLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many recovery requests. Try again in 15 minutes." },
  });
  app.post("/api/auth/register", authLimit, async (req, res) => {
    if (process.env.DISABLE_REGISTRATION === "true")
      throw new HttpError(403, "Account registration is disabled.");
    const input = z
      .object({
        name: z.string().trim().min(2).max(100),
        email: z.string().trim().email().max(254),
        password: z.string().min(12).max(128),
        // Optional for older clients; sign-up forms no longer ask for it.
        farm: z.string().trim().min(2).max(100).optional(),
      })
      .parse(req.body);
    const email = input.email.toLowerCase();
    if (email.endsWith("@beehave.local"))
      throw new HttpError(400, "Use your own email address.");
    if (await db.one("SELECT id FROM accounts WHERE email=$1", [email]))
      throw new HttpError(409, "An account already exists with this email.");
    const id = randomUUID();
    // A new account has no farm: it creates one or joins one with an invite code afterwards.
    // Older clients that still send a farm name get that farm created and owned, as before.
    const farm = input.farm ? randomUUID() : null;
    await db.transaction(async (transaction) => {
      if (farm)
        await transaction.execute(
          "INSERT INTO farms (id, name, demo) VALUES($1,$2,FALSE)",
          [farm, input.farm],
        );
      await transaction.execute(
        "INSERT INTO accounts (id, farm_id, name, email, password, role) VALUES($1,$2,$3,$4,$5,$6)",
        [
          id,
          farm,
          input.name,
          email,
          hashPassword(input.password),
          "administrator",
        ],
      );
      if (farm)
        await transaction.execute(
          "INSERT INTO farm_members (farm_id, account_id, role) VALUES($1,$2,'owner')",
          [farm, id],
        );
    });
    return await session(
      (await db.one(`${accountQuery} WHERE a.id=$1`, [id])) as AccountRow,
      req,
      res,
    );
  });
  app.post("/api/auth/login", authLimit, async (req, res) => {
    const input = z
      .object({ email: z.string().email(), password: z.string().max(128) })
      .parse(req.body);
    const account = (await db.one(`${accountQuery} WHERE email=$1`, [
      input.email.toLowerCase(),
    ])) as AccountRow | undefined;
    if (!account || !checkPassword(input.password, account.password))
      throw new HttpError(401, "Email or password is incorrect.");
    return await session(account, req, res);
  });
  app.post("/api/auth/recover", recoveryLimit, async (req, res) => {
    const input = z
      .object({ email: z.string().trim().email().max(254) })
      .parse(req.body);
    if (!passwordResetEmailConfigured()) {
      throw new HttpError(503, "Password recovery email is not configured.");
    }

    const account = await db.one<{ id: string; email: string }>(
      "SELECT a.id, a.email FROM accounts a LEFT JOIN farms f ON f.id=a.farm_id WHERE a.email=$1 AND f.demo IS NOT TRUE",
      [input.email.toLowerCase()],
    );
    if (account) {
      const token = newToken();
      const expires = Date.now() + 30 * 60 * 1000;
      await db.transaction(async (transaction) => {
        await transaction.execute(
          "DELETE FROM password_reset_tokens WHERE account_id=$1 OR expires<=$2",
          [account.id, Date.now()],
        );
        await transaction.execute(
          "INSERT INTO password_reset_tokens(token_hash, account_id, expires) VALUES($1,$2,$3)",
          [hashToken(token), account.id, expires],
        );
      });
      // Send after responding so response time does not reveal whether the
      // account exists.
      void sendPasswordResetEmail(account.email, token).catch(async (error) => {
        console.error("Could not send password recovery email:", error);
        await db
          .execute("DELETE FROM password_reset_tokens WHERE token_hash=$1", [
            hashToken(token),
          ])
          .catch(() => {});
      });
    }
    res.json({
      ok: true,
      message: "If an account uses that email, a recovery link will be sent.",
    });
  });
  app.post("/api/auth/reset", authLimit, async (req, res) => {
    const input = z
      .object({
        token: z.string().regex(/^[a-f0-9]{64}$/),
        password: z.string().min(12).max(128),
      })
      .parse(req.body);
    await db.transaction(async (transaction) => {
      const reset = await transaction.one<{ account_id: string }>(
        "DELETE FROM password_reset_tokens WHERE token_hash=$1 AND expires>$2 RETURNING account_id",
        [hashToken(input.token), Date.now()],
      );
      if (!reset)
        throw new HttpError(
          400,
          "This password reset link is invalid or expired.",
        );
      await transaction.execute("UPDATE accounts SET password=$1 WHERE id=$2", [
        hashPassword(input.password),
        reset.account_id,
      ]);
      await transaction.execute("DELETE FROM sessions WHERE account_id=$1", [
        reset.account_id,
      ]);
      await transaction.execute(
        "DELETE FROM password_reset_tokens WHERE account_id=$1",
        [reset.account_id],
      );
    });
    res.json({ ok: true });
  });
  app.post("/api/auth/demo", authLimit, async (req, res) => {
    if (process.env.DISABLE_DEMO === "true")
      throw new HttpError(403, "Sample workspace is disabled.");
    const id = await ensureDemo(db);
    return await session(
      (await db.one(`${accountQuery} WHERE a.id=$1`, [id])) as AccountRow,
      req,
      res,
    );
  });
  app.get("/api/auth/me", async (req, res) =>
    res.json({ account: await accountView(await authenticate(req)) }),
  );
  app.post("/api/auth/logout", async (req, res) => {
    const account = await authenticate(req);
    const token =
      req.headers.authorization?.replace(/^Bearer /, "") ??
      req.headers.cookie
        ?.split("; ")
        .find((c) => c.startsWith("beehave_session="))
        ?.slice(16);
    await db.execute("DELETE FROM sessions WHERE hash=$1 AND account_id=$2", [
      hashToken(token ?? ""),
      account.id,
    ]);
    res.clearCookie("beehave_session", { path: "/" });
    res.json({ ok: true });
  });
  // Name and email of the signed-in account. Changing the email (used to sign in and to recover
  // the account) needs the current password, so a borrowed session cannot take the account over.
  app.post("/api/auth/profile", authLimit, async (req, res) => {
    const account = await authenticate(req);
    if (account.demo)
      throw new HttpError(403, "Sample accounts are read-only.");
    const input = z
      .object({
        name: z.string().trim().min(2).max(100),
        email: z.string().trim().email().max(254),
        currentPassword: z.string().max(128).optional(),
      })
      .parse(req.body);
    const email = input.email.toLowerCase();
    if (email !== account.email) {
      if (email.endsWith("@beehave.local"))
        throw new HttpError(400, "Use your own email address.");
      if (!input.currentPassword || !checkPassword(input.currentPassword, account.password))
        throw new HttpError(400, "Enter your current password to change your email.");
      if (await db.one("SELECT id FROM accounts WHERE email=$1 AND id<>$2", [email, account.id]))
        throw new HttpError(409, "An account already exists with this email.");
    }
    await db.execute("UPDATE accounts SET name=$2, email=$3 WHERE id=$1", [account.id, input.name, email]);
    res.json({ account: await accountView((await db.one(`${accountQuery} WHERE a.id=$1`, [account.id])) as AccountRow) });
  });
  app.post("/api/auth/password", authLimit, async (req, res) => {
    const account = await authenticate(req);
    if (account.demo)
      throw new HttpError(403, "Sample accounts are read-only.");
    const input = z
      .object({
        currentPassword: z.string().max(128),
        password: z.string().min(12).max(128),
      })
      .parse(req.body);
    if (!checkPassword(input.currentPassword, account.password))
      throw new HttpError(400, "Current password is incorrect.");
    await db.transaction(async (transaction) => {
      await transaction.execute("UPDATE accounts SET password=$1 WHERE id=$2", [
        hashPassword(input.password),
        account.id,
      ]);
      await transaction.execute("DELETE FROM sessions WHERE account_id=$1", [
        account.id,
      ]);
    });
    res.clearCookie("beehave_session", { path: "/" });
    res.json({ ok: true });
  });
}
