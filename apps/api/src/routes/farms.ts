import type { FarmInvite, FarmMember, FarmMembership, FarmProfile, FarmRequest, FarmRole } from "@beehave/shared";
import { randomUUID } from "node:crypto";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { hashCode, newCode } from "../auth";
import type { RouteContext } from "../context";
import type { Queries } from "../database";
import { HttpError } from "../types";
const roleSchema = z.enum(["owner", "viewer"]);
// Optional; an empty location clears it.
const locationSchema = z.string().trim().max(200).optional().transform((value) => value || null);
// Locks the farm's memberships so two owners cannot both step down at once.
async function lockMember(tx: Queries, farm: string, account: string) {
  const rows = await tx.many<{ account_id: string; role: FarmRole }>(
    "SELECT account_id, role FROM farm_members WHERE farm_id=$1 FOR UPDATE",
    [farm],
  );
  const member = rows.find((row) => row.account_id === account);
  if (!member) throw new HttpError(404, "Member not found.");
  const lastOwner = member.role === "owner" && rows.filter((row) => row.role === "owner").length === 1;
  return { member, lastOwner };
}
// A farm always keeps an owner: the last one cannot leave, be removed or be demoted.
const lastOwnerError = () =>
  new HttpError(409, "A farm needs at least one owner. Make another member an owner first.");
