import { hashPassword } from "./auth";
import { openDatabase } from "./database";
const email = process.argv[2];
const password = process.env.BEEHAVE_NEW_PASSWORD;
if (!email || !password || password.length < 12) {
  console.error(
    "Set BEEHAVE_NEW_PASSWORD to at least 12 characters and run: npm run reset-password -w @beehave/api -- email@example.com",
  );
  process.exit(1);
}
const db = openDatabase();
const account = (await db.one("SELECT id FROM accounts WHERE email=$1", [
  email.toLowerCase(),
])) as
  | {
      id: string;
    }
  | undefined;
if (!account) {
  console.error("Account not found.");
  process.exit(1);
}
await db.transaction(async (transaction) => {
  await transaction.execute("UPDATE accounts SET password=$1 WHERE id=$2", [
    hashPassword(password),
    account.id,
  ]);
  await transaction.execute("DELETE FROM sessions WHERE account_id=$1", [
    account.id,
  ]);
});
await db.close();
console.log("Password changed; all sessions revoked.");
