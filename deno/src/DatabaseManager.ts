/**
 * DatabaseManager — Deno edition.
 *
 * Identical public interface to the Node.js version; the only internal
 * difference is that `sqlite3` (native Node addon) is replaced by
 * `jsr:@db/sqlite`, which uses Deno's FFI SQLite bindings and compiles
 * cleanly into a `deno compile` binary.
 */

// @ts-ignore — jsr:@db/sqlite types are resolved via the import map
import { Database } from "@db/sqlite";
import * as path from "node:path";
import { promises as fs } from "node:fs";

type Row = Record<string, unknown>;

interface Logger {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
  error(...a: unknown[]): void;
}

export default class DatabaseManager {
  logger: Logger;
  db: InstanceType<typeof Database> | null;
  dbPath: string;

  constructor(logger: Logger) {
    this.logger = logger;
    this.db = null;
    this.dbPath = Deno.env.get("DB_PATH") ?? "./data/current.db";
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async initialize() {
    await this.ensureDataDirectory();
    this.connectToDatabase();
    this.enableWALMode();
    this.createMappingsTable();
    this.createIndexes();
    this.addBackendColumnIfMissing();
    this.addAllowedIpsColumnIfMissing();
  }

  async ensureDataDirectory() {
    const dataDir = path.dirname(this.dbPath);
    try {
      await fs.access(dataDir);
    } catch {
      await fs.mkdir(dataDir, { recursive: true });
      this.logger.info(`Created data directory: ${dataDir}`);
    }
  }

  connectToDatabase() {
    this.db = new Database(this.dbPath, { create: true });
    this.logger.info(`Connected to SQLite database: ${this.dbPath}`);
  }

  enableWALMode() {
    this.db!.exec("PRAGMA journal_mode=WAL;");
    this.logger.info("WAL mode enabled");
  }

  createMappingsTable() {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS mappings (
        id TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        front_uri TEXT NOT NULL,
        back_port TEXT NOT NULL,
        back_uri TEXT NOT NULL,
        backend TEXT DEFAULT NULL,
        allowed_ips TEXT DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.logger.info("Mappings table ready");
  }

  createIndexes() {
    this.db!.exec("CREATE INDEX IF NOT EXISTS idx_mappings_domain ON mappings(domain)");
    this.db!.exec("CREATE INDEX IF NOT EXISTS idx_mappings_front_uri ON mappings(front_uri)");
    this.db!.exec("CREATE INDEX IF NOT EXISTS idx_mappings_domain_front_uri ON mappings(domain, front_uri)");
  }

  addBackendColumnIfMissing() {
    // PRAGMA table_info returns rows; check if backend column exists
    const cols = this.db!
      .prepare("PRAGMA table_info(mappings)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "backend")) {
      this.db!.exec("ALTER TABLE mappings ADD COLUMN backend TEXT DEFAULT NULL");
      this.logger.info("Added backend column to mappings table");
    }
  }

  addAllowedIpsColumnIfMissing() {
    const cols = this.db!
      .prepare("PRAGMA table_info(mappings)")
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "allowed_ips")) {
      this.db!.exec("ALTER TABLE mappings ADD COLUMN allowed_ips TEXT DEFAULT NULL");
      this.logger.info("Added allowed_ips column to mappings table");
    }
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  async getMapping(domain: string, requestUrl: string): Promise<Row | null> {
    const sql = `
      SELECT * FROM mappings
      WHERE domain = ? AND (? LIKE '/' || front_uri || '%' OR front_uri = '')
      ORDER BY LENGTH(front_uri) DESC
      LIMIT 1
    `;

    const row = this.db!.prepare(sql).get(domain, requestUrl) as Row | undefined;
    if (row) return row;

    // Try wildcard domain (*.example.com)
    const parts = domain.split(".");
    if (parts.length > 1) {
      parts.shift();
      const wildcardDomain = `*.${parts.join(".")}`;
      const wildcardRow = this.db!.prepare(sql).get(wildcardDomain, requestUrl) as Row | undefined;
      return wildcardRow ?? null;
    }

    return null;
  }

  async getAllMappings(): Promise<Row[]> {
    return this.db!
      .prepare("SELECT * FROM mappings ORDER BY domain, front_uri")
      .all() as Row[];
  }

  async addMapping(
    domain: string,
    frontUri: string,
    backPort: string | number,
    backUri: string,
    backend: string | null = null,
    allowedIps: string | null = null,
  ): Promise<Row> {
    const id = crypto.randomUUID();
    this.db!.prepare(
      `INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend, allowed_ips)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, domain, frontUri, String(backPort), backUri, backend, allowedIps);

    return {
      id,
      domain,
      front_uri: frontUri,
      back_port: String(backPort),
      back_uri: backUri,
      backend,
      allowed_ips: allowedIps,
    };
  }

  // ── Hot database replacement (same semantics as Node.js version) ───────────

  async hotReplaceDatabase(newDbPath: string) {
    this.logger.info(`Starting hot database replacement from: ${newDbPath}`);
    try {
      await fs.access(newDbPath);

      // Validate new database
      const tempDb = new Database(newDbPath, { readonly: true });
      const row = tempDb
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='mappings'`)
        .get() as { name: string } | undefined;
      tempDb.close();
      if (!row) throw new Error("New database does not contain mappings table");

      await this.close();
      await fs.copyFile(newDbPath, this.dbPath);
      this.connectToDatabase();
      this.enableWALMode();
      this.logger.info("Database hot replacement completed successfully");
    } catch (error) {
      this.logger.error("Database hot replacement failed:", error);
      try {
        this.connectToDatabase();
        this.enableWALMode();
      } catch (reconnectError) {
        this.logger.error("Failed to reconnect to original database:", reconnectError);
      }
      throw error;
    }
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.logger.info("Database connection closed");
    }
  }
}