export function registerFarmRoutes({ app, db, authenticate, farmScope, memberships, recordNotification, dispatchNotifications }: RouteContext) {
  const grantLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many access changes. Try again in 15 minutes." },
  });
  // Tight, so invite codes cannot be guessed by trying many.
  const inviteLimit = rateLimit({
    windowMs: 15 * 60000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "Too many invite code attempts. Try again in 15 minutes." },
  });
  app.get("/api/farms", async (req, res) => {
    res.json(await memberships(await authenticate(req)));
  });
  // Any account may start a farm of its own and becomes its owner (Administrator).
  app.post("/api/farms", grantLimit, async (req, res) => {
    const account = await authenticate(req);
    if (account.demo) throw new HttpError(403, "The sample account cannot create farms. Create your own BeeHave account.");
    const input = z.object({ name: z.string().trim().min(2).max(100), location: locationSchema }).parse(req.body);
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await tx.execute("INSERT INTO farms (id, name, location, demo) VALUES($1,$2,$3,FALSE)", [id, input.name, input.location]);
      await tx.execute(
        "INSERT INTO farm_members (farm_id, account_id, role, granted_by) VALUES($1,$2,'owner',$2)",
        [id, account.id],
      );
      // An account's first farm becomes the one it opens by default.
      await tx.execute("UPDATE accounts SET farm_id=$2 WHERE id=$1 AND farm_id IS NULL", [account.id, id]);
    });
    const farm: FarmMembership = { id, name: input.name, role: "owner", demo: false };
    res.status(201).json(farm);
  });
  // Joining needs a code an owner created for this purpose; knowing that a farm exists, or its
  // ID, never grants anything. Wrong, used, revoked and expired codes all answer alike.
  app.post("/api/farm-invites/redeem", inviteLimit, async (req, res) => {
    const account = await authenticate(req);
    if (account.demo) throw new HttpError(403, "The sample account cannot join farms. Create your own BeeHave account.");
    const input = z.object({ code: z.string().trim().min(6).max(40) }).parse(req.body);
    const farm = await db.transaction(async (tx) => {
      const invite = await tx.one<{ id: string; farm_id: string; role: FarmRole; name: string }>(
        `SELECT i.id, i.farm_id, i.role, f.name FROM farm_invites i JOIN farms f ON f.id=i.farm_id
        WHERE i.code_hash=$1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>NOW() AND NOT f.demo
        FOR UPDATE OF i`,
        [hashCode(input.code)],
      );
      if (!invite) throw new HttpError(404, "This invite code is not valid. It may be mistyped, used, revoked or expired.");
      if (await tx.one("SELECT 1 FROM farm_members WHERE farm_id=$1 AND account_id=$2", [invite.farm_id, account.id]))
        throw new HttpError(409, "You are already a member of this farm.");
      await tx.execute(
        `INSERT INTO farm_members (farm_id, account_id, role, granted_by)
        SELECT farm_id, $2, role, created_by FROM farm_invites WHERE id=$1`,
        [invite.id, account.id],
      );
      await tx.execute("UPDATE farm_invites SET used_by=$2, used_at=NOW() WHERE id=$1", [invite.id, account.id]);
      // A pending request to the same farm is answered by the invite.
      await tx.execute("DELETE FROM farm_access_requests WHERE farm_id=$1 AND account_id=$2", [invite.farm_id, account.id]);
      await tx.execute("UPDATE accounts SET farm_id=$2 WHERE id=$1 AND farm_id IS NULL", [account.id, invite.farm_id]);
      return { id: invite.farm_id, name: invite.name, role: invite.role, demo: false } as FarmMembership;
    });
    res.status(201).json(farm);
  });
  // An owner creates a single-use code for one person, with the role that person will get.
  app.post("/api/farms/:farm/invites", grantLimit, async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmScope(account, String(req.params.farm), "members");
    const input = z.object({ role: roleSchema.default("viewer") }).parse(req.body ?? {});
    const code = newCode();
    const row = await db.one<{ id: string; created_at: string; expires_at: string }>(
      `INSERT INTO farm_invites (id, code_hash, farm_id, role, created_by, expires_at)
      VALUES($1,$2,$3,$4,$5,NOW() + INTERVAL '7 days') RETURNING id, created_at, expires_at`,
      [randomUUID(), hashCode(code), farm.farmId, input.role, account.id],
    );
    if (!row) throw new HttpError(500, "The invite could not be created.");
    // The code itself is only ever shown in this response.
    const invite: FarmInvite & { code: string } = {
      id: row.id, role: input.role, createdBy: account.name, createdAt: row.created_at, expiresAt: row.expires_at, code,
    };
    res.status(201).json(invite);
  });
  app.post("/api/farms/:farm/invites/:invite/revoke", grantLimit, async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmScope(account, String(req.params.farm), "members");
    const revoked = await db.one(
      "UPDATE farm_invites SET revoked_at=NOW() WHERE id=$1 AND farm_id=$2 AND used_at IS NULL AND revoked_at IS NULL RETURNING id",
      [String(req.params.invite), farm.farmId],
    );
    if (!revoked) throw new HttpError(404, "Invite not found or already used.");
    res.json({ ok: true });
  });
  // Asking for access with the pairing code on a claimed Edge Device's label: whoever holds the
  // device can ask its farm's owners. Nothing is granted until an owner approves. Every outcome
  // (unknown or unclaimed code, sample farm, already a member, already asked) answers alike, so a
  // code reveals no farm or device. Only a new pending request notifies the owners.
  app.post("/api/device-access-requests", inviteLimit, async (req, res) => {
    const account = await authenticate(req);
    if (account.demo) throw new HttpError(403, "The sample account cannot request access. Create your own BeeHave account.");
    const input = z.object({ code: z.string().trim().min(6).max(40) }).parse(req.body);
    const event = await db.transaction(async (tx) => {
      const device = await tx.one<{ id: string; name: string; farm_id: string; farm: string }>(
        `SELECT d.id, d.name, d.farm_id, f.name farm FROM device_registry r JOIN devices d ON d.id=r.device_id
        JOIN farms f ON f.id=d.farm_id
        WHERE r.claim_code_hash=$1 AND r.status='claimed' AND d.disconnected_at IS NULL AND NOT f.demo`,
        [hashCode(input.code)],
      );
      if (!device) return null;
      if (await tx.one("SELECT 1 FROM farm_members WHERE farm_id=$1 AND account_id=$2", [device.farm_id, account.id])) return null;
      // A decided request may be asked again; a pending one stays as it is.
      const request = await tx.one<{ created_at: string }>(
        `INSERT INTO farm_access_requests (farm_id, account_id, status, device_id) VALUES($1,$2,'pending',$3)
        ON CONFLICT (farm_id, account_id) DO UPDATE SET status='pending', device_id=EXCLUDED.device_id,
          created_at=NOW(), decided_by=NULL, decided_at=NULL
        WHERE farm_access_requests.status<>'pending'
        RETURNING created_at`,
        [device.farm_id, account.id, device.id],
      );
      if (!request) return null;
      return recordNotification(tx, {
        kind: "access_request",
        dedupeKey: `access_request:${device.farm_id}:${account.id}:${request.created_at}`,
        farmId: device.farm_id,
        deviceId: device.id,
        actorAccountId: account.id,
        title: "New device access request",
        body: `${account.name} is requesting access to ${device.name} at ${device.farm}.`,
        target: { screen: "farm-requests", farmId: device.farm_id },
      });
    });
    if (event) void dispatchNotifications();
    res.status(202).json({ ok: true });
  });
  // An owner's decision on a pending request: approval makes the account a viewer of the whole
  // farm, never more.
  for (const decision of ["approve", "decline"] as const) {
    app.post(`/api/farms/:farm/requests/:account/${decision}`, grantLimit, async (req, res) => {
      const account = await authenticate(req);
      const farm = await farmScope(account, String(req.params.farm), "members");
      await db.transaction(async (tx) => {
        const request = await tx.one(
          "UPDATE farm_access_requests SET status=$3, decided_by=$4, decided_at=NOW() WHERE farm_id=$1 AND account_id=$2 AND status='pending' RETURNING account_id",
          [farm.farmId, String(req.params.account), decision === "approve" ? "approved" : "declined", account.id],
        );
        if (!request) throw new HttpError(404, "Request not found.");
        if (decision === "approve")
          await tx.execute(
            "INSERT INTO farm_members (farm_id, account_id, role, granted_by) VALUES($1,$2,'viewer',$3) ON CONFLICT DO NOTHING",
            [farm.farmId, String(req.params.account), account.id],
          );
      });
      res.json({ ok: true });
    });
  }
  app.get("/api/farms/:farm", async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmScope(account, String(req.params.farm), "view");
    const members = await db.many<{ account_id: string; name: string; email: string; role: FarmRole }>(
      `SELECT m.account_id, a.name, a.email, m.role FROM farm_members m JOIN accounts a ON a.id=m.account_id
      WHERE m.farm_id=$1 ORDER BY m.role='viewer', lower(a.name), a.id`,
      [farm.farmId],
    );
    const devices = await db.many<{ id: string; name: string }>(
      "SELECT id, name FROM devices WHERE farm_id=$1 ORDER BY name, id",
      [farm.farmId],
    );
    const requests = farm.role === "owner"
      ? await db.many<{ account_id: string; name: string; email: string; created_at: string; device: string | null }>(
          `SELECT r.account_id, a.name, a.email, r.created_at, d.name device FROM farm_access_requests r
          JOIN accounts a ON a.id=r.account_id LEFT JOIN devices d ON d.id=r.device_id AND d.farm_id=r.farm_id
          WHERE r.farm_id=$1 AND r.status='pending' ORDER BY r.created_at`,
          [farm.farmId],
        )
      : null;
    const invites = farm.role === "owner"
      ? await db.many<{ id: string; role: FarmRole; name: string; created_at: string; expires_at: string }>(
          `SELECT i.id, i.role, a.name, i.created_at, i.expires_at FROM farm_invites i JOIN accounts a ON a.id=i.created_by
          WHERE i.farm_id=$1 AND i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at>NOW() ORDER BY i.created_at`,
          [farm.farmId],
        )
      : null;
    const location = (await db.one<{ location: string | null }>("SELECT location FROM farms WHERE id=$1", [farm.farmId]))?.location ?? null;
    const profile: FarmProfile = {
      id: farm.farmId,
      name: farm.farmName,
      location,
      demo: farm.demo,
      role: farm.role,
      owners: members.filter((member) => member.role === "owner").map((member) => member.name),
      // Emails and the viewer list are for owners only.
      members: farm.role === "owner"
        ? members.map((member): FarmMember => ({
            accountId: member.account_id, name: member.name, email: member.email, role: member.role,
          }))
        : null,
      requests: requests?.map((request): FarmRequest => ({
        accountId: request.account_id, name: request.name, email: request.email, createdAt: request.created_at,
        deviceName: request.device,
      })) ?? null,
      invites: invites?.map((invite): FarmInvite => ({
        id: invite.id, role: invite.role, createdBy: invite.name, createdAt: invite.created_at, expiresAt: invite.expires_at,
      })) ?? null,
      devices,
    };
    res.json(profile);
  });
  app.post("/api/farms/:farm", async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmScope(account, String(req.params.farm), "members");
    const input = z.object({ name: z.string().trim().min(2).max(100), location: locationSchema }).parse(req.body);
    await db.execute("UPDATE farms SET name=$2, location=$3 WHERE id=$1", [farm.farmId, input.name, input.location]);
    res.json({ ok: true });
  });
  // Access is granted on purpose, by an owner, to an account that already exists.
  app.post("/api/farms/:farm/members", grantLimit, async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmScope(account, String(req.params.farm), "members");
    const input = z
      .object({ email: z.string().trim().email().max(254), role: roleSchema.default("viewer") })
      .parse(req.body);
    const email = input.email.toLowerCase();
    const member = email.endsWith("@beehave.local")
      ? undefined
      : await db.one<{ id: string; name: string; email: string }>(
          "SELECT id, name, email FROM accounts WHERE email=$1",
          [email],
        );
    if (!member)
      throw new HttpError(
        404,
        "No BeeHave account uses this email. Ask them to create a BeeHave account first, then add them here.",
      );
    const added = await db.one(
      `INSERT INTO farm_members (farm_id, account_id, role, granted_by) VALUES($1,$2,$3,$4)
      ON CONFLICT DO NOTHING RETURNING account_id`,
      [farm.farmId, member.id, input.role, account.id],
    );
    if (!added) throw new HttpError(409, "This account is already a member of this farm.");
    const view: FarmMember = { accountId: member.id, name: member.name, email: member.email, role: input.role };
    res.status(201).json(view);
  });
  app.post("/api/farms/:farm/members/:account/role", grantLimit, async (req, res) => {
    const account = await authenticate(req);
    const farm = await farmScope(account, String(req.params.farm), "members");
    const input = z.object({ role: roleSchema }).parse(req.body);
    await db.transaction(async (tx) => {
      const { member, lastOwner } = await lockMember(tx, farm.farmId, String(req.params.account));
      if (member.role === input.role) return;
      if (lastOwner) throw lastOwnerError();
      await tx.execute("UPDATE farm_members SET role=$3 WHERE farm_id=$1 AND account_id=$2", [
        farm.farmId, String(req.params.account), input.role,
      ]);
    });
    res.json({ ok: true });
  });
  // Owners remove anyone; any member may leave. Either way the farm keeps an owner.
  app.post("/api/farms/:farm/members/:account/remove", grantLimit, async (req, res) => {
    const account = await authenticate(req);
    const self = String(req.params.account) === account.id;
    const farm = await farmScope(account, String(req.params.farm), self ? "view" : "members");
    z.object({ confirm: z.literal(true) }).parse(req.body);
    await db.transaction(async (tx) => {
      if ((await lockMember(tx, farm.farmId, String(req.params.account))).lastOwner) throw lastOwnerError();
      await tx.execute("DELETE FROM farm_members WHERE farm_id=$1 AND account_id=$2", [
        farm.farmId, String(req.params.account),
      ]);
    });
    res.json({ ok: true });
  });
}
