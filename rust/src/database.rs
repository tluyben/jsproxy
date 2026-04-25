//! Database manager for SQLite operations
//! Handles the mappings table with domain routing configurations

use anyhow::Result;
use parking_lot::Mutex;
use rusqlite::{Connection, params, OptionalExtension};
use std::path::Path;
use std::sync::Arc;
use uuid::Uuid;

/// Represents a domain mapping configuration
#[derive(Debug, Clone)]
pub struct Mapping {
    pub id: String,
    pub domain: String,
    pub front_uri: String,
    pub back_port: u16,
    pub back_uri: String,
    pub backend: Option<String>,
    /// HA: comma-separated list of backend ports (e.g. "3000,3001,3002").
    /// When set, overrides `back_port` and enables round-robin load balancing.
    pub back_ports: Option<String>,
    pub allowed_ips: Option<String>,
    pub auth_type: Option<String>,
    pub auth_credentials: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Thread-safe database manager for SQLite operations
pub struct DatabaseManager {
    conn: Arc<Mutex<Connection>>,
    db_path: String,
}

unsafe impl Send for DatabaseManager {}
unsafe impl Sync for DatabaseManager {}

impl DatabaseManager {
    /// Create a new database manager
    pub fn new<P: AsRef<Path>>(db_path: P) -> Result<Self> {
        let db_path_str = db_path.as_ref().to_string_lossy().to_string();

        if let Some(parent) = db_path.as_ref().parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(&db_path)?;
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;

        let manager = Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: db_path_str,
        };

        manager.initialize()?;
        Ok(manager)
    }

    fn initialize(&self) -> Result<()> {
        let conn = self.conn.lock();

        conn.execute(
            "CREATE TABLE IF NOT EXISTS mappings (
                id TEXT PRIMARY KEY,
                domain TEXT NOT NULL,
                front_uri TEXT NOT NULL,
                back_port INTEGER NOT NULL,
                back_uri TEXT NOT NULL,
                backend TEXT DEFAULT NULL,
                back_ports TEXT DEFAULT NULL,
                allowed_ips TEXT DEFAULT NULL,
                auth_type TEXT DEFAULT NULL,
                auth_credentials TEXT DEFAULT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )",
            [],
        )?;

        // Migrations: add columns that may be missing in older DBs
        let migrations = [
            ("back_ports",       "ALTER TABLE mappings ADD COLUMN back_ports TEXT DEFAULT NULL"),
            ("allowed_ips",      "ALTER TABLE mappings ADD COLUMN allowed_ips TEXT DEFAULT NULL"),
            ("auth_type",        "ALTER TABLE mappings ADD COLUMN auth_type TEXT DEFAULT NULL"),
            ("auth_credentials", "ALTER TABLE mappings ADD COLUMN auth_credentials TEXT DEFAULT NULL"),
        ];

        for (col, sql) in &migrations {
            let exists: bool = conn
                .query_row(
                    "SELECT COUNT(*) FROM pragma_table_info('mappings') WHERE name=?1",
                    params![col],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0) > 0;
            if !exists {
                conn.execute(sql, [])?;
            }
        }

        conn.execute("CREATE INDEX IF NOT EXISTS idx_mappings_domain ON mappings(domain)", [])?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mappings_front_uri ON mappings(front_uri)", [])?;
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mappings_domain_front_uri ON mappings(domain, front_uri)", [])?;

