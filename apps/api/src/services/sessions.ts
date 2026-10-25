import { type Account, type FarmMembership } from "@beehave/shared";
import { type Request,type Response } from "express";
import { hashToken,newToken } from "../auth";
import type { DB } from "../database";
import { HttpError,type AccountRow } from "../types";
// The session token a request carries: the native app's bearer token, or the web cookie.
export function requestToken(req: Request) {
  return (
    req.headers.authorization?.replace(/^Bearer /, "") ??
    req.headers.cookie
      ?.split("; ")
      .find((c) => c.startsWith("beehave_session="))
      ?.slice(16)
  );
}
export function createSessionService(
  db: DB,
  memberships: (account: AccountRow) => Promise<FarmMembership[]>,
) {
  const accountQuery =
    "SELECT a.*, COALESCE(f.name,'') farm, COALESCE(f.demo,FALSE) demo FROM accounts a LEFT JOIN farms f ON f.id=a.farm_id";
  // farm and role describe the default (first) farm, so older clients keep their wording.
  const accountView = async (account: AccountRow): Promise<Account> => {
    const farms = await memberships(account);
    const first = farms[0];
    return {
      id: account.id,
      name: account.name,
      email: account.email,
      farm: first?.name ?? "",
      role: first?.role === "owner" ? "administrator" : "viewer",
      demo: !!account.demo,
      farmId: first?.id ?? "",
      farms,
    };
  };
  async function authenticate(req: Request) {
    const token = requestToken(req);
    if (!token) throw new HttpError(401, "Please sign in to continue.");
    const account = (await db.one(
      `${accountQuery} JOIN sessions s ON s.account_id=a.id WHERE s.hash=$1 AND s.expires>$2`,
      [hashToken(token), Date.now()],
    )) as AccountRow | undefined;
    if (!account)
      throw new HttpError(
        401,
        "Your session has expired. Please sign in again.",
      );
    return account;
  }
  const session = async (account: AccountRow, req: Request, res: Response) => {
    const token = newToken();
    await db.execute("DELETE FROM sessions WHERE expires < $1", [Date.now()]);
    await db.execute(
      "INSERT INTO sessions (hash, account_id, expires) VALUES($1,$2,$3)",
      [hashToken(token), account.id, Date.now() + 7 * 86400000],
    );
    res.cookie("beehave_session", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 7 * 86400000,
      path: "/",
    });
    return res.json({
      account: await accountView(account),
      ...(req.body?.platform === "native" ? { token } : {}),
    });
  };
  return { accountQuery, accountView, authenticate, session };
}
