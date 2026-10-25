/** One-time import of the earlier local prototype. The source file is read-only. */
import SQLite from "better-sqlite3";
import { resolve } from "node:path";
import { openDatabase } from "../database";

const sourcePath = resolve(process.argv[2] ?? "data/beehave.sqlite");
const source = new SQLite(sourcePath, { readonly: true, fileMustExist: true });
const destination = openDatabase();
const tables = [
  "farms",
  "accounts",
  "sessions",
  "devices",
  "readings",
  "recordings",
  "detections",
] as const;

try {
  await destination.initialize();
  await destination.transaction(async (transaction) => {
    // Hold target tables exclusively so an account cannot be created mid-import.
    await transaction.execute(
      `LOCK TABLE ${tables.join(", ")} IN ACCESS EXCLUSIVE MODE`,
    );
    for (const table of tables) {
      const existing = await transaction.one(`SELECT 1 FROM ${table} LIMIT 1`);
      if (existing)
        throw new Error(
          `Target ${table} is not empty. Import cancelled; no data was changed.`,
        );
    }
    for (const table of tables) {
      let count = 0;
      for (const row of source
        .prepare(`SELECT * FROM ${table}`)
        .iterate() as Iterable<Record<string, unknown>>) {
        if (table === "farms") row.demo = Boolean(row.demo);
        const columns = Object.keys(row);
        const parameters = columns
          .map((_, index) => `$${index + 1}`)
          .join(", ");
        await transaction.execute(
          `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${parameters})`,
          Object.values(row),
        );
        count++;
      }
      console.log(`${table}: imported ${count} rows`);
    }
  });
  console.log(
    "Migration committed. Original SQLite file retained as a backup.",
  );
} finally {
  source.close();
  await destination.close();
}