        Ok(())
    }

    pub fn db_path(&self) -> &str {
        &self.db_path
    }

    /// Find a mapping for a given domain and path.
    /// Priority: exact domain → wildcard *.parent.com → global catch-all '*'
    pub fn find_mapping(&self, domain: &str, path: &str) -> Result<Option<Mapping>> {
        let conn = self.conn.lock();

        let sql = "SELECT id, domain, front_uri, back_port, back_uri, backend, back_ports,
                          allowed_ips, auth_type, auth_credentials, created_at, updated_at
                   FROM mappings
                   WHERE domain = ?1
                     AND (?2 LIKE '/' || front_uri || '%' OR front_uri = '')
                   ORDER BY LENGTH(front_uri) DESC
                   LIMIT 1";

        let row_to_mapping = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Mapping> {
            Ok(Mapping {
                id: row.get(0)?,
                domain: row.get(1)?,
                front_uri: row.get(2)?,
                back_port: row.get(3)?,
                back_uri: row.get(4)?,
                backend: row.get(5)?,
                back_ports: row.get(6)?,
                allowed_ips: row.get(7)?,
                auth_type: row.get(8)?,
                auth_credentials: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            })
        };

        // 1. Exact domain match
        let mapping = conn.prepare(sql)?.query_row(params![domain, path], row_to_mapping).optional()?;
        if mapping.is_some() {
            return Ok(mapping);
        }

        // 2. Wildcard domain match (*.parent.com)
        if let Some(parent) = domain.splitn(2, '.').nth(1) {
            let wildcard = format!("*.{}", parent);
            let mapping = conn.prepare(sql)?.query_row(params![wildcard, path], row_to_mapping).optional()?;
            if mapping.is_some() {
                return Ok(mapping);
            }
        }

        // 3. Global catch-all '*'
        let mapping = conn.prepare(sql)?.query_row(params!["*", path], row_to_mapping).optional()?;
        Ok(mapping)
    }

    /// Record a single use of a credential (for max_uses tracking).
    /// Fire-and-forget: errors are silently ignored.
    pub fn record_auth_use(&self, mapping_id: &str, credential_index: usize) {
        let conn = self.conn.lock();

        let row: Option<String> = conn
            .query_row(
                "SELECT auth_credentials FROM mappings WHERE id = ?1",
                params![mapping_id],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None)
            .flatten();

        let json_str = match row {
            Some(s) => s,
            None => return,
        };

        let mut creds: Vec<serde_json::Value> = match serde_json::from_str(&json_str) {
            Ok(v) => v,
            Err(_) => return,
        };

        if credential_index >= creds.len() {
            return;
        }

        let max_uses = creds[credential_index]
            .get("max_uses")
            .and_then(|v| v.as_u64());

        if max_uses.is_none() {
            return; // no use-limit on this credential
        }

        let uses = creds[credential_index]
            .get("uses")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        let new_uses = uses + 1;
        if new_uses >= max_uses.unwrap() {
            creds.remove(credential_index);
        } else {
            creds[credential_index]["uses"] = serde_json::json!(new_uses);
        }

        let new_json = if creds.is_empty() {
            None
        } else {
            serde_json::to_string(&creds).ok()
        };

        let _ = conn.execute(
            "UPDATE mappings SET auth_credentials = ?1, updated_at = CURRENT_TIMESTAMP WHERE id = ?2",
            params![new_json, mapping_id],
        );
    }

    pub fn domain_exists(&self, domain: &str) -> Result<bool> {
        let conn = self.conn.lock();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM mappings WHERE domain = ?1",
            params![domain],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    pub fn add_mapping(
        &self,
        domain: &str,
        front_uri: &str,
        back_port: u16,
        back_uri: &str,
        backend: Option<&str>,
        back_ports: Option<&str>,
        allowed_ips: Option<&str>,
        auth_type: Option<&str>,
        auth_credentials: Option<&str>,
    ) -> Result<Mapping> {
        let conn = self.conn.lock();
        let id = Uuid::new_v4().to_string();
        let front_uri = front_uri.trim_start_matches('/').trim_end_matches('/');
        let back_uri = back_uri.trim_start_matches('/').trim_end_matches('/');

        conn.execute(
            "INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend, back_ports,
                                   allowed_ips, auth_type, auth_credentials)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![id, domain, front_uri, back_port as i32, back_uri, backend, back_ports,
                    allowed_ips, auth_type, auth_credentials],
        )?;

        Ok(Mapping {
            id,
            domain: domain.to_string(),
            front_uri: front_uri.to_string(),
            back_port,
            back_uri: back_uri.to_string(),
            backend: backend.map(|s| s.to_string()),
            back_ports: back_ports.map(|s| s.to_string()),
            allowed_ips: allowed_ips.map(|s| s.to_string()),
            auth_type: auth_type.map(|s| s.to_string()),
            auth_credentials: auth_credentials.map(|s| s.to_string()),
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    pub fn update_mapping(
        &self,
        id: &str,
        front_uri: Option<&str>,
        back_uri: Option<&str>,
        back_port: Option<u16>,
        backend: Option<&str>,
    ) -> Result<bool> {
        let conn = self.conn.lock();
        let mut updates: Vec<String> = vec![];
        let mut values: Vec<String> = vec![];
        let mut idx = 1usize;

        if let Some(uri) = front_uri {
            updates.push(format!("front_uri = ?{}", idx));
            values.push(uri.trim_start_matches('/').trim_end_matches('/').to_string());
            idx += 1;
        }
        if let Some(uri) = back_uri {
            updates.push(format!("back_uri = ?{}", idx));
            values.push(uri.trim_start_matches('/').trim_end_matches('/').to_string());
            idx += 1;
        }
        if let Some(port) = back_port {
            updates.push(format!("back_port = ?{}", idx));
            values.push(port.to_string());
            idx += 1;
        }
        if let Some(srv) = backend {
            updates.push(format!("backend = ?{}", idx));
            values.push(srv.to_string());
            idx += 1;
        }

        if updates.is_empty() {
            return Ok(false);
        }

        updates.push("updated_at = CURRENT_TIMESTAMP".to_string());
        let sql = format!("UPDATE mappings SET {} WHERE id = ?{}", updates.join(", "), idx);
        values.push(id.to_string());

        let params: Vec<&dyn rusqlite::ToSql> = values.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
        let affected = conn.execute(&sql, params.as_slice())?;
        Ok(affected > 0)
    }

    pub fn delete_mapping(&self, domain: &str, front_uri: Option<&str>) -> Result<usize> {
        let conn = self.conn.lock();
        let affected = if let Some(uri) = front_uri {
            let uri = uri.trim_start_matches('/').trim_end_matches('/');
            conn.execute("DELETE FROM mappings WHERE domain = ?1 AND front_uri = ?2", params![domain, uri])?
        } else {
            conn.execute("DELETE FROM mappings WHERE domain = ?1", params![domain])?
        };
        Ok(affected)
    }

    pub fn list_mappings(&self, domain: Option<&str>) -> Result<Vec<Mapping>> {
        let conn = self.conn.lock();
        let sql = if domain.is_some() {
            "SELECT id, domain, front_uri, back_port, back_uri, backend, back_ports,
                    allowed_ips, auth_type, auth_credentials, created_at, updated_at
             FROM mappings WHERE domain = ?1 ORDER BY domain, front_uri"
        } else {
            "SELECT id, domain, front_uri, back_port, back_uri, backend, back_ports,
                    allowed_ips, auth_type, auth_credentials, created_at, updated_at
             FROM mappings ORDER BY domain, front_uri"
        };

        let mut stmt = conn.prepare(sql)?;
        let mut rows = if let Some(d) = domain {
            stmt.query(params![d])?
        } else {
            stmt.query([])?
        };

        let mut mappings = Vec::new();
        while let Some(row) = rows.next()? {
            mappings.push(Mapping {
                id: row.get(0)?,
                domain: row.get(1)?,
                front_uri: row.get(2)?,
                back_port: row.get(3)?,
                back_uri: row.get(4)?,
                backend: row.get(5)?,
                back_ports: row.get(6)?,
                allowed_ips: row.get(7)?,
                auth_type: row.get(8)?,
                auth_credentials: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            });
        }
        Ok(mappings)
    }

    pub fn get_mapping_by_id(&self, id: &str) -> Result<Option<Mapping>> {
        let conn = self.conn.lock();
        let mapping = conn.query_row(
            "SELECT id, domain, front_uri, back_port, back_uri, backend, back_ports,
                    allowed_ips, auth_type, auth_credentials, created_at, updated_at
             FROM mappings WHERE id = ?1",
            params![id],
            |row| Ok(Mapping {
                id: row.get(0)?,
                domain: row.get(1)?,
                front_uri: row.get(2)?,
                back_port: row.get(3)?,
                back_uri: row.get(4)?,
                backend: row.get(5)?,
                back_ports: row.get(6)?,
                allowed_ips: row.get(7)?,
                auth_type: row.get(8)?,
                auth_credentials: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            }),
        ).optional()?;
        Ok(mapping)
    }

    pub fn find_by_domain_and_uri(&self, domain: &str, front_uri: &str) -> Result<Option<Mapping>> {
        let conn = self.conn.lock();
        let front_uri = front_uri.trim_start_matches('/').trim_end_matches('/');
        let mapping = conn.query_row(
            "SELECT id, domain, front_uri, back_port, back_uri, backend, back_ports,
                    allowed_ips, auth_type, auth_credentials, created_at, updated_at
             FROM mappings WHERE domain = ?1 AND front_uri = ?2",
            params![domain, front_uri],
            |row| Ok(Mapping {
                id: row.get(0)?,
                domain: row.get(1)?,
                front_uri: row.get(2)?,
                back_port: row.get(3)?,
                back_uri: row.get(4)?,
                backend: row.get(5)?,
                back_ports: row.get(6)?,
                allowed_ips: row.get(7)?,
                auth_type: row.get(8)?,
                auth_credentials: row.get(9)?,
                created_at: row.get(10)?,
                updated_at: row.get(11)?,
            }),
        ).optional()?;
        Ok(mapping)
    }
}

impl Clone for DatabaseManager {
    fn clone(&self) -> Self {
        let conn = Connection::open(&self.db_path).expect("Failed to open database");
        conn.execute_batch("PRAGMA journal_mode=WAL;").expect("Failed to set WAL mode");
        Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: self.db_path.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn new_db(dir: &tempfile::TempDir) -> DatabaseManager {
        DatabaseManager::new(dir.path().join("test.db")).unwrap()
    }

    fn add(db: &DatabaseManager, domain: &str, front_uri: &str, back_port: u16, back_uri: &str) -> Mapping {
        db.add_mapping(domain, front_uri, back_port, back_uri, None, None, None, None, None).unwrap()
    }

    #[test]
    fn test_create_database() {
        let dir = tempdir().unwrap();
        let db_path = dir.path().join("test.db");
        let _db = DatabaseManager::new(&db_path).unwrap();
        assert!(db_path.exists());
    }

    #[test]
    fn test_add_and_find_mapping() {
        let dir = tempdir().unwrap();
        let db = new_db(&dir);
        add(&db, "example.com", "api/v1", 3000, "v1");
        let m = db.find_mapping("example.com", "/api/v1/users").unwrap().unwrap();
        assert_eq!(m.domain, "example.com");
        assert_eq!(m.front_uri, "api/v1");
        assert_eq!(m.back_port, 3000);
    }

    #[test]
    fn test_longest_match_first() {
        let dir = tempdir().unwrap();
        let db = new_db(&dir);
        add(&db, "example.com", "api", 3000, "");
        add(&db, "example.com", "api/v1", 3001, "v1");

        let m = db.find_mapping("example.com", "/api/v1/users").unwrap().unwrap();
        assert_eq!(m.back_port, 3001);

        let m = db.find_mapping("example.com", "/api/v2/users").unwrap().unwrap();
        assert_eq!(m.back_port, 3000);
    }

    #[test]
    fn test_wildcard_domain() {
        let dir = tempdir().unwrap();
        let db = new_db(&dir);
        add(&db, "*.example.com", "", 4000, "");

        let m = db.find_mapping("sub.example.com", "/test").unwrap().unwrap();
        assert_eq!(m.back_port, 4000);

        // Exact domain should not match wildcard
        assert!(db.find_mapping("example.com", "/test").unwrap().is_none());
    }

    #[test]
    fn test_catchall_domain() {
        let dir = tempdir().unwrap();
        let db = new_db(&dir);
        add(&db, "*", "", 5000, "");

        // Should match any domain
        let m = db.find_mapping("anything.example.com", "/path").unwrap().unwrap();
        assert_eq!(m.back_port, 5000);

        let m = db.find_mapping("other.net", "/path").unwrap().unwrap();
        assert_eq!(m.back_port, 5000);
    }

    #[test]
    fn test_catchall_lower_priority_than_exact() {
        let dir = tempdir().unwrap();
        let db = new_db(&dir);
        add(&db, "specific.com", "", 3000, "");
        add(&db, "*", "", 5000, "");

        let m = db.find_mapping("specific.com", "/path").unwrap().unwrap();
        assert_eq!(m.back_port, 3000);

        let m = db.find_mapping("other.com", "/path").unwrap().unwrap();
        assert_eq!(m.back_port, 5000);
    }

    #[test]
    fn test_auth_fields_stored() {
        let dir = tempdir().unwrap();
        let db = new_db(&dir);
        let creds = r#"[{"token":"abc123"}]"#;
        db.add_mapping("secure.com", "", 3000, "", None, None, None, Some("bearer"), Some(creds)).unwrap();

        let m = db.find_mapping("secure.com", "/").unwrap().unwrap();
        assert_eq!(m.auth_type.as_deref(), Some("bearer"));
        assert_eq!(m.auth_credentials.as_deref(), Some(creds));
    }

    #[test]
    fn test_allowed_ips_stored() {
        let dir = tempdir().unwrap();
        let db = new_db(&dir);
        db.add_mapping("gated.com", "", 3000, "", None, None, Some("10.0.0.1,192.168.0.0/24"), None, None).unwrap();

        let m = db.find_mapping("gated.com", "/").unwrap().unwrap();
        assert_eq!(m.allowed_ips.as_deref(), Some("10.0.0.1,192.168.0.0/24"));
    }

    #[test]
    fn test_record_auth_use_max_uses() {
        let dir = tempdir().unwrap();
        let db = new_db(&dir);
        let creds = r#"[{"pass":"secret","max_uses":1,"uses":0}]"#;
        let m = db.add_mapping("once.com", "", 3000, "", None, None, None, Some("password"), Some(creds)).unwrap();

        db.record_auth_use(&m.id, 0);

        // Credential should be removed after max_uses reached
        let updated = db.get_mapping_by_id(&m.id).unwrap().unwrap();
        assert!(updated.auth_credentials.is_none());
    }
}
