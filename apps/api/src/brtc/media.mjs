import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve, sep } from "node:path";

const fingerprint = (stat) =>
  [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]
    .map(String)
    .join(":");

/** Revalidate canonical objects at startup before the API trusts their DB records. */
export function createMedia({ pool, root }) {
  async function initialize() {
    const base = await realpath(root);
    const assets = (await pool.query("SELECT * FROM canonical_assets")).rows;
    for (const asset of assets) {
      let file;
      try {
        const path = resolve(base, asset.storage_key);
        if (!path.startsWith(base + sep) || (await realpath(path)) !== path)
          continue;
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await file.stat();
        const expectedLength = Number(asset.actual_byte_length);
        if (!before.isFile() || before.size !== expectedLength) continue;
        const digest = createHash("sha256");
        for await (const chunk of file.createReadStream({
          highWaterMark: 65536,
          autoClose: false,
        })) digest.update(chunk);
        const after = await file.stat();
        if (
          fingerprint(before) !== fingerprint(after) ||
          digest.digest("hex") !== asset.sha256
        ) {
          console.error("BRTC_CANONICAL_ASSET_INTEGRITY_FAILURE", asset.asset_id);
        }
      } catch {
        // An unavailable or invalid canonical object will remain unavailable at playback.
      } finally {
        await file?.close();
      }
    }
  }
  return { initialize };
}
