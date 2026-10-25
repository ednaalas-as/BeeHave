import { readFile } from "node:fs/promises";
import { Pool,type PoolClient,type QueryResultRow,types } from "pg";
import { canonicalTimestamp } from "./timestamp";

// API responses use UTC strings, including timestamps read from PostgreSQL.
types.setTypeParser(1184, canonicalTimestamp);

export class Queries {
  constructor(private connection: Pool | PoolClient) {}

  async many<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<Row[]> {
    const result = await this.connection.query<Row>(sql, values);
    return result.rows;
  }

  async one<Row extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<Row | undefined> {
    return (await this.many<Row>(sql, values))[0];
  }

  async execute(sql: string, values: unknown[] = []): Promise<void> {
    await this.connection.query(sql, values);
  }
}

export class Database extends Queries {
  constructor(private pool: Pool, private isolatedSchema = false) {
    super(pool);
  }

  async initialize() {
    const schema = await readFile(
      new URL("./database/schema.sql", import.meta.url),
      "utf8",
    );
    const brtcMarker = "-- BRTC storage is isolated in its own PostgreSQL schema.";
    const [coreSchema] = schema.split(brtcMarker);
    await this.transaction(async (transaction) => {
      // Two development servers may start together. Only one creates tables at a time.
      await transaction.execute("SELECT pg_advisory_xact_lock(246813579)");
      await transaction.execute(this.isolatedSchema ? coreSchema : schema);
      if (!this.isolatedSchema) {
        await transaction.execute(await readFile(
          new URL("./database/migrations/001-brtc-crosswalk.sql", import.meta.url),
          "utf8",
        ));
      }
    });
  }

  async transaction<T>(work: (transaction: Queries) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(new Queries(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  close() {
    return this.pool.end();
  }
}

export function openDatabase(schema?: string) {
  if (schema && !/^beehave_test_[a-f0-9]+$/.test(schema)) {
    throw new Error("Only generated test schema names are allowed.");
  }
  return new Database(
    new Pool({
      connectionString: process.env.DATABASE_URL,
      host: process.env.PGHOST ?? "localhost",
      database: process.env.PGDATABASE ?? "beehave",
      ...(schema ? { options: `-c search_path=${schema}` } : {}),
    }),
    !!schema,
  );
}
export type DB = Database;
