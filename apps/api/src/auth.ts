import {
createHash,
randomBytes,
randomInt,
scryptSync,
timingSafeEqual,
} from "node:crypto";
export const hashToken = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("hex");
// Short codes people type or read aloud (invites, device pairing): no 0/O or 1/I/L, in groups of
// five. Ten characters is about 50 bits; codes are rate limited, single-use and stored hashed.
const codeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const newCode = () => {
  const chars = Array.from({ length: 10 }, () => codeAlphabet[randomInt(codeAlphabet.length)]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
};
// Spaces, dashes and lower case are forgiven, so the hash matches however the code was typed.
export const hashCode = (code: string) =>
  hashToken(code.toUpperCase().replace(/[^A-Z0-9]/g, ""));
export function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function checkPassword(password: string, stored: string) {
  const [salt, hash] = stored.split(":");
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
